import { TASK_MARK_TEST_PHASE_STARTED } from '../shared/constants.js';

/**
 * Registers a one-shot, root-level `beforeEach` that tells the Node side
 * "the first test of this spec is about to run" — see
 * `src/plugin/state.ts`'s `TestPhaseGate` for the full rationale (letting
 * `events.ts` distinguish a screenshot taken in a root `before()` hook,
 * which cannot be attributed to any test, from one taken during a real
 * test's own execution).
 *
 * Deliberately a real, global `beforeEach()` — NOT a raw
 * `Cypress.mocha.getRunner().on('test', ...)` listener like
 * `mocha-listener.ts` uses for its own bookkeeping. A `beforeEach()`
 * function runs as part of Cypress's normal command-queue processing for
 * that test (the same mechanism `queue.ts`'s already-proven-safe
 * `flushCase`, called from a real `afterEach()`, relies on) — calling
 * `cy.task()` from within it is exactly as safe as calling it from a test
 * body itself. This is a DIFFERENT, safer call site than the raw Mocha
 * runner-event listeners Tier 1 of this remediation effort found (by
 * actually running a real `cypress run`) could hang the whole process.
 *
 * Runs once per spec file (module-eval time registers this one
 * `beforeEach`), and only actually sends the task on the FIRST test's
 * `beforeEach` firing — Mocha runs root-level `beforeEach` hooks
 * outermost-first, so this is guaranteed to run after every applicable
 * `before()` hook (root or nested) has already completed for that test,
 * which is exactly the "before-hook phase is over" signal needed. Every
 * subsequent test's `beforeEach` firing is a no-op (the gate only needs to
 * flip once per spec).
 */
export function registerTestPhaseSignal(): void {
  let signaled = false;
  beforeEach(function qualflareMarkTestPhaseStarted() {
    if (signaled) {
      return;
    }
    signaled = true;
    cy.task(TASK_MARK_TEST_PHASE_STARTED, null, { log: false });
  });
}
