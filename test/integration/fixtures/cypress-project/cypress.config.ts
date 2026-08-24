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
  // Enabled (rather than the production-typical `false`) so the integration
  // test can exercise the video-attachment path end-to-end: a spec with at
  // least one failing test gets its recorded video copied into `outputDir`
  // and referenced via `localVideoPath` — see src/plugin/events.ts's
  // `after:spec` handler.
  video: true,
  screenshotOnRunFailure: true,
  e2e: {
    supportFile: 'cypress/support/e2e.ts',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    setupNodeEvents(on, config) {
      return qualflareCypress(on, config, {
        // A custom QUALFLARE_TEST_* var (not the real QUALFLARE_OUTPUT_DIR)
        // so the integration test can point each run at its own isolated
        // temp directory without depending on/colliding with anything a
        // developer's shell might already export.
        outputDir: process.env.QUALFLARE_TEST_OUTPUT_DIR ?? './qualflare-results',
        environment: 'development',
        // Skip git/CI auto-detection noise in the captured report — this
        // fixture's assertions don't depend on it, and it forks a `git`
        // subprocess we don't need in a test harness.
        branch: null,
        commit: null,
      });
    },
  },
});
