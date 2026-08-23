import { describe, expect, it } from 'vitest';

import { qualflare } from '../../src/browser/metadata-api.js';
import { getDefaultMetadataBuffer } from '../../src/browser/test-metadata-buffer.js';

/**
 * `qualflare.step()`'s happy path (wrapping real `cy.*()` chainables,
 * interleaving into Cypress's command queue via `cy.then()`) needs a real
 * Cypress/`cy` global to exercise and isn't tested here — this file only
 * covers the ONE scenario that's reachable without any Cypress runtime at
 * all: `fn()` throwing SYNCHRONOUSLY, which is caught and handled entirely
 * before `step()` ever touches `Cypress.isCy`/`cy.wrap`/`.then()`. See
 * `getDefaultMetadataBuffer()`'s own `typeof Cypress === 'undefined'`
 * fallback (in `test-metadata-buffer.ts`) for why the buffer itself is
 * testable in a plain Vitest environment.
 */
describe('qualflare.step() — synchronous throw', () => {
  it('a step whose body throws synchronously is recorded failed with the error captured, not left pending forever, and the error still propagates to the caller', () => {
    // getDefaultMetadataBuffer() falls back to a plain, testable instance
    // outside a real Cypress context — reset() marks it active, matching
    // what mocha-listener.ts does at the start of every test attempt.
    getDefaultMetadataBuffer().reset();

    const err = new Error('boom');
    expect(() => {
      qualflare.step('doomed step', () => {
        throw err;
      });
    }).toThrow(err);

    const snapshot = getDefaultMetadataBuffer().drain();
    expect(snapshot.manualSteps).toHaveLength(1);
    const step = snapshot.manualSteps![0]!;
    expect(step.name).toBe('doomed step');
    expect(step.status).toBe('failed');
    expect(step.error).toContain('boom');
    // Proves endStep() actually ran (previously it never did for this exact
    // scenario — the step stayed 'pending' with durationMs left undefined
    // forever, since only the .then() success path ever called endStep()).
    expect(step.durationMs).toBeDefined();
  });

  it('a step called outside any active test attempt (buffer inactive) still lets the synchronous throw propagate, without recording a step', () => {
    // drain() (not reset()) leaves the buffer inactive — mirrors a
    // qualflare.step() call made from a before()/after() hook or at
    // module-load time, which beginStep() already warns-and-no-ops for.
    getDefaultMetadataBuffer().drain();

    const err = new Error('still throws even when inactive');
    expect(() => {
      qualflare.step('irrelevant', () => {
        throw err;
      });
    }).toThrow(err);
  });
});
