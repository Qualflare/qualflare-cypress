import { AttachmentBudget, type AttachmentReaderConfig } from './attachment-reader.js';
import { registerEvents } from './events.js';
import { resolveConfig, type QualflareCypressOptions } from './resolve-config.js';
import { PendingAttachmentQueue, TestPhaseGate } from './state.js';
import { CaseBuffer, registerTasks } from './tasks.js';

export type { QualflareCypressOptions, ResolvedPluginConfig } from './resolve-config.js';
export { QualflareConfigError } from './resolve-config.js';

/**
 * Wires qualflare-cypress into `setupNodeEvents`. Returns `config`
 * unmodified so it composes with a user's own `setupNodeEvents` body and
 * with other plugins:
 *
 * ```ts
 * // cypress.config.ts
 * import { defineConfig } from 'cypress';
 * import { qualflareCypress } from '@qualflare/cypress/plugin';
 *
 * export default defineConfig({
 *   e2e: {
 *     setupNodeEvents(on, config) {
 *       return qualflareCypress(on, config, { environment: 'staging' });
 *     },
 *   },
 * });
 * ```
 */
export function qualflareCypress(
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions,
  options: QualflareCypressOptions = {},
): Cypress.PluginConfigOptions {
  const resolved = resolveConfig(options);
  const buffer = new CaseBuffer();
  const pendingAttachments = new PendingAttachmentQueue();
  const testPhaseGate = new TestPhaseGate();
  const attachmentBudget = new AttachmentBudget(resolved.maxTotalAttachmentBytes);
  // resolved already has every field AttachmentReaderConfig needs.
  const attachmentConfig: AttachmentReaderConfig = resolved;

  // Task handlers are always registered — even when disabled — so a
  // cy.task() call from the browser side never errors with "no handler
  // registered for task" just because the plugin is turned off.
  registerTasks(on, buffer, attachmentConfig, attachmentBudget, pendingAttachments, testPhaseGate);

  if (resolved.enabled) {
    registerEvents(on, resolved, buffer, pendingAttachments, testPhaseGate);
  }

  return config;
}
