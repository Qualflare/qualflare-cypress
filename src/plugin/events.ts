import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { MAX_ATTACHMENTS_PER_CASE } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import { msToNs } from '../shared/duration.js';
import type { Case, CaseStatus, Suite } from '../shared/types.js';
import { buildCollectPayload, type BrowserInfo } from './collect-builder.js';
import type { ResolvedPluginConfig } from './resolve-config.js';
import { LaunchAccumulator, PendingAttachmentQueue, TestPhaseGate } from './state.js';
import type { CaseBuffer } from './tasks.js';
import { copyVideoAttachment } from './video-uploader.js';

/** Case statuses a video recording is worth attaching to — mirrors the
 * "this test needs investigating" set, not just literally 'failed'. */
const FAILURE_STATUSES: ReadonlySet<CaseStatus> = new Set(['failed', 'error', 'timeout']);

/**
 * Registers `before:run` / `before:spec` / `after:spec` / `after:run` /
 * `after:screenshot` on the given Cypress plugin events, wiring the
 * spec-by-spec case buffer into one accumulated `Launch` and writing it as a
 * single Collect JSON file into `config.outputDir` exactly once at
 * `after:run` — this process never uploads anything itself; see
 * `resolve-config.ts`'s `outputDir` doc comment.
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
    if (results.video) {
      const failedCase = cases.find((c) => FAILURE_STATUSES.has(c.status));
      if (failedCase) {
        const copied = copyVideoAttachment(results.video, config.outputDir, config.maxVideoBytes);
        if (copied) {
          attachVideo(failedCase, copied);
        }
      } else {
        logger.info(`spec ${spec.relative} recorded a video but no test failed — not attached.`);
      }
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
      logger.info('no test results were captured this run — skipping file write.');
      return;
    }

    const collect = buildCollectPayload(accumulator, config, browserInfo);
    if (config.shardIndex !== undefined) {
      for (const suite of collect.suites) {
        for (const c of suite.cases) {
          c.shardIndex = config.shardIndex;
        }
      }
    }

    fs.mkdirSync(config.outputDir, { recursive: true });
    const outputPath = path.join(config.outputDir, `${randomUUID()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(collect));
    logger.info(`wrote Collect payload to ${outputPath} — run \`qualflare-cli collect ${config.outputDir}\` to upload it.`);
  });
}

/** Appends a video's `Attachment` entry to a Case, respecting the server's
 * per-case attachment cap — a spec-level video competing with the case's
 * own screenshots for that budget is an edge case (one video vs. up to 50
 * screenshots), but silently exceeding the cap would 400 the whole launch. */
function attachVideo(testCase: Case, copied: { localVideoPath: string; fileSize: number; mimeType: string }): void {
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
      mimeType: copied.mimeType,
      localVideoPath: copied.localVideoPath,
      fileSize: copied.fileSize,
    },
  ];
}
