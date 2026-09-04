# @qualflare/cypress

[![npm version](https://img.shields.io/npm/v/%40qualflare%2Fcypress.svg)](https://www.npmjs.com/package/@qualflare/cypress)
[![CI](https://github.com/Qualflare/qualflare-cypress/actions/workflows/ci.yml/badge.svg)](https://github.com/Qualflare/qualflare-cypress/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

A native Cypress reporter for [Qualflare](https://qualflare.com) — captures test results directly
from your Cypress run: suite/test status, per-attempt retry history, screenshots, step-by-step command
traces, and author-facing metadata (labels, links, tags, custom attachments) — and writes them into
a report directory that [`qualflare-cli`](https://github.com/Qualflare/qualflare-cli) uploads. No
post-hoc file parsing, no intermediate report format to hand-roll, no network access needed from
inside your Cypress run.

## Install

```sh
npm install --save-dev @qualflare/cypress
```

Requires Cypress `>=12.0.0` (installed separately as a peer dependency). Node `>=18` for
Cypress 12–14; Cypress 15 itself requires Node `>=20`.

The peer range is deliberately open-ended rather than capped at a known-good major, so a new
Cypress release never hard-blocks `npm install` for you. Every major from 12 through 15 is
exercised in CI against a real `cypress run`; majors newer than that are untested but not
refused — please [open an issue](https://github.com/Qualflare/qualflare-cypress/issues) if
one misbehaves.

(Contributors: the repo itself now develops against Cypress 15, which requires Node `>=20.1`.
The `>=18` floor above is the *consumer* requirement and still holds for Cypress 12–14.)

## Quickstart

```ts
// cypress.config.ts
import { defineConfig } from 'cypress';
import { qualflareCypress } from '@qualflare/cypress/plugin';

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      return qualflareCypress(on, config, {
        environment: 'staging',
      });
    },
  },
});
```

```ts
// cypress/support/e2e.ts
import '@qualflare/cypress';
```

Run your tests as usual — every `cypress run` writes a Collect report (JSON, plus any video
attachments) into `./qualflare-results` by default. No token or network access is needed for this
step; the reporter itself never makes a network call:

```sh
npx cypress run
```

Then, in the same CI job, hand that directory to `qualflare-cli` — the step that actually uploads
results, required after every run, sharded or not:

```sh
npm install -g @qualflare/cli
qf login my-project "$QUALFLARE_TOKEN" --force
qf my-project collect ./qualflare-results
```

> **Videos are opt-in from `@qualflare/cli` v0.1.20.** `collect` uploads the report itself
> always, but a video only when asked: `--upload-artifacts=video` (or `QF_UPLOAD_ARTIFACTS=video`).
> Earlier CLI versions uploaded every video automatically. Nothing is dropped silently — `collect`
> prints how many it skipped and the exact flag to include them.

That's it — suite/test results, retries, and automatic-on-failure screenshots show up as one Launch
once `qualflare-cli collect` runs. [`examples/basic/`](./examples/basic) has a runnable project
demonstrating the same flow end to end, including the `qualflare.*` metadata API.

## Enriching your tests

```ts
import { qualflare } from '@qualflare/cypress';

it('logs in with valid credentials', () => {
  qualflare.label('epic', 'Authentication');
  qualflare.tag('smoke');

  qualflare.step('fill in credentials', () => {
    cy.get('#email').type('user@example.com');
    cy.get('#password').type('correct-horse-battery-staple');
  });

  qualflare.step('submit and verify redirect', () => {
    cy.get('#submit').click();
    cy.url().should('include', '/dashboard');
  });
});
```

See [`docs/METADATA-API.md`](./docs/METADATA-API.md) for the full reference (labels, links, tags,
description, priority, parameters, custom attachments, nested steps).

## Configuration

Every option can be set either as a plugin option (`qualflareCypress(on, config, options)`) or via a
`QUALFLARE_*` environment variable. Full table, precedence rules, and auto-detection behavior (git
branch/commit, CI provider/build/PR, browser/OS) in [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md).

One option is worth calling out because it fails late: `environment` is matched against the
environment's **uid (slug)**, not its display name, so **Staging** in the UI is `staging` here. A
wrong value cannot fail at run time — this package makes no network calls — so the run succeeds and
`collect` 404s afterwards. See
[the note in the configuration docs](./docs/CONFIGURATION.md#environment-is-matched-by-uid-not-display-name).

## Known limitations

- **Retries carry per-attempt errors, but everything else is the final attempt** — `Case.attempts`
  records each attempt's status, duration and error; steps, labels, links, tags, priority,
  properties and attachments come from the last attempt only, so an abandoned attempt's step trace
  is discarded rather than replayed alongside the final one.

Full details in [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run build       # tsup — dual ESM+CJS, .d.ts
npm test            # unit tests (vitest)
npm run test:integration   # spawns a real cypress run against a fixture project, asserts on its outputDir report
```

Release process: see [`RELEASING.md`](./RELEASING.md).

## License

Apache-2.0
