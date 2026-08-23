import { MAX_SUITES_PER_LAUNCH } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { Attachment, Suite } from '../shared/types.js';

/**
 * Accumulates `Suite[]` across every spec file in the current `cypress run`
 * process. Process-lifetime, single instance — matches the plan's
 * "one `cypress run` process = one Launch" decision: there is no
 * cross-process aggregation in v1 (see docs/LIMITATIONS.md).
 */
export class LaunchAccumulator {
  private readonly suites: Suite[] = [];
  private truncated = false;

  addSuite(suite: Suite): void {
    if (this.suites.length >= MAX_SUITES_PER_LAUNCH) {
      if (!this.truncated) {
        this.truncated = true;
        logger.warn(
          `reached the server's ${MAX_SUITES_PER_LAUNCH}-suite-per-launch cap — further spec files' ` +
            'results will not be uploaded this run.',
        );
      }
      return;
    }
    this.suites.push(suite);
  }

  getSuites(): Suite[] {
    return this.suites;
  }
}

/**
 * Tracks whether the first test of the current spec has started (i.e. every
 * applicable `before()` hook for it has already run) — set via a one-shot
 * `cy.task(TASK_MARK_TEST_PHASE_STARTED, ...)` call from a root-level
 * `beforeEach` the browser side registers (`src/browser/index.ts`), reset at
 * `before:spec`.
 *
 * Exists to fix a real misattribution bug: a screenshot taken in a root
 * `before()` hook fires `after:screenshot` before ANY test has started, and
 * without this signal `events.ts` cannot tell that apart from a screenshot
 * taken during the first real test's own execution — both would otherwise
 * sit in `PendingAttachmentQueue` and get drained together into whichever
 * test's `TASK_REPORT_CASE` happens to arrive first. `before()`-hook
 * screenshots should instead be treated as orphaned, exactly like an
 * `after()`-hook screenshot already correctly is (see `events.ts`'s
 * `after:spec` handler).
 *
 * A `beforeEach` (not a raw `runner.on('test', ...)` Mocha listener) is
 * deliberately the signal source: it's a real Cypress command executed as
 * part of that test's own command-queue processing, the same
 * queue-integrated mechanism `queue.ts`'s already-proven-safe `flushCase`
 * (called from a real `afterEach`) uses — unlike calling `cy.task()`
 * directly from a raw Mocha runner event listener, which Tier 1 of this same
 * remediation effort found (by actually running a real `cypress run`) can
 * hang the whole process for a test whose body never executes.
 */
export class TestPhaseGate {
  private started = false;

  markStarted(): void {
    this.started = true;
  }

  hasStarted(): boolean {
    return this.started;
  }

  /** Called at `before:spec`, so each spec file gets its own fresh
   * before()-hook-vs-real-test boundary. */
  reset(): void {
    this.started = false;
  }
}

/**
 * Buffers screenshot references captured via the Node-side `after:screenshot`
 * plugin event (see `events.ts`) between one finished test's report and the
 * next. `after:screenshot` fires in real time as Cypress captures each
 * screenshot (both manual `cy.screenshot()` calls and its own automatic
 * on-failure capture funnel through this single event) — since a
 * screenshot taken during a test's execution always fires before that
 * test's `TASK_REPORT_CASE` arrives (the test's own command queue, and
 * therefore any screenshot capture within it, completes before its
 * `afterEach` runs), draining this queue at the moment a Case is received
 * correctly attributes any screenshots taken during that test's run to it.
 *
 * This whole flow is Node-side only — no `cy.task()` round-trip or
 * browser-side wiring is needed for screenshots, unlike Case data itself.
 */
export class PendingAttachmentQueue {
  private pending: Attachment[] = [];

  enqueue(attachment: Attachment): void {
    this.pending.push(attachment);
  }

  /** Returns the buffered attachments and clears the queue. */
  drain(): Attachment[] {
    const drained = this.pending;
    this.pending = [];
    return drained;
  }
}
