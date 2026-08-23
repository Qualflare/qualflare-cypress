import { QualflareHttpClient } from '../http/client.js';
import { logger } from '../shared/logger.js';
import { msToNs } from '../shared/duration.js';
import type { Suite } from '../shared/types.js';
import { PACKAGE_VERSION } from './version.js';
import { buildCollectPayload, type BrowserInfo } from './collect-builder.js';
import type { ResolvedPluginConfig } from './resolve-config.js';
import { LaunchAccumulator, PendingAttachmentQueue, TestPhaseGate } from './state.js';
import type { CaseBuffer } from './tasks.js';

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

  on('after:spec', (spec, results) => {
    const cases = buffer.drain();
    const suite: Suite = {
      name: spec.relative,
      category: 'e2e',
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

    if (results.video) {
      logger.info(
        `spec ${spec.relative} recorded a video at ${results.video} — not uploaded ` +
          '(qualflare-cypress does not support video attachments yet).',
      );
    }
  });

  on('after:run', async () => {
    const suites = accumulator.getSuites();
    if (suites.length === 0) {
      logger.info('no test results were captured this run — skipping upload.');
      return;
    }

    const collect = buildCollectPayload(accumulator, config, browserInfo);
    const client = new QualflareHttpClient({
      endpoint: config.apiEndpoint,
      token: config.token,
      timeoutMs: config.timeoutMs,
      retry: config.retry,
      userAgent: `qualflare-cypress/${PACKAGE_VERSION}`,
      debug: config.debug,
    });

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
