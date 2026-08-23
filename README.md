# @qualflare/cypress

A native Cypress reporter for [Qualflare](https://qualflare.com) — uploads test results directly
from your Cypress run: suite/test status, real retry counts, screenshots, step-by-step command
traces, and author-facing metadata (labels, links, tags, custom attachments). No post-hoc file
parsing, no intermediate report format.

## Install

```sh
npm install --save-dev @qualflare/cypress
```

Requires Cypress `>=12.0.0 <15.0.0` (installed separately as a peer dependency) and Node `>=18`.

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

Set your token via the `QUALFLARE_TOKEN` environment variable (or the `token` plugin option):

```sh
QUALFLARE_TOKEN=<your-token> npx cypress run
```

That's it — suite/test results, retries, and automatic-on-failure screenshots upload as one Launch
at the end of the run. See [`examples/basic/`](./examples/basic) for a complete runnable project.

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

## Known limitations

- **No video upload** — Qualflare has no blob/video-attachment storage yet.
- **One `cypress run` process uploads as one Launch** — sharded CI setups get multiple Launches.
- **Command-log step nesting is two levels only** (Cypress's own API limit) — `qualflare.step()`
  supports arbitrary nesting depth.

Full details in [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run build       # tsup — dual ESM+CJS, .d.ts
npm test            # unit tests (vitest)
npm run test:integration   # spawns real cypress run against a fixture project + mock server
```

Release process: see [`RELEASING.md`](./RELEASING.md).

## License

Apache-2.0
