import { defineConfig } from 'cypress';
import { qualflareCypress } from '@qualflare/cypress/plugin';

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      // In a real project nothing needs to be set: this reporter makes no
      // network calls and has no token, so every option has a sensible
      // default (results land in ./qualflare-results, which `qf collect`
      // then uploads). They're spelled out here just to show what's
      // available; see ../../docs/CONFIGURATION.md for the full list.
      return qualflareCypress(on, config, {
        environment: 'development',
      });
    },
  },
});
