import { qualflare } from '../../../../../../dist/index.js';

describe('metadata API spec', () => {
  it('exercises the author-facing metadata calls', () => {
    qualflare.label('epic', 'Integration Testing');
    qualflare.tag('smoke', 'qualflare-cypress-self-test');
    qualflare.description('Exercises the qualflare.* metadata API end-to-end against a real Cypress run.');
    qualflare.link('https://example.com/issue/1', { type: 'issue', name: 'example issue' });
    qualflare.parameter('outside-step-param', 'outside-value');

    qualflare.step('a manual step', () => {
      qualflare.parameter('inside-step-param', 'inside-value');
      cy.wrap(1).should('eq', 1);
    });
  });
});
