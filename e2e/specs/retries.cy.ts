// Retries are scoped HERE, not set globally. A global `retries` would re-run a
// genuine regression and quietly turn it green -- in a suite whose whole job is
// that red means something.
//
// Keyed on Cypress.currentRetry, never a marker file: a marker survives an
// interrupted run and silently makes the next run's first attempt pass, turning
// this into a no-op that still looks green.
describe('intentional retry', { retries: { runMode: 1 } }, () => {
  it('fails once, then passes, producing per-attempt history', () => {
    expect(Cypress.currentRetry, 'dogfood-intentional-retry-marker').to.be.greaterThan(0);
  });
});
