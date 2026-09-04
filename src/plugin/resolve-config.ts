import { randomUUID } from 'node:crypto';

import { MAX_VIDEO_UPLOAD_BYTES } from '../shared/constants.js';
import type { Platform } from '../shared/types.js';
import { detectCi, type CiMetadata } from './ci-detect.js';
import { detectGit, type GitInfo } from './git-detect.js';

/** Options passed to `qualflareCypress(on, config, options)` in the user's
 * `cypress.config.ts`. Every field here also has an environment-variable
 * override — see the precedence table in the README / plan. */
export interface QualflareCypressOptions {
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
  /** Identifier shared by every shard of one run, written into the report as
   * `metadata.runId`. `qualflare-cli collect` groups files by it and refuses
   * to merge a stale report from an earlier run into this launch.
   *
   * Auto-detected from CI. Outside CI it falls back to a per-process UUID,
   * which is correct there: every local run is a distinct run, so a leftover
   * file is still caught. */
  runId?: string;
  attachScreenshots?: boolean;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  /** Per-video byte cap, checked before upload (via `fs.statSync`, never by
   * reading the file first). Default 50MB, matching the server's own hard
   * cap — raising this past 50MB only wastes an upload attempt the server
   * will reject. */
  maxVideoBytes?: number;
  /** When true (the default), a spec's video is only attached if a test in it
   * failed. False attaches an all-passing spec's video too, to the first case
   * in the spec. The upload itself is gated separately by the CLI's
   * `--upload-artifacts`. */
  videoOnFailureOnly?: boolean;
  /** `false` fully disables accumulation/POST (a complete no-op) but still
   * registers no-op `on('task', ...)` handlers so `cy.task()` calls from the
   * browser side never error with "no handler registered for task." */
  enabled?: boolean;
  /** Directory `after:run` writes this process's report file (and any video
   * attachments) into. Default `./qualflare-results`. Always active — this
   * reporter never uploads anything itself; `qualflare-cli` reads whatever
   * ends up in this directory. Every JSON file this process writes is
   * uniquely named, so multiple shards can safely share one `outputDir`
   * without colliding — see docs/LIMITATIONS.md. */
  outputDir?: string;
  /** This process's 0-based position among parallel shards of the same CI
   * run, stamped onto every case it reports. Resolved only from this option
   * or the `QUALFLARE_SHARD_INDEX` env var — no shard concept is
   * auto-detected beyond that (set it yourself from your CI's own matrix
   * index; see docs/CONFIGURATION.md). A normal single-process run needs no
   * shard concept at all and can leave this unset. */
  shardIndex?: number;
}

export interface ResolvedPluginConfig {
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
  runId: string;
  attachScreenshots: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxVideoBytes: number;
  videoOnFailureOnly: boolean;
  enabled: boolean;
  outputDir: string;
  shardIndex?: number;
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
  const outputDir = options.outputDir || firstEnv('QUALFLARE_OUTPUT_DIR') || './qualflare-results';
  const shardIndex = options.shardIndex ?? envInt('QUALFLARE_SHARD_INDEX');

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

  // Never empty on purpose: `qf collect` treats a report with no runId as
  // "unknown run" and never lets it block a merge, so defaulting to '' would
  // quietly opt local runs out of the very check this exists for.
  const runId = options.runId ?? firstEnv('QUALFLARE_RUN_ID') ?? detectedCi.ciRunId ?? randomUUID();

  return {
    // `||` (truthy check), not `??`, for these three REQUIRED-non-empty wire
    // fields — matching `collect-builder.ts`'s `resolveOs`/`resolveBrowser`,
    // which already correctly treat an explicit `''` option as "not set."
    // `??` only falls back on `null`/`undefined`, so `environment: ''` would
    // previously win outright over the `'development'` default, silently
    // 400ing the whole launch (the server rejects an empty `environment`)
    // and — since this process no longer attempts uploads — the error would
    // be deferred until qualflare-cli tries to upload.
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
    runId,
    attachScreenshots: options.attachScreenshots ?? envBool('QUALFLARE_ATTACH_SCREENSHOTS') ?? true,
    // 5MB per attachment, 10MB per run. These were 1.5MB/750KB while every
    // attachment was base64-inlined into /collect's 10MB body, where they
    // competed with the test results — and since collect merges every shard into
    // ONE request, the per-run number had to assume it was one of many.
    //
    // @qualflare/cli v0.1.22+ uploads attachments out of band and references a
    // storageKey, so the body no longer grows with them and these numbers only
    // bound the report file on disk. REQUIRES that CLI: an older one still
    // inlines, and these limits would push it past the body limit and fail the
    // whole launch. Still bounded rather than unlimited, so the worst case is
    // one launch and not an out-of-memory.
    maxAttachmentBytes: options.maxAttachmentBytes ?? envInt('QUALFLARE_MAX_ATTACHMENT_BYTES') ?? 5_000_000,
    maxTotalAttachmentBytes:
      options.maxTotalAttachmentBytes ?? envInt('QUALFLARE_MAX_TOTAL_ATTACHMENT_BYTES') ?? 10_000_000,
    maxVideoBytes: options.maxVideoBytes ?? envInt('QUALFLARE_MAX_VIDEO_BYTES') ?? MAX_VIDEO_UPLOAD_BYTES,
    videoOnFailureOnly: options.videoOnFailureOnly ?? envBool('QUALFLARE_VIDEO_ON_FAILURE_ONLY') ?? true,
    enabled,
    outputDir,
    shardIndex,
  };
}
