import { afterEach, describe, expect, it } from 'vitest';

import { initializeBrowserIntegration } from '../../src/browser/browser-integration-guard.js';

/** These tests run under Vitest's `node` environment, where `Cypress` is
 * genuinely undefined by default (no jsdom/Cypress mock global is set up
 * project-wide) — so each test that wants to exercise the "real Cypress
 * page" guard path must explicitly stub `globalThis.Cypress` and clean it
 * up afterward, to avoid leaking state into other test files. */
afterEach(() => {
  delete (globalThis as { Cypress?: unknown }).Cypress;
});

describe('initializeBrowserIntegration', () => {
  it('registers exactly once even when called multiple times against the same Cypress object', () => {
    // Simulates the exact real-world scenario that caused the double-upload
    // bug: Cypress evaluates browser/index.ts's side effects once per
    // bundle (support file + any spec file that also imports the package),
    // but `Cypress` itself is the one object genuinely shared across all of
    // them — confirmed against a real Cypress consumer project (app-ui),
    // see this function's doc comment in browser-integration-guard.ts.
    (globalThis as { Cypress?: unknown }).Cypress = {};

    let registerCount = 0;
    const register = () => {
      registerCount += 1;
    };

    initializeBrowserIntegration(register); // "support file" bundle evaluation
    initializeBrowserIntegration(register); // "spec file" bundle re-evaluation
    initializeBrowserIntegration(register); // a third, for good measure

    expect(registerCount).toBe(1);
  });

  it('registers independently for two different Cypress objects (simulating two separate spec-file page loads)', () => {
    // Cypress reloads the whole page (and with it, the Cypress global)
    // between spec files in `cypress run` — each spec's own
    // Cypress.mocha.getRunner() is a different runner instance and
    // genuinely needs its own registration. The guard must not leak across
    // page loads.
    let registerCount = 0;
    const register = () => {
      registerCount += 1;
    };

    (globalThis as { Cypress?: unknown }).Cypress = {};
    initializeBrowserIntegration(register);
    initializeBrowserIntegration(register);
    expect(registerCount).toBe(1);

    // A fresh Cypress object — a different real page/spec-file load.
    (globalThis as { Cypress?: unknown }).Cypress = {};
    initializeBrowserIntegration(register);

    expect(registerCount).toBe(2);
  });

  it('applies no guard when Cypress is undefined — every call invokes register (no flag to anchor on)', () => {
    // e.g. this module loaded under a test runner other than a real Cypress
    // browser page. Unlike test-metadata-buffer.ts's getDefaultMetadataBuffer,
    // there's no meaningful fallback value to hand back here — the real
    // default `register` (registerMochaListener/registerTestPhaseSignal)
    // inherently requires a real Cypress.mocha.getRunner() and has never
    // supported running without one, before or after this fix. The guard
    // itself just has nothing to anchor a flag on, so it calls `register()`
    // unconditionally every time rather than silently swallowing calls.
    expect(typeof Cypress).toBe('undefined');

    let registerCount = 0;
    const register = () => {
      registerCount += 1;
    };

    initializeBrowserIntegration(register);
    initializeBrowserIntegration(register);

    expect(registerCount).toBe(2);
  });
});
