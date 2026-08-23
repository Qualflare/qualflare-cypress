import type { Platform } from '../shared/types.js';
import { detectCi, type CiMetadata } from './ci-detect.js';
import { detectGit, type GitInfo } from './git-detect.js';

/** Options passed to `qualflareCypress(on, config, options)` in the user's
 * `cypress.config.ts`. Every field here also has an environment-variable
 * override — see the precedence table in the README / plan. */
export interface QualflareCypressOptions {
  token?: string;
  apiEndpoint?: string;
  environment?: string;
  language?: string;
  milestone?: number | null;
  branch?: string | null;
  commit?: string | null;
  platform?: Platform;
  framework?: string;
  os?: string;
  browser?: string;
  properties?: Record<string, string>;
  /** Max 64 chars. Free text, no enum — an unrecognized CI provider must
   * never be rejected. Auto-detected via `ci-detect.ts` when omitted. */
  ciProvider?: string;
  ciBuildNumber?: string;
  ciRunUrl?: string;
  ciPrNumber?: number;
  timeoutMs?: number;
  retry?: {
    max?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  failOnUploadError?: boolean;
  attachScreenshots?: boolean;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  debug?: boolean;
  /** `false` fully disables accumulation/POST (a complete no-op) but still
   * registers no-op `on('task', ...)` handlers so `cy.task()` calls from the
   * browser side never error with "no handler registered for task." */
  enabled?: boolean;
}

export interface ResolvedPluginConfig {
  token: string;
  apiEndpoint: string;
  environment: string;
  language: string;
  milestone: number | null;
  branch: string | null;
  commit: string | null;
  platform: Platform;
  framework: string;
  os?: string;
  browser?: string;
  properties?: Record<string, string>;
  ciProvider?: string;
  ciBuildNumber?: string;
  ciRunUrl?: string;
  ciPrNumber?: number;
  timeoutMs: number;
  retry: { max: number; baseDelayMs: number; maxDelayMs: number };
  failOnUploadError: boolean;
  attachScreenshots: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  debug: boolean;
  enabled: boolean;
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function envBool(...names: string[]): boolean | undefined {
  const raw = firstEnv(...names);
  if (raw === undefined) {
    return undefined;
  }
  return raw === 'true' || raw === '1';
}

function envInt(...names: string[]): number | undefined {
  const raw = firstEnv(...names);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Thrown when a required value (currently only `token`) can't be resolved.
 * Deliberately thrown synchronously at `qualflareCypress()` call time
 * (config-load time) rather than deferred to the final `after:run` POST —
 * failing fast before any spec runs wastes far less CI time than
 * discovering a misconfiguration only at the very end of the run. */
export class QualflareConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QualflareConfigError';
  }
}

/** Resolves the full plugin configuration from, in order: the explicit
 * `options` passed to `qualflareCypress()`, then `QUALFLARE_*` environment
 * variables, then `QF_*` (compat alias with the existing Go CLI, where an
 * equivalent exists), then a hardcoded default.
 *
 * Branch/commit precedence: `options.branch`/`.commit` (including an
 * explicit `null`, which is respected as "no auto-detection wanted" rather
 * than triggering the fallback tiers below it) > `QUALFLARE_BRANCH`/
 * `QF_BRANCH` env (and the commit equivalent) > CI-provider env vars > a
 * local `git` subprocess (`git-detect.ts`) > `null`. The subprocess tier is
 * skipped entirely — no `git` process is forked — once both branch and
 * commit are already resolved from options/env, mirroring
 * `qualflare-cli/internal/config/config.go`'s `DetectGit`'s early return.
 *
 * CI-metadata precedence (`ciProvider`/`ciBuildNumber`/`ciRunUrl`/
 * `ciPrNumber`): the corresponding `options.ci*` field, else `ci-detect.ts`'s
 * auto-detection (per-provider extraction table, falling back to the
 * `ci-info` package's ~70-provider free-text name).
 *
 * `deps` lets tests inject fake `detectGit`/`detectCi` implementations
 * instead of the real ones (which shell out to `git` and read the real
 * `process.env`/`ci-info` module state) — defaults to the real detectors,
 * so every production call site (`plugin/index.ts` calls `resolveConfig(options)`
 * with no second argument) is unaffected.
 */
export function resolveConfig(
  options: QualflareCypressOptions,
  deps: { detectGit?: () => GitInfo; detectCi?: () => CiMetadata } = {},
): ResolvedPluginConfig {
  const doDetectGit = deps.detectGit ?? detectGit;
  const doDetectCi = deps.detectCi ?? detectCi;

  const enabled = options.enabled ?? envBool('QUALFLARE_ENABLED') ?? true;

  const token = options.token ?? firstEnv('QUALFLARE_TOKEN', 'QF_TOKEN') ?? '';
  if (enabled && token === '') {
    throw new QualflareConfigError(
      'qualflare-cypress: no token configured. Set the `token` option or the QUALFLARE_TOKEN ' +
        '(or QF_TOKEN) environment variable, or pass `enabled: false` to disable this plugin.',
    );
  }

  const milestoneRaw = options.milestone !== undefined ? options.milestone : envInt('QUALFLARE_MILESTONE', 'QF_MILESTONE');
  const milestone = milestoneRaw !== undefined && milestoneRaw !== null && milestoneRaw >= 1 ? milestoneRaw : null;

  const envBranch = firstEnv('QUALFLARE_BRANCH', 'QF_BRANCH');
  const envCommit = firstEnv('QUALFLARE_COMMIT', 'QF_COMMIT');
  const needsGitDetection =
    (options.branch === undefined && envBranch === undefined) ||
    (options.commit === undefined && envCommit === undefined);
  const detectedGit = needsGitDetection ? doDetectGit() : {};

  const branch = options.branch !== undefined ? options.branch : (envBranch ?? detectedGit.branch ?? null);
  const commit = options.commit !== undefined ? options.commit : (envCommit ?? detectedGit.commit ?? null);

  const detectedCi = doDetectCi();
  const ciProvider = options.ciProvider ?? detectedCi.ciProvider;
  const ciBuildNumber = options.ciBuildNumber ?? detectedCi.ciBuildNumber;
  const ciRunUrl = options.ciRunUrl ?? detectedCi.ciRunUrl;
  const ciPrNumber = options.ciPrNumber ?? detectedCi.ciPrNumber;

  return {
    token,
    apiEndpoint: options.apiEndpoint ?? firstEnv('QUALFLARE_API_ENDPOINT') ?? 'https://api.qualflare.com',
    // `||` (truthy check), not `??`, for these three REQUIRED-non-empty wire
    // fields — matching `collect-builder.ts`'s `resolveOs`/`resolveBrowser`,
    // which already correctly treat an explicit `''` option as "not set."
    // `??` only falls back on `null`/`undefined`, so `environment: ''` would
    // previously win outright over the `'development'` default, silently
    // 400ing the whole launch (the server rejects an empty `environment`)
    // and — since `failOnUploadError` defaults `false` — failing the entire
    // upload with no visible error by default. Found via deep adversarial
    // self-review.
    environment: (options.environment || undefined) ?? firstEnv('QUALFLARE_ENVIRONMENT', 'QF_ENVIRONMENT') ?? 'development',
    language: (options.language || undefined) ?? firstEnv('QUALFLARE_LANGUAGE', 'QF_LANGUAGE') ?? 'en-US',
    milestone,
    branch,
    commit,
    platform: options.platform ?? 'web',
    framework: options.framework || 'cypress',
    os: options.os,
    browser: options.browser,
    properties: options.properties,
    ciProvider,
    ciBuildNumber,
    ciRunUrl,
    ciPrNumber,
    timeoutMs: options.timeoutMs ?? envInt('QUALFLARE_TIMEOUT_MS') ?? 120_000,
    retry: {
      max: options.retry?.max ?? envInt('QUALFLARE_RETRY_MAX', 'QF_RETRY_MAX') ?? 3,
      baseDelayMs: options.retry?.baseDelayMs ?? envInt('QUALFLARE_RETRY_BASE_DELAY_MS') ?? 1000,
      maxDelayMs: options.retry?.maxDelayMs ?? envInt('QUALFLARE_RETRY_MAX_DELAY_MS') ?? 30_000,
    },
    failOnUploadError: options.failOnUploadError ?? envBool('QUALFLARE_FAIL_ON_UPLOAD_ERROR') ?? false,
    attachScreenshots: options.attachScreenshots ?? envBool('QUALFLARE_ATTACH_SCREENSHOTS') ?? true,
    maxAttachmentBytes: options.maxAttachmentBytes ?? envInt('QUALFLARE_MAX_ATTACHMENT_BYTES') ?? 1_500_000,
    maxTotalAttachmentBytes:
      options.maxTotalAttachmentBytes ?? envInt('QUALFLARE_MAX_TOTAL_ATTACHMENT_BYTES') ?? 750_000,
    debug: options.debug ?? envBool('QUALFLARE_DEBUG', 'QF_DEBUG') ?? false,
    enabled,
  };
}
