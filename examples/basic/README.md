# qualflare-cypress basic example

A minimal, standalone Cypress project showing typical `@qualflare/cypress` usage: plugin
registration, the support-file import, and a few `qualflare.*` metadata calls (`label`, `tag`,
`link`, `description`, `step`, `parameter`).

This is a reference for browsing, not something this repo's own test suite runs — see
`../../test/integration/` for the harness actually exercised by CI.

## Running it against a real Qualflare account

The reporter never uploads anything itself: `cypress run` writes a report directory, and
`qualflare-cli` uploads it as a separate step. That split is what lets sharded CI jobs each write
into the same directory and be merged into one Launch by a single `collect` at the end.

```sh
cd examples/basic
npm install

# 1. Run the tests. Writes ./qualflare-results (JSON + any videos), no network calls.
npm test

# 2. Upload. Requires qualflare-cli >= v0.1.16 — see https://github.com/Qualflare/qualflare-cli
qf <your-project-identifier> collect ./qualflare-results
```

`qf login <your-project-identifier> <token>` stores the credential once; there is no
`QUALFLARE_TOKEN` env var in this model — the reporter has no token because it makes no requests.

Set `environment` in `cypress.config.ts` (or `QUALFLARE_ENVIRONMENT`) to an environment that exists
in your Qualflare project — see [`../../docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md).

Once `collect` finishes, check your Qualflare project — you should see one new Launch with two
Suites (`login.cy.ts`, `checkout.cy.ts`), each test carrying the labels/steps/parameters set in the
spec files.
