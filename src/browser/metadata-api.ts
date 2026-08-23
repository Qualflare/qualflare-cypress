import type { CasePriority, LinkType } from '../shared/types.js';
import { getDefaultMetadataBuffer } from './test-metadata-buffer.js';

/**
 * The author-facing metadata API, imported by test code as:
 *
 * ```ts
 * import { qualflare } from '@qualflare/cypress';
 *
 * it('logs in', () => {
 *   qualflare.label('epic', 'Authentication');
 *   qualflare.step('fill in credentials', () => {
 *     cy.get('#user').type('a@example.com');
 *     cy.get('#pass').type('secret');
 *   });
 * });
 * ```
 *
 * `label`/`link`/`tag`/`description`/`priority`/`parameter`/`attachment`/
 * `attachmentFromFile` are PLAIN SYNCHRONOUS FUNCTIONS, not Cypress
 * commands — safe because Mocha runs a test's function body synchronously
 * to completion before any of ITS queued `cy.*()` commands actually
 * execute, so exactly one test is ever "current" (tracked by the shared
 * metadata buffer's — see `test-metadata-buffer.ts` — active/reset/drain
 * lifecycle, driven by `mocha-listener.ts`) regardless of where these are textually written
 * relative to `cy.*()` calls in the same test body. They append directly
 * into the buffer and return immediately.
 *
 * `step()` is different and MUST interleave into the actual Cypress command
 * queue — see its own doc comment below.
 */
export const qualflare = {
  label(name: string, value: string): void {
    getDefaultMetadataBuffer().label(name, value);
  },

  link(url: string, opts?: { type?: LinkType; name?: string }): void {
    getDefaultMetadataBuffer().link(url, opts);
  },

  tag(...tags: string[]): void {
    getDefaultMetadataBuffer().tag(...tags);
  },

  description(text: string): void {
    getDefaultMetadataBuffer().description(text);
  },

  priority(value: CasePriority): void {
    getDefaultMetadataBuffer().priority(value);
  },

  parameter(name: string, value?: string, opts?: { masked?: boolean }): void {
    getDefaultMetadataBuffer().parameter(name, value, opts);
  },

  attachment(name: string, content: string, opts?: { encoding?: 'utf8' | 'base64'; mimeType?: string }): void {
    getDefaultMetadataBuffer().attachment(name, content, opts);
  },

  attachmentFromFile(name: string, path: string, opts?: { mimeType?: string }): void {
    getDefaultMetadataBuffer().attachmentFromFile(name, path, opts);
  },

  /**
   * Wraps `fn` as a named, reportable step. Unlike every other function on
   * this object, a step's start/end only has meaning relative to when its
   * wrapped `cy.*()` commands actually EXECUTE — not when `step()` is
   * textually called, which happens synchronously, before any queued
   * command has run. So this interleaves `beginStep`/`endStep` INTO the
   * command queue itself via `cy.then()`, at the exact point the wrapped
   * commands run, rather than calling them eagerly.
   *
   * Verified directly against `node_modules/cypress/types/cypress.d.ts`
   * (Cypress 14.5.4) before relying on any of this, rather than assumed:
   *  - `Cypress.isCy(obj: any): obj is Chainable` exists exactly as the
   *    plan's sketch expected.
   *  - `cy.wrap<S>(object: S, options?: Partial<Loggable & Timeoutable>)`
   *    accepts `{ log: false }` — this is properly typed.
   *  - `cy.then<S>(options: Partial<Timeoutable>, fn): ...` does NOT accept
   *    `Loggable` in its options type (only `wrap()` does) — passing
   *    `{ log: false }` to `.then()` is a genuine type error under this
   *    version's declarations. Cypress's own runtime DOES honor `log: false`
   *    on `.then()` in practice (a long-documented, widely-relied-upon
   *    behavior across the Cypress plugin ecosystem — every reporter that
   *    injects bookkeeping commands into the queue uses this), so `.then()`
   *    calls below pass it via a narrow, explicitly-commented type
   *    assertion rather than omitting it and cluttering every test's
   *    Command Log with reporter-internal entries.
   */
  step<T = void>(name: string, fn: () => T | Cypress.Chainable<T>): Cypress.Chainable<T> {
    // `beginStep()` runs SYNCHRONOUSLY, immediately — not deferred into a
    // queued `cy.then()` as an earlier version of this function did. Verified
    // wrong by running a real Cypress spec (see `test/integration/`): `fn()`
    // below executes synchronously right after this call, but a `cy.then()`
    // callback only runs later, once the Cypress command queue reaches it —
    // so any `qualflare.parameter()`/nested `qualflare.step()` call made
    // directly in `fn()`'s synchronous body would run BEFORE the deferred
    // `beginStep()` ever pushed onto the nesting stack, and would incorrectly
    // see "no step is open." Pushing synchronously here means every call
    // made during `fn()`'s own synchronous execution sees the correct,
    // currently-open step — the tradeoff is that `startedAt` (used for this
    // step's duration) reflects when `step()` was JS-called, not the actual
    // Cypress-queue moment its first wrapped command executes; a documented
    // approximation, consistent with the auto-captured command-log steps'
    // own timing caveat (see `command-log-listener.ts`).
    const stepIndex = getDefaultMetadataBuffer().beginStep(name);

    // `fn()` itself can throw SYNCHRONOUSLY (a plain `throw` in the step
    // body, not a failing `cy.*()` command — those fail asynchronously,
    // later in the queue, and are unaffected by this catch). Without this,
    // `endStep()` would never run for this step (only reachable via the
    // `.then()` success path below), leaving it `'pending'` forever with no
    // captured error — found via deep adversarial self-review. Record the
    // failure, then re-throw unchanged: the test itself must still fail
    // normally, this only makes sure the step record reflects what actually
    // happened before that propagates.
    let result: T | Cypress.Chainable<T>;
    try {
      result = fn();
    } catch (err) {
      getDefaultMetadataBuffer().endStep(stepIndex, 'failed', formatSyncStepError(err));
      throw err;
    }

    // `Cypress.isCy(obj: any): obj is Chainable` narrows to the untyped
    // generic `Chainable`, not `Chainable<T>` — TS can't prove a runtime
    // check on an `any`-typed parameter preserves a specific type argument,
    // so the branch still needs an explicit assertion back to `Chainable<T>`
    // (safe: `fn`'s own declared return type guarantees this at the call site).
    const chained: Cypress.Chainable<T> = Cypress.isCy(result)
      ? (result as Cypress.Chainable<T>)
      : cy.wrap(result as T, { log: false });

    return chained.then(withoutLog(), (value: T) => {
      getDefaultMetadataBuffer().endStep(stepIndex, 'passed');
      return value;
    });
  },
};

/** Mirrors `mocha-listener.ts`'s `formatError` — kept as a small local copy
 * rather than a shared import, since this file is deliberately independent
 * of that one (see its own module boundary reasoning elsewhere in this
 * codebase). */
function formatSyncStepError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.message}\n${err.stack}` : err.message;
  }
  return String(err);
}

/**
 * `{ log: false }`, typed as `Partial<Cypress.Timeoutable>` to satisfy
 * `.then()`'s declared signature — see the long comment on `step()` above
 * for why this is a deliberate, verified-safe type assertion rather than an
 * oversight. Factored into one helper so the justification lives in exactly
 * one place instead of being repeated at each `.then()` call site.
 */
function withoutLog(): Partial<Cypress.Timeoutable> {
  return { log: false } as Partial<Cypress.Timeoutable>;
}
