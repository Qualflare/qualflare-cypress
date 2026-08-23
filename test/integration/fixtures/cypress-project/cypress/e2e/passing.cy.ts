describe('passing spec', () => {
  it('passes normally', () => {
    cy.wrap({ ok: true }).its('ok').should('be.true');
  });
});
