import { MAX_CASES_PER_SUITE, TASK_MARK_TEST_PHASE_STARTED, TASK_REPORT_CASE } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { Case } from '../shared/types.js';
import { resolveAttachments, type AttachmentBudget, type AttachmentReaderConfig } from './attachment-reader.js';
import type { PendingAttachmentQueue, TestPhaseGate } from './state.js';

/**
 * Buffers finished `Case` objects the browser side hands over via
 * `cy.task(TASK_REPORT_CASE, ...)`, one spec file's worth at a time.
 * `events.ts`'s `after:spec` handler drains this into a `Suite` and clears
 * it before the next spec starts.
 *
 * `Suite.cases` is REJECT-not-truncate server-side (`max=5000`) — exceeding
 * it 400s the whole launch, not just this one spec's results. Warn-and-drop
 * further cases past that point, mirroring `state.ts`'s `LaunchAccumulator`
 * (2000-suite cap) exactly.
 */
export class CaseBuffer {
  private cases: Case[] = [];
  private truncated = false;

  add(testCase: Case): void {
    if (this.cases.length >= MAX_CASES_PER_SUITE) {
      if (!this.truncated) {
        this.truncated = true;
        logger.warn(
          `reached the server's ${MAX_CASES_PER_SUITE}-case-per-suite cap — further test results in this ` +
            'spec file will not be uploaded.',
        );
      }
      return;
    }
    this.cases.push(testCase);
  }

  /** Returns the buffered cases and clears the buffer (including the
   * truncation-warned flag, so a later spec that also hits the cap warns
   * again rather than staying silent for the rest of the run). */
  drain(): Case[] {
    const drained = this.cases;
    this.cases = [];
    this.truncated = false;
    return drained;
  }
}

/**
 * Registers the `on('task', {...})` handlers the browser-side support
 * script calls via `cy.task()`. Cypress requires every task handler to
 * return a non-`undefined` value (a Promise resolving to `null` is fine)
 * or it throws.
 *
 * The TASK_REPORT_CASE handler also drains `pendingAttachments` (populated
 * Node-side by `events.ts`'s `after:screenshot` listener — see its comment
 * for why screenshot capture needs no browser-side/`cy.task()` involvement
 * at all) and resolves each into inline base64 content (or drops it) before
 * buffering the case — this is the one place both "a finished test" and
 * "screenshots taken during that test" are known at the same time.
 *
 * `Attachment.stepIndex` (correlating a screenshot to the specific step
 * executing when it was taken) is deliberately left unset here. Screenshots
 * are captured entirely Node-side via `after:screenshot`, while steps are
 * built entirely browser-side (`command-log-listener.ts`) and only reach
 * Node bundled inside the already-finished `Case` — by the time
 * `after:screenshot` fires, Node has no visibility into which step index
 * the browser's still-in-progress step buffer is currently on, and no cheap
 * way to ask it without adding a new `cy.task()` round-trip purely to answer
 * "what step are we on," which isn't justified for this milestone. Every
 * screenshot is attached at the case level instead (works today, matches
 * Milestone 2's existing behavior) — worth revisiting only if step-level
 * screenshot attribution becomes a real, requested feature. */
export function registerTasks(
  on: Cypress.PluginEvents,
  buffer: CaseBuffer,
  attachmentConfig: AttachmentReaderConfig,
  attachmentBudget: AttachmentBudget,
  pendingAttachments: PendingAttachmentQueue,
  testPhaseGate: TestPhaseGate,
): void {
  on('task', {
    async [TASK_REPORT_CASE](testCase: Case): Promise<null> {
      // Merge screenshots captured Node-side during this test (via
      // after:screenshot) with any attachments the browser side already
      // set directly on the Case (e.g. a `qualflare.attachmentFromFile()`
      // call, which carries only a `path` — resolveAttachments reads/
      // uploads it here, same as a screenshot).
      const attachments = [...(testCase.attachments ?? []), ...pendingAttachments.drain()];
      const resolved = await resolveAttachments(
        attachments.length > 0 ? attachments : undefined,
        attachmentConfig,
        attachmentBudget,
      );
      buffer.add({ ...testCase, attachments: resolved });
      return null;
    },
    // One-shot signal from the browser side (see TestPhaseGate's doc
    // comment in state.ts) — fired from a root-level beforeEach right
    // before the first test's body runs.
    [TASK_MARK_TEST_PHASE_STARTED](): null {
      testPhaseGate.markStarted();
      return null;
    },
  });
}
