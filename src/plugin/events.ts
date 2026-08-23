import * as fs from 'node:fs';

import { QualflareHttpClient } from '../http/client.js';
import { MAX_ATTACHMENTS_PER_CASE } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import { msToNs } from '../shared/duration.js';
import type { Case, CaseStatus, Suite } from '../shared/types.js';
import { buildCollectPayload, type BrowserInfo } from './collect-builder.js';
import type { ResolvedPluginConfig } from './resolve-config.js';
import { LaunchAccumulator, PendingAttachmentQueue, TestPhaseGate } from './state.js';
import type { CaseBuffer } from './tasks.js';
import { buildHttpOptions, uploadVideo } from './video-uploader.js';

/** Case statuses a video recording is worth attaching to — mirrors the
 * "this test needs investigating" set, not just literally 'failed'. */
const FAILURE_STATUSES: ReadonlySet<CaseStatus> = new Set(['failed', 'error', 'timeout']);

/**
 * Registers `before:run` / `before:spec` / `after:spec` / `after:run` /
 * `after:screenshot` on the given Cypress plugin events, wiring the
 * spec-by-spec case buffer into one accumulated `Launch` and POSTing it
 * exactly once at `after:run`.
 */
export function registerEvents(
  on: Cypress.PluginEvents,
  config: ResolvedPluginConfig,
  buffer: CaseBuffer,
  pendingAttachments: PendingAttachmentQueue,
  testPhaseGate: TestPhaseGate,
): void {
  const accumulator = new LaunchAccumulator();
  let browserInfo: BrowserInfo | undefined;
  let currentSpecStart = 0;

  // Built once and reused by both after:spec (video upload, if any) and
  // after:run (the final /collect POST) — hoisted out of after:run, which
  // used to be the only consumer, so a spec's video can be uploaded as soon
  // as that spec finishes rather than deferred to the very end of the run.
  const httpOptions = buildHttpOptions(config);

  on('before:run', (details) => {
    browserInfo = {
      browserName: details.browser?.displayName,
      browserVersion: details.browser?.version,
      osName: details.system?.osName,
      osVersion: details.system?.osVersion,
    };
  });

  // Node-side event — fires for BOTH manual cy.screenshot() calls and
  // Cypress's own automatic on-failure screenshot (screenshotOnRunFailure,
  // on by default in `cypress run`), distinguished only by `details.testFailure`.
  // No cy.task()/browser-side involvement needed: this event already runs
  // in the Node process with the file already written to disk. Queued here
  // and drained by `tasks.ts`'s TASK_REPORT_CASE handler, which attaches
  // whatever's pending to the Case currently being reported.
  //
  // EXCEPT when it fires before the first test has even started (see
  // TestPhaseGate in state.ts) — a screenshot taken in a root `before()`
  // hook. That can never be correctly attributed to any specific test (the
  // first test hasn't begun yet), so it's treated as orphaned immediately,
  // the same way a screenshot taken in an `after()` hook already is (below,
  // in `after:spec`) — rather than silently getting swept into whichever
  // test's TASK_REPORT_CASE happens to arrive first.
  on('after:screenshot', (details) => {
    if (!testPhaseGate.hasStarted()) {
      logger.warn(
        `a screenshot ("${details.name || 'unnamed'}") was captured before any test in this spec had ` +
          'started (likely in a root `before()` hook) and cannot be attributed to a specific test — it was not uploaded.',
      );
      return;
    }
    pendingAttachments.enqueue({
      name: details.name || (details.testFailure ? 'failure-screenshot' : 'screenshot'),
      path: details.path,
      mimeType: 'image/png',
    });
  });

  on('before:spec', () => {
    currentSpecStart = Date.now();
    testPhaseGate.reset();
    // Ensure no stale cases from a prior spec leak into this one, in case
    // something upstream ever calls before:spec without a matching
    // after:spec having fired first.
    buffer.drain();
  });

  on('after:spec', async (spec, results) => {
    const cases = buffer.drain();

    // Cypress records one video per SPEC, not per test, so there is no
    // exact owning Case — attaching it to the first failing case in the
    // spec is the most useful available attribution (that's the recording a
    // QA engineer actually wants to watch) and, being a single Case row,
    // avoids double-counting the same R2 object's bytes toward workspace
    // storage quota the way attaching it to every failing case would.
    // Skipped entirely for an all-passing spec: a video with nothing to
    // investigate has little diagnostic value and isn't worth the upload.
    if (results.video && config.uploadVideos) {
      const failedCase = cases.find((c) => FAILURE_STATUSES.has(c.status));
      if (failedCase) {
        const uploaded = await uploadVideo(results.video, config.maxVideoBytes, httpOptions);
        if (uploaded) {
          attachVideo(failedCase, uploaded);
        }
      } else {
        logger.info(
          `spec ${spec.relative} recorded a video but no test failed — not uploaded ` +
            '(only failure recordings are uploaded; set `uploadVideos: false` to silence this).',
        );
      }
    } else if (results.video) {
      logger.info(`spec ${spec.relative} recorded a video at ${results.video} — not uploaded (uploadVideos is disabled).`);
    }

    const suite: Suite = {
      name: spec.relative,
      category: 'cypress',
      duration: msToNs(results.stats.duration ?? Date.now() - currentSpecStart),
      timestamp: new Date(results.stats.startedAt ?? Date.now()).toISOString(),
      cases,
    };

    if (cases.length !== results.stats.tests) {
      logger.warn(
        `spec ${spec.relative}: captured ${cases.length} case(s) but Cypress reported ` +
          `${results.stats.tests} test(s) — some results may be missing from the uploaded report.`,
      );
    }

    accumulator.addSuite(suite);

    // Any attachment still sitting in the queue at this point was never
    // claimed by a Case's TASK_REPORT_CASE (e.g. a screenshot taken in an
    // `after`-hook, after the last test's report already went out) — drop
    // it with a warning rather than silently attributing it to a case in
    // the NEXT spec file.
    const orphaned = pendingAttachments.drain();
    if (orphaned.length > 0) {
      logger.warn(
        `spec ${spec.relative}: ${orphaned.length} screenshot(s) could not be attributed to a ` +
          'specific test (likely taken outside a test body, e.g. in an `after` hook) and were not uploaded.',
      );
    }
  });

  on('after:run', async () => {
    const suites = accumulator.getSuites();
    if (suites.length === 0) {
      logger.info(`no test results were captured this run — skipping ${config.outputFile ? 'file write' : 'upload'}.`);
      return;
    }

    const collect = buildCollectPayload(accumulator, config, browserInfo);

    // Sharded CI: write this process's own Collect JSON to disk instead of
    // POSTing it. A separate aggregation step (after all shards' files are
    // collected, e.g. via CI artifact download) merges them into one launch
    // via `qualflare-cli upload --shard <files...>` — see docs/LIMITATIONS.md.
    // No HTTP client is ever constructed in this mode; resolveConfig already
    // skipped the token-required check for the same reason.
    if (config.outputFile) {
      fs.writeFileSync(config.outputFile, JSON.stringify(collect));
      logger.info(
        `wrote Collect payload to ${config.outputFile} — not uploaded (outputFile mode). ` +
          'Merge shard files and upload once via `qualflare-cli upload --shard <files...>`.',
      );
      return;
    }

    const client = new QualflareHttpClient(httpOptions);

    try {
      const result = await client.send(collect);
      logger.info(`uploaded launch #${result.seq} to Qualflare.`);
    } catch (err) {
      logger.error(`failed to upload results to Qualflare: ${(err as Error).message}`);
      if (config.failOnUploadError) {
        throw err;
      }
    }
  });
}

/** Appends a video's `Attachment` entry to a Case, respecting the server's
 * per-case attachment cap — a spec-level video competing with the case's
 * own screenshots for that budget is an edge case (one video vs. up to 50
 * screenshots), but silently exceeding the cap would 400 the whole launch. */
function attachVideo(testCase: Case, uploaded: { storageKey: string; fileSize: number; mimeType: string }): void {
  const attachments = testCase.attachments ?? [];
  if (attachments.length >= MAX_ATTACHMENTS_PER_CASE) {
    logger.warn(
      `not attaching video to "${testCase.name}": already at the server's ${MAX_ATTACHMENTS_PER_CASE}-attachment-per-case cap.`,
    );
    return;
  }
  testCase.attachments = [
    ...attachments,
    {
      name: 'video',
      mimeType: uploaded.mimeType,
      storageKey: uploaded.storageKey,
      fileSize: uploaded.fileSize,
    },
  ];
}
