import { qualflare } from '@qualflare/cypress';

describe('checkout', () => {
  it('adds and removes a todo item', () => {
    qualflare.link('https://github.com/Qualflare/qualflare-cypress', { type: 'custom', name: 'source' });
    qualflare.description('Exercises the qualflare.step()/parameter() combination against a public demo page.');

    cy.visit('https://example.cypress.io/todo');

    qualflare.step('add a new item', () => {
      qualflare.parameter('itemText', 'Buy milk');
      cy.get('.new-todo').type('Buy milk{enter}');
      cy.contains('.todo-list li', 'Buy milk').should('exist');
    });

    qualflare.step('mark it complete', () => {
      cy.contains('.todo-list li', 'Buy milk').find('.toggle').check();
      cy.contains('.todo-list li', 'Buy milk').should('have.class', 'completed');
    });
  });
});
