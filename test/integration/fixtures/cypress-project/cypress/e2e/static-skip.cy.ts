describe('a spec with a statically-skipped test', () => {
  it.skip('is statically skipped and never runs', () => {
    expect(true).to.equal(true);
  });

  it('a normal test that runs right after the skip', () => {
    cy.wrap({ ok: true }).its('ok').should('be.true');
  });
});
