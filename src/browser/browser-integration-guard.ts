/**
 * Cypress compiles the support file and each spec file as SEPARATE webpack
 * bundles (see `test-metadata-buffer.ts`'s header comment for the first time
 * this bit us). A spec file that does `import { qualflare } from
 * '@qualflare/cypress'` — the plugin's own documented pattern for the
 * author-facing metadata API — causes `browser/index.ts`'s side effects to
 * re-evaluate in that spec's own bundle, in addition to the support file's
 * `import '@qualflare/cypress'`. Without a guard, that means
 * `registerMochaListener()`/`registerTestPhaseSignal()` each run a second
 * time, registering a SECOND, independent set of listeners against the SAME
 * real `Cypress.mocha.getRunner()` / `Cypress.on(...)` / global
 * `afterEach()`/`beforeEach()` — these ARE genuinely shared across bundles
 * (unlike ES module state, which is not) — so every real test in that spec
 * ends up flushed to the Node side TWICE. Verified against a real Cypress
 * consumer project (app-ui): a spec directly importing `{ qualflare }`
 * uploaded every one of its tests twice, with `qualflare.label()`/`.tag()`
 * data landing on only one of the two duplicate uploads (whichever
 * registration's metadata buffer hadn't already been drained by the other).
 *
 * Fixed the same way `test-metadata-buffer.ts` already fixed the analogous
 * state-sharing problem: anchor a flag on the `Cypress` global, which is the
 * one object genuinely shared across every bundle evaluated within the same
 * spec-runner page. Guarded ONCE, in `browser/index.ts`, rather than inside
 * each individual `register*()` function, so a future third registration
 * function automatically benefits without anyone needing to remember to add
 * its own guard.
 *
 * The flag naturally resets between spec files (Cypress reloads the page —
 * and with it, the whole `Cypress` global — between specs in `cypress run`),
 * which is correct: each spec's own `Cypress.mocha.getRunner()` is a
 * different runner instance and genuinely needs its own registration.
 *
 * Extracted into its own module (rather than living inline in
 * `browser/index.ts`) purely for testability, mirroring this codebase's
 * established pure-logic/thin-Cypress-glue split (`CommandLogBuffer` vs.
 * `registerCommandLogListener`, `MochaAttemptTracker` vs.
 * `registerMochaListener`): `browser/index.ts` itself calls
 * `initializeBrowserIntegration()` as a top-level module-load side effect,
 * which — like `registerMochaListener` — has never supported running
 * outside a real Cypress page (it unconditionally needs `Cypress` to exist
 * for the real registration functions it wires up), so `browser/index.ts`
 * cannot itself be imported under a plain Node/Vitest environment. This
 * module has no such top-level self-invocation, so it can be.
 */
interface CypressWithBrowserRegistration {
  __qualflareBrowserRegistered?: boolean;
}

/**
 * Calls `register()` at most once per distinct `Cypress` object — i.e. once
 * per real spec-file page load, no matter how many separate bundles
 * re-evaluate the module that calls this. When `Cypress` is undefined,
 * there's no flag to anchor on and no meaningful fallback value to hand
 * back (unlike `test-metadata-buffer.ts`'s `getDefaultMetadataBuffer`), so
 * `register()` is invoked unconditionally on every call — preserving this
 * codebase's pre-existing behavior for that scenario exactly (calling the
 * real `registerMochaListener`/`registerTestPhaseSignal` without a real
 * Cypress has never worked, before or after this fix; that's an inherent
 * requirement of what they register, not something this guard changes).
 */
export function initializeBrowserIntegration(register: () => void): void {
  const target = typeof Cypress === 'undefined' ? undefined : (Cypress as unknown as CypressWithBrowserRegistration);
  if (target?.__qualflareBrowserRegistered) {
    return;
  }
  if (target) {
    target.__qualflareBrowserRegistered = true;
  }
  register();
}
