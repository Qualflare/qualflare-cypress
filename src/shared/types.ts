/**
 * The Qualflare `/api/v1/collect` wire contract.
 *
 * These interfaces mirror `api-service/internal/core/domain/launch/launch.go`
 * field-for-field (JSON key names, optionality, and string-union values) as
 * verified against the live, deployed source. Do not add, rename, or change
 * the optionality of a field here without re-verifying against that file —
 * a mismatch either 400s the request or silently drops data server-side.
 *
 * This file is imported by BOTH the browser-side support script and the
 * Node-side plugin (see the isomorphic-boundary rule in eslint.config.js) —
 * it must never import anything itself, Node or browser.
 */

/** Every `duration` field in this contract is a raw integer number of
 * NANOSECONDS, with no unit marker on the wire. Cypress/Mocha report
 * milliseconds — always convert with `msToNs()` (see `./duration.ts`)
 * before assigning into one of these fields. */
export type NanosecondDuration = number;

export type Platform = 'android' | 'ios' | 'desktop' | 'web' | 'api';

export type CaseStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'error'
  | 'timeout'
  | 'aborted'
  | 'pending';

export type FrameworkCategory = 'unit' | 'bdd' | 'e2e' | 'api' | 'security' | 'generic';

export type CasePriority = 'low' | 'medium' | 'high' | 'critical';

export type LinkType = 'issue' | 'tms' | 'custom';

export interface Metadata {
  version: string;
  timestamp: string;
  cliName: string;
}

export interface Label {
  /** Required, max 128 chars. Allure-style arbitrary label name — epic/feature/story/owner/severity
   * are just conventional names, not separate fields. */
  name: string;
  /** Required, max 512 chars. */
  value: string;
}

export interface Link {
  /** Required. A small, server-owned closed taxonomy — not open text. */
  type: LinkType;
  /** Optional, max 255 chars. */
  name?: string;
  /** Required, must be a valid URL, max 2048 chars. */
  url: string;
}

export interface Parameter {
  name: string;
  value?: string;
  /** Display hint ONLY — the server does not redact this value. Do not treat
   * this as real secret protection. */
  masked?: boolean;
}

export interface Step {
  name: string;
  keyword?: string;
  /** Reuses the Case status vocabulary. */
  status: CaseStatus | string;
  /** NANOSECONDS — see `NanosecondDuration`. */
  duration: NanosecondDuration;
  error?: string;
  location?: string;
  /** 0-based index into the SAME Case's `steps[]` array identifying this
   * step's parent, for nested/hierarchical steps. Omit for a root step.
   * The server drops an out-of-range or cycle-forming value to root rather
   * than rejecting the request — but a well-behaved client shouldn't rely
   * on that. Server caps total steps per case at 1000. */
  parentIndex?: number;
  /** Server caps at 50 parameters per step. */
  parameters?: Parameter[];
}

export interface Attachment {
  /** Required, max 255 chars. */
  name: string;
  /** Optional, max 1024 chars — informational only, never fetched server-side. */
  path?: string;
  /** Optional, max 255 chars. */
  mimeType?: string;
  /** Base64-encoded content, max 2,097,152 characters (~1.5MB decoded binary).
   * Inline only — there is no external/blob-URL attachment support yet. */
  content?: string;
  /** 0-based index into the Case's `steps[]` this attachment belongs to.
   * Omit for a case-level (not step-level) attachment. */
  stepIndex?: number;
}

export interface Case {
  /** Required. A stable per-test identifier used for flaky-history matching
   * across separate runs — must stay the same for what a human would call
   * "the same test" across renames you want tracked together. */
  id: string;
  /** Required, 1-255 chars. */
  name: string;
  /** Max 255 chars. */
  className?: string;
  /** Max 10000 chars. */
  description?: string;
  status: CaseStatus;
  /** NANOSECONDS — see `NanosecondDuration`. */
  duration: NanosecondDuration;
  retryCount?: number;
  isFlaky?: boolean;
  /** Truncated server-side at 65536 runes, never validation-rejected — send
   * the full error/stack text, don't pre-truncate. */
  error?: string;
  /** Unrecognized values are silently normalized/dropped server-side, never
   * rejects the request. */
  priority?: CasePriority;
  /** Max 64 items, each max 255 chars. */
  tags?: string[];
  properties?: Record<string, string>;
  /** Max 50 items. */
  attachments?: Attachment[];
  /** Server caps at 1000 items and truncates individual fields — never
   * validation-rejected, send freely. */
  steps?: Step[];
  /** Not validated; the server drops an out-of-range value rather than
   * rejecting the request. */
  shardIndex?: number;
  /** RFC3339. */
  startedAt?: string;
  /** Max 100 items. */
  labels?: Label[];
  /** Max 20 items. */
  links?: Link[];
}

export interface Suite {
  /** Required, 1-255 chars. One Suite per Cypress spec file. */
  name: string;
  category?: FrameworkCategory;
  assertions?: number;
  /** NANOSECONDS — see `NanosecondDuration`. */
  duration: NanosecondDuration;
  /** RFC3339. */
  timestamp?: string;
  /** Max 64 chars. Per-suite override of the launch-level `browser` — omit
   * to inherit the launch value. */
  browser?: string;
  /** Max 64 chars. Per-suite override of the launch-level `os`. */
  os?: string;
  properties?: Record<string, string>;
  /** Max 5000 items. */
  cases: Case[];
}

export interface Collect {
  /** Required, 1-100 chars. */
  framework: string;
  platform: Platform;
  /** Required, 1-100 chars. */
  os: string;
  /** Max 64 chars. */
  browser: string;
  /** ALWAYS present as value-or-null on the wire — never omit this key. */
  branch: string | null;
  /** ALWAYS present as value-or-null on the wire — never omit this key. */
  commit: string | null;
  /** Required, 1-100 chars. Must already exist server-side (404 if not) —
   * every project seeds `development`/`staging`/`production`/`qa` by
   * default. */
  environment: string;
  /** Required, BCP47 (e.g. "en-US"). */
  language: string;
  /** ALWAYS present as value-or-null on the wire — never omit this key. */
  milestone: number | null;
  metadata: Metadata | null;
  properties?: Record<string, string>;
  /** Max 2000 items. */
  suites: Suite[];
  /** Max 64 chars. Free text, no enum — an unrecognized CI provider must
   * never reject the request. */
  ciProvider?: string;
  /** Max 128 chars. */
  ciBuildNumber?: string;
  /** Must be a valid URL, max 2048 chars. */
  ciRunUrl?: string;
  /** Must be >= 1. */
  ciPrNumber?: number;
}

/** The server's success response body for `POST /api/v1/collect` (HTTP 201). */
export interface CollectResult {
  seq: number;
}

/** One entry in the server's validation-failure `fields[]` array. */
export interface ApiFieldError {
  field: string;
  rule?: string;
  message?: string;
}

/** The server's error envelope: `{code, message, fields, request_id}`
 * (plus a legacy `error` key some older responses may still carry). */
export interface ApiErrorResponse {
  code?: string;
  message?: string;
  fields?: ApiFieldError[];
  request_id?: string;
  /** Legacy/back-compat key — mirrors the Go CLI's `ErrorResponse.Error` fallback. */
  error?: string;
}
