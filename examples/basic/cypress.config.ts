import { defineConfig } from 'cypress';
import { qualflareCypress } from '@qualflare/cypress/plugin';

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      // In a real project, only QUALFLARE_TOKEN needs to be set (via env var
      // or a .env file this example intentionally doesn't ship) — every
      // other option below has a sensible default. They're spelled out here
      // just to show what's available; see ../../docs/CONFIGURATION.md for
      // the full list.
      return qualflareCypress(on, config, {
        environment: 'development',
      });
    },
  },
});
