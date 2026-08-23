// Fails on the first attempt, passes on the second — Cypress's built-in retry
// mechanism re-runs this test in place. Asserts (in run-cypress-project.test.ts,
// via the captured upload payload) that the reporter collapses both attempts
// into ONE Case with retryCount: 1, isFlaky: true — not two separate Cases.
let attempt = 0;

describe('flaky spec', { retries: { runMode: 2 } }, () => {
  it('is flaky and eventually passes', () => {
    attempt += 1;
    expect(attempt, 'flaky attempt counter').to.be.greaterThan(1);
  });
});
