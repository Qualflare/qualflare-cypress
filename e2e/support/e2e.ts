// The browser-side integration, loaded from BUILT dist/ for the same reason the
// integration fixture does: it exercises the compiled output a real consumer
// gets, not the TS source.
// eslint-disable-next-line import/no-relative-packages -- deliberate, see e2e/cypress.config.ts
import '../../dist/index.js';
