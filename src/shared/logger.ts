/**
 * A minimal logger writing to stderr (Node) / console (browser). Node-side
 * output deliberately avoids stdout, since that's typically Cypress's own
 * test-output stream and shouldn't be polluted with plugin diagnostics.
 *
 * Safe to import from both browser-side and Node-side code (isomorphic) —
 * `console.*` exists in both environments; only the underlying stream
 * differs, which is not something this module needs to control explicitly
 * since `console.error`/`console.warn` already default to stderr in Node.
 */

const PREFIX = '[qualflare-cypress]';

export const logger = {
  debug(...args: unknown[]): void {
    console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]): void {
    console.log(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};
