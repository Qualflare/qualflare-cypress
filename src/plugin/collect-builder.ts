import * as os from 'node:os';

import type { ResolvedPluginConfig } from './resolve-config.js';
import type { LaunchAccumulator } from './state.js';
import type { Collect } from '../shared/types.js';
import { PACKAGE_VERSION } from './version.js';

/** Browser/system info captured at Cypress's `before:run` event — richer
 * and more accurate than any Node-side guess when available. */
export interface BrowserInfo {
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
}

function resolveOs(config: ResolvedPluginConfig, info: BrowserInfo | undefined): string {
  if (config.os) {
    return config.os;
  }
  if (info?.osName) {
    return info.osVersion ? `${info.osName} ${info.osVersion}` : info.osName;
  }
  return `${os.type()} ${os.release()}`;
}

function resolveBrowser(config: ResolvedPluginConfig, info: BrowserInfo | undefined): string {
  if (config.browser) {
    return config.browser;
  }
  if (info?.browserName) {
    return info.browserVersion ? `${info.browserName} ${info.browserVersion}` : info.browserName;
  }
  return '';
}

/**
 * Assembles the final `Collect` payload from everything accumulated over
 * the `cypress run` process, at `after:run`. CI metadata
 * (`ciProvider`/`ciBuildNumber`/`ciRunUrl`/`ciPrNumber`) and branch/commit
 * auto-detection are already fully resolved by `resolve-config.ts` (the
 * single source of truth for this launch's metadata, consistent with how
 * `branch`/`commit` are handled) — this function just reads the resolved
 * config through, it does not call `ci-detect.ts`/`git-detect.ts` itself.
 */
export function buildCollectPayload(
  accumulator: LaunchAccumulator,
  config: ResolvedPluginConfig,
  browserInfo: BrowserInfo | undefined,
): Collect {
  return {
    framework: config.framework,
    platform: config.platform,
    os: resolveOs(config, browserInfo),
    browser: resolveBrowser(config, browserInfo),
    branch: config.branch,
    commit: config.commit,
    environment: config.environment,
    language: config.language,
    milestone: config.milestone,
    metadata: {
      version: PACKAGE_VERSION,
      timestamp: new Date().toISOString(),
      cliName: 'qualflare-cypress',
    },
    properties: config.properties,
    suites: accumulator.getSuites(),
    ciProvider: config.ciProvider,
    ciBuildNumber: config.ciBuildNumber,
    ciRunUrl: config.ciRunUrl,
    ciPrNumber: config.ciPrNumber,
  };
}
