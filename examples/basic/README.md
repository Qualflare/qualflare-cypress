# qualflare-cypress basic example

A minimal, standalone Cypress project showing typical `@qualflare/cypress` usage: plugin
registration, the support-file import, and a few `qualflare.*` metadata calls (`label`, `tag`,
`link`, `description`, `step`, `parameter`).

This is a reference for browsing, not something this repo's own test suite runs — see
`../../test/integration/` for the harness actually exercised by CI, which uses a purpose-built mock
server instead of a real Qualflare account.

## Running it against a real Qualflare account

```sh
cd examples/basic
npm install
QUALFLARE_TOKEN=<your-token> npm test
```

Set `environment` in `cypress.config.ts` (or `QUALFLARE_ENVIRONMENT`) to an environment that exists
in your Qualflare project — see [`../../docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md).

Once the run finishes, check your Qualflare project — you should see one new Launch with two Suites
(`login.cy.ts`, `checkout.cy.ts`), each test carrying the labels/steps/parameters set in the spec
files.
