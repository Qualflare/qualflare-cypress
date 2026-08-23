import { TASK_REPORT_CASE } from '../shared/constants.js';
import { msToNs } from '../shared/duration.js';
import type { Case } from '../shared/types.js';
import { collapseAttempts, type AttemptSnapshot } from './case-builder.js';

/**
 * Collapses one logical test's recorded attempts into a final `Case` and
 * hands it to the Node side via `cy.task()`. Called once per test, from the
 * root-level `afterEach` in `mocha-listener.ts` — which Cypress guarantees
 * runs only after that test's built-in retries (if any) are exhausted, and
 * (via Mocha's innermost-first `afterEach` ordering) after any `afterEach`
 * the spec itself authored.
 *
 * `{ log: false }` on the `cy.task()` call keeps this plumbing out of the
 * Cypress Command Log — it's reporter bookkeeping, not something a test
 * author needs to see.
 */
export function flushCase(test: Mocha.Test, attempts: AttemptSnapshot[]): void {
  if (attempts.length === 0) {
    // Nothing was ever recorded for this test (e.g. it was skipped by a
    // parent-level `.skip` before any runner event fired for it) — nothing
    // to report.
    return;
  }

  const collapsed = collapseAttempts(attempts);
  const testCase: Case = {
    id: test.fullTitle(),
    name: test.title,
    className: test.parent?.fullTitle() || undefined,
    status: collapsed.status,
    duration: msToNs(collapsed.duration),
    retryCount: collapsed.retryCount,
    isFlaky: collapsed.isFlaky,
    error: collapsed.error,
    steps: collapsed.steps,
    // qualflare.* author-facing metadata API calls (labels/links/tags/
    // description/priority/properties from qualflare.label()/link()/tag()/
    // description()/priority()/parameter(); attachments from
    // qualflare.attachment()/attachmentFromFile() — the latter carry only
    // a `path`, resolved into inline content Node-side by the existing
    // screenshot-attachment pipeline, see tasks.ts/attachment-reader.ts)
    // from the FINAL attempt only, same "abandoned attempts are discarded"
    // rule as `steps`.
    labels: collapsed.labels,
    links: collapsed.links,
    tags: collapsed.tags,
    description: collapsed.description,
    priority: collapsed.priority,
    properties: collapsed.properties,
    attachments: collapsed.attachments,
  };

  cy.task(TASK_REPORT_CASE, testCase, { log: false });
}
