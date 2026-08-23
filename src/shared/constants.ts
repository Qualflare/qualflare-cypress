/**
 * Shared constants that both the browser-side support script and the
 * Node-side plugin must agree on exactly (task names in particular — a
 * typo on either side silently breaks `cy.task()` at runtime with no
 * compile-time signal, since Cypress tasks are looked up by string).
 */

/** `cy.task()` name the browser side uses to hand a finished test's Case
 * object over to the Node side. */
export const TASK_REPORT_CASE = 'qualflareReportCase';

/** `cy.task()` name a one-shot root-level `beforeEach` (registered by
 * `src/browser/index.ts`) uses to tell the Node side "the first test of this
 * spec has started (all applicable `before()` hooks have already run)" — see
 * `src/plugin/state.ts`'s `TestPhaseGate` for why this exists: it lets
 * `events.ts` distinguish a screenshot taken in a `before()` hook (which
 * should be treated as orphaned, like an `after()`-hook screenshot already
 * is) from one taken during a real test's own execution. */
export const TASK_MARK_TEST_PHASE_STARTED = 'qualflareMarkTestPhaseStarted';

/** HTTP headers used against `/api/v1/collect`. */
export const HEADER_TOKEN = 'QF_TOKEN';
export const HEADER_IDEMPOTENCY_KEY = 'Idempotency-Key';
export const HEADER_CONTENT_TYPE = 'Content-Type';
export const HEADER_ACCEPT = 'Accept';
export const HEADER_USER_AGENT = 'User-Agent';

/** Server-side caps this client should respect defensively (see
 * `api-service/internal/core/domain/launch/launch.go`). */
export const MAX_SUITES_PER_LAUNCH = 2000;
export const MAX_CASES_PER_SUITE = 5000;
export const MAX_STEPS_PER_CASE = 1000;
export const MAX_PARAMETERS_PER_STEP = 50;
export const MAX_ATTACHMENTS_PER_CASE = 50;
export const MAX_LABELS_PER_CASE = 100;
export const MAX_LINKS_PER_CASE = 20;
export const MAX_TAGS_PER_CASE = 64;
export const MAX_TAG_LENGTH = 255;
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;

/** Client-side SOFT cap on steps recorded per test attempt — well under the
 * server's 1000-per-case hard cap (`MAX_STEPS_PER_CASE`). There's no reason
 * to build/serialize thousands of command-log entries for one test; once hit,
 * further entries within that attempt are dropped (with a one-time warning),
 * not queued and truncated later. */
export const MAX_STEPS_PER_TEST_ATTEMPT = 300;
