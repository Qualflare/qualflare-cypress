import { qualflare } from '@qualflare/cypress';

describe('login', () => {
  it('signs in with valid credentials', () => {
    qualflare.label('epic', 'Authentication');
    qualflare.tag('smoke');

    qualflare.step('fill in credentials', () => {
      cy.visit('https://example.cypress.io/todo');
      // A real project would fill in a login form here — this example keeps
      // things dependency-free by visiting a public demo page instead.
    });

    qualflare.step('verify the page loaded', () => {
      cy.get('.todo-list').should('exist');
    });
  });
});
