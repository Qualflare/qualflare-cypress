import { defineConfig } from 'cypress';

// eslint-disable-next-line import/no-relative-packages -- deliberate: the dogfood
// suite consumes the BUILT package the way a real user would.
import { qualflareCypress } from '../dist/plugin/index.js';
import { startAppServer } from './app/server.mjs';

/**
 * The dogfood suite: qualflare-cypress reporting on tests of itself.
 *
 * Unlike test/integration/fixtures/cypress-project, every test here is meant to
 * PASS. That fixture deliberately fails, to exercise status mapping; this one is
 * uploaded to Qualflare, so red has to mean a real regression.
 */
export default defineConfig({
  // Off: this suite is all-green, so no failure video would ever be recorded,
  // and the CLI drops video by default anyway. test/integration already covers
  // the localVideoPath path end to end.
  video: false,
  screenshotOnRunFailure: false,
  // ZERO global retries, deliberately. The retry is scoped to the one
  // intentionally-flaky spec; a global retry would silently re-run and green a
  // GENUINE regression, in the suite whose red is meant to mean something.
  retries: 0,
  e2e: {
    supportFile: 'e2e/support/e2e.ts',
    specPattern: 'e2e/specs/**/*.cy.ts',
    screenshotsFolder: 'e2e/.artifacts/screenshots',
    videosFolder: 'e2e/.artifacts/videos',
    async setupNodeEvents(on, config) {
      // A real origin, because cy.visit() does not accept data: URLs. Port 0,
      // so nothing can collide on a busy runner.
      const { origin } = await startAppServer();
      config.baseUrl = origin;
      return qualflareCypress(on, config, {
        // Cypress treats the config file's directory as the project root, so a
        // relative outputDir resolves from e2e/, not from where npm ran.
        // '../' puts the report at the repo root, matching the other reporters
        // and what the workflow collects. Unlike the Playwright reporter, this
        // plugin uses the same value for the report AND its artifacts, so the
        // two cannot land in different places.
        outputDir: process.env['QUALFLARE_OUTPUT_DIR'] ?? '../e2e-results',
        // Recorded in the report itself rather than passed at collect time, so
        // there is one source of truth for the environment.
        environment: 'production',
        branch: null,
        commit: null,
      });
    },
  },
});
