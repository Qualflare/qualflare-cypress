describe('dogfood artifacts', () => {
  // cy.screenshot() explicitly, NOT a failure screenshot: this suite is green,
  // so nothing fails to trigger one. It also has to be a real file on disk --
  // in this reporter localImagePath comes only from a PATH-bearing attachment
  // (copyImageAttachment runs when content is undefined and path is set), so a
  // base64 qualflare.attachment() would stay inline and prove nothing.
  it('attaches a screenshot, which travels out of band', () => {
    cy.visit('/');
    cy.get('#title').should('be.visible');
    cy.screenshot('dogfood-shot');
  });
});
