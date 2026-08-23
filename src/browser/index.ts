import { initializeBrowserIntegration } from './browser-integration-guard.js';
import { registerMochaListener } from './mocha-listener.js';
import { registerTestPhaseSignal } from './test-phase-signal.js';

// See browser-integration-guard.ts for the full rationale: this guards
// against registerMochaListener()/registerTestPhaseSignal() double-firing
// when a spec file also imports '@qualflare/cypress' directly (Cypress
// evaluates the support file and each spec file as separate webpack
// bundles). Deliberately thin/untested, like registerMochaListener itself —
// it unconditionally needs a real Cypress page to do anything meaningful,
// so it can't be imported under a plain Node/Vitest environment; the actual
// guard logic lives in browser-integration-guard.ts, which can be.
initializeBrowserIntegration(() => {
  registerMochaListener();
  registerTestPhaseSignal();
});
