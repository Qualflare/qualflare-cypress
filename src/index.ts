/**
 * Browser-side public entry — import for its side effect in
 * `cypress/support/e2e.ts` (or `.js`):
 *
 * ```ts
 * import '@qualflare/cypress';
 * ```
 *
 * This registers the Mocha/Cypress event listeners that build up test
 * results and hand them to the Node-side plugin. The author-facing
 * `qualflare` metadata API (labels, links, custom steps, attachments, etc.)
 * is also available as a named export:
 *
 * ```ts
 * import { qualflare } from '@qualflare/cypress';
 * ```
 */
import './browser/index.js';

export { qualflare } from './browser/metadata-api.js';

