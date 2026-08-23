import { defineConfig } from 'cypress';
// Imported from the BUILT dist/ output, not src/ TypeScript source — a deliberate
// choice for this fixture: it exercises the actual package.json `exports` map and
// compiled ESM output a real consumer would load, rather than relying on Cypress's
// esbuild-based config loader correctly resolving TS-source `.js`-suffixed imports
// pointing at sibling `.ts` files (a resolution pattern that works fine for `tsc`'s
// own output but is not guaranteed for every bundler in every context). Requires
// `npm run build` to have run first — see test/integration/run-cypress-project.test.ts.
// eslint-disable-next-line import/no-relative-packages -- deliberate: this fixture consumes the built package like a real user would
import { qualflareCypress } from '../../../../dist/plugin/index.js';

export default defineConfig({
  video: false,
  screenshotOnRunFailure: true,
  e2e: {
    supportFile: 'cypress/support/e2e.ts',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    setupNodeEvents(on, config) {
      return qualflareCypress(on, config, {
        token: process.env.QUALFLARE_TEST_TOKEN ?? 'test-token',
        apiEndpoint: process.env.QUALFLARE_TEST_API_ENDPOINT,
        environment: 'development',
        // The harness itself should fail loudly if upload breaks — the opposite
        // of the safe production default (false).
        failOnUploadError: true,
        // Skip git/CI auto-detection noise in the captured payload — this
        // fixture's assertions don't depend on it, and it forks a `git`
        // subprocess we don't need in a test harness.
        branch: null,
        commit: null,
        debug: true,
      });
    },
  },
});
