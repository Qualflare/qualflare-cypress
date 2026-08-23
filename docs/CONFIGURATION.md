# Configuration

Every value below can be set as a plugin option (passed to `qualflareCypress(on, config, options)`
in your `cypress.config.ts`) or via an environment variable. Precedence, everywhere it applies:

**plugin option > `QUALFLARE_*` env var > `QF_*` env var (compat alias with the `qf` CLI, where an
equivalent exists) > auto-detection (branch/commit/CI metadata/browser/OS only) > hardcoded default.**

An explicit `branch: null` / `commit: null` option is respected as "no auto-detection wanted," not
treated as "unset" — it skips the CI-env-var and `git` subprocess fallback tiers entirely.

This table reflects the actual current option set in `src/plugin/resolve-config.ts` — regenerate it
from that file (not from memory) if the two ever drift.

| Option | Env var(s) | Default | Notes |
|---|---|---|---|
| `token` | `QUALFLARE_TOKEN` → `QF_TOKEN` | *(required)* | Throws a `QualflareConfigError` at `qualflareCypress()` call time if unresolved and `enabled` isn't `false` — fails before any spec runs. |
| `apiEndpoint` | `QUALFLARE_API_ENDPOINT` | `https://api.qualflare.com` | |
| `environment` | `QUALFLARE_ENVIRONMENT` → `QF_ENVIRONMENT` | `development` | Must already exist in your Qualflare project (server returns 404 otherwise) — every project seeds `development`/`staging`/`production`/`qa` by default. |
| `language` | `QUALFLARE_LANGUAGE` → `QF_LANGUAGE` | `en-US` | BCP47. |
| `milestone` | `QUALFLARE_MILESTONE` → `QF_MILESTONE` | `null` | A milestone sequence number; values `< 1` are treated as unset. |
| `branch` | `QUALFLARE_BRANCH` → `QF_BRANCH` | auto-detected, else `null` | See [Branch/commit auto-detection](#branchcommit-auto-detection) below. |
| `commit` | `QUALFLARE_COMMIT` → `QF_COMMIT` | auto-detected, else `null` | Same chain as `branch`. |
| `platform` | — | `"web"` | Escape hatch only — Cypress is always `"web"` in practice. |
| `framework` | — | `"cypress"` | Escape hatch for forks/wrappers of this package. |
| `os` | — | auto-detected from Cypress's `before:run` system info, else omitted | |
| `browser` | — | auto-detected from Cypress's `before:run` browser info, else omitted | |
| `properties` | — | `undefined` | Arbitrary `Record<string,string>` passthrough onto the launch. |
| `ciProvider` | — | auto-detected | Free text (no enum) — an unrecognized CI provider is never rejected. See [CI metadata auto-detection](#ci-metadata-auto-detection). |
| `ciBuildNumber` | — | auto-detected | |
| `ciRunUrl` | — | auto-detected | |
| `ciPrNumber` | — | auto-detected | Must be a positive integer; an unparsable/invalid value is omitted, never sent as garbage. |
| `timeoutMs` | `QUALFLARE_TIMEOUT_MS` | `120000` | Per-attempt request timeout, in milliseconds (not a duration string). |
| `retry.max` | `QUALFLARE_RETRY_MAX` → `QF_RETRY_MAX` | `3` | |
| `retry.baseDelayMs` | `QUALFLARE_RETRY_BASE_DELAY_MS` | `1000` | |
| `retry.maxDelayMs` | `QUALFLARE_RETRY_MAX_DELAY_MS` | `30000` | |
| `failOnUploadError` | `QUALFLARE_FAIL_ON_UPLOAD_ERROR` | `false` | When `false` (default), a Qualflare upload failure is logged but never fails an otherwise-green `cypress run`. Set `true` for stricter CI gating. |
| `attachScreenshots` | `QUALFLARE_ATTACH_SCREENSHOTS` | `true` | The `after:screenshot` hook is always registered regardless (Cypress expects it); this just controls whether captured screenshots are actually queued for upload. |
| `maxAttachmentBytes` | `QUALFLARE_MAX_ATTACHMENT_BYTES` | `1500000` | Per-file cap (bytes, decoded size) — an oversized screenshot/attachment is skipped and logged, never silently truncated. |
| `maxTotalAttachmentBytes` | `QUALFLARE_MAX_TOTAL_ATTACHMENT_BYTES` | `750000` | Cumulative cap across the whole run — kept conservative because production currently has an effective ~1MB request-body-limit bug (see [`docs/LIMITATIONS.md`](./LIMITATIONS.md)); raise once that's confirmed fixed server-side. |
| `debug` | `QUALFLARE_DEBUG` → `QF_DEBUG` | `false` | Logs request/response details to stderr with the token redacted before any log line is constructed. |
| `enabled` | `QUALFLARE_ENABLED` | `true` | `false` fully disables accumulation and upload (a complete no-op) but still registers no-op Cypress task handlers so `cy.task()` calls from the browser side never error. |

## Branch/commit auto-detection

When not set via option or `QUALFLARE_*`/`QF_*` env var, `branch`/`commit` are resolved from, in order:
1. CI-provider environment variables: `GITHUB_REF_NAME`/`GITHUB_SHA`, `CI_COMMIT_REF_NAME`/`CI_COMMIT_SHA` (GitLab), `BITBUCKET_BRANCH`/`BITBUCKET_COMMIT` — the same chain `qualflare-cli` uses.
2. A local `git` subprocess (`git symbolic-ref --short -q HEAD` / `git rev-parse HEAD`), resolved through `PATH`. Non-fatal — any error (including a detached `HEAD`) resolves to unavailable, never throws.
3. `null`.

The `git` subprocess is skipped entirely (no process forked) once both branch and commit are already resolved from an earlier tier.

## CI metadata auto-detection

`ciProvider` comes from the [`ci-info`](https://www.npmjs.com/package/ci-info) package (~70 providers detected from environment variables). `ciBuildNumber`/`ciRunUrl`/`ciPrNumber` are extracted via a small explicit per-provider map for the providers below; an unrecognized provider still gets `ciProvider` from `ci-info`, with the other three fields simply omitted.

| Provider | Build number | Run URL | PR number |
|---|---|---|---|
| GitHub Actions | `GITHUB_RUN_NUMBER` | constructed from `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`/`GITHUB_RUN_ID` | parsed from `GITHUB_REF` (`refs/pull/<n>/merge`) |
| GitLab CI | `CI_PIPELINE_IID` | `CI_PIPELINE_URL` | `CI_MERGE_REQUEST_IID` |
| CircleCI | `CIRCLE_BUILD_NUM` | `CIRCLE_BUILD_URL` | `CIRCLE_PR_NUMBER` |
| Buildkite | `BUILDKITE_BUILD_NUMBER` | `BUILDKITE_BUILD_URL` | parsed from `BUILDKITE_PULL_REQUEST` |
| Jenkins | `BUILD_NUMBER` | `BUILD_URL` | — |
| Azure Pipelines | `BUILD_BUILDID` | constructed from `SYSTEM_TEAMFOUNDATIONCOLLECTIONURI` + project + build id | `SYSTEM_PULLREQUEST_PULLREQUESTNUMBER` |
| Bitbucket Pipelines | `BITBUCKET_BUILD_NUMBER` | constructed from `BITBUCKET_GIT_HTTP_ORIGIN` + pipeline path | `BITBUCKET_PR_ID` |

A `ci*` option always overrides auto-detection for that specific field, independent of the others (e.g. you can override just `ciRunUrl` while leaving `ciProvider`/`ciBuildNumber`/`ciPrNumber` auto-detected).
