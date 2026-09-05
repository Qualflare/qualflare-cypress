// eslint-disable-next-line import/no-relative-packages -- deliberate, see e2e/cypress.config.ts
import { qualflare } from '../../dist/index.js';

describe('dogfood', () => {
  // The baseline. Distinguishes "no report" from "a report that lost its cases".
  it('reports a plain passing test', () => {
    cy.visit('/');
    cy.get('#title').should('have.text', 'Dogfood Shop');
  });

  it('records the author-facing metadata API', () => {
    qualflare.label('team', 'platform');
    qualflare.link('https://github.com/Qualflare/qualflare-cypress', {
      type: 'custom',
      name: 'repository',
    });
    qualflare.tag('dogfood');
    qualflare.description('Exercises every metadata call the README documents.');
    qualflare.priority('high');
    qualflare.parameter('plan', 'enterprise');

    cy.visit('/');
    cy.get('#title').should('be.visible');
  });

  it('nests steps', () => {
    qualflare.step('outer', () => {
      qualflare.parameter('scope', 'outer');
      qualflare.step('inner', () => {
        cy.visit('/');
        cy.get('#user').type('ada');
        cy.get('#submit').click();
        cy.get('#greeting').should('have.text', 'Welcome, ada');
      });
    });
  });

  // A masked parameter is redacted AT SOURCE -- the value never reaches the
  // report. verify-report.mjs asserts the secret is absent from the whole
  // payload, which is the only assertion that can prove that.
  it('redacts a masked parameter', () => {
    qualflare.parameter('apiKey', 'qf-dogfood-secret-value', { masked: true });
    cy.visit('/');
    cy.get('#title').should('exist');
  });
});
