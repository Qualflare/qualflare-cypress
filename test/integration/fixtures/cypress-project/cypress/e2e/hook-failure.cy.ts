describe('a spec whose beforeEach hook fails', () => {
  beforeEach(() => {
    throw new Error('qualflare-cypress-integration-test-hook-failure-marker');
  });

  it('never runs its body because the guarding beforeEach hook fails first', () => {
    // This body is never reached — the beforeEach above always throws first.
    // The test still needs to be uploaded as failed (not silently dropped),
    // which is exactly what this fixture proves.
    expect(true).to.equal(true);
  });
});
