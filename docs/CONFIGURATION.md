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
| `environment` | `QUALFLARE_ENVIRONMENT` → `QF_ENVIRONMENT` | `development` | **The environment's uid (slug), not its display name** — see below. Must already exist in your Qualflare project (server returns 404 otherwise) — every project seeds `development`/`staging`/`production`/`qa` by default. |
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
| `attachScreenshots` | `QUALFLARE_ATTACH_SCREENSHOTS` | `true` | The `after:screenshot` hook is always registered regardless (Cypress expects it); this just controls whether captured screenshots are actually included in the report. |
| `maxAttachmentBytes` | `QUALFLARE_MAX_ATTACHMENT_BYTES` | `1500000` | Per-file cap (bytes, decoded size) — an oversized screenshot/attachment is skipped and logged, never silently truncated. |
| `maxTotalAttachmentBytes` | `QUALFLARE_MAX_TOTAL_ATTACHMENT_BYTES` | `750000` | Cumulative cap across the whole run — kept conservative because production currently has an effective ~1MB request-body-limit bug (see [`docs/LIMITATIONS.md`](./LIMITATIONS.md)); raise once that's confirmed fixed server-side. |
| `maxVideoBytes` | `QUALFLARE_MAX_VIDEO_BYTES` | `50000000` | Per-video cap (bytes), checked via `fs.statSync` before the file is copied into `outputDir` — a cheap local pre-filter so an oversized video is never copied at all, only for `qualflare-cli`'s later upload attempt to get rejected by the server's own 50MB cap. |
| `videoOnFailureOnly` | `QUALFLARE_VIDEO_ON_FAILURE_ONLY` | `true` | Cypress records one video per spec. By default it is only attached when a case in that spec failed — a green spec's recording has little diagnostic value. `false` attaches it anyway, to the spec's first case. Uploading it is separately opt-in via `qf collect --upload-artifacts=video`. |
| `outputDir` | `QUALFLARE_OUTPUT_DIR` | `./qualflare-results` | Directory `after:run` writes this process's report file (and any video attachments) into. Always active — this reporter never uploads anything itself; `qualflare-cli collect <outputDir>` reads whatever ends up here. Every JSON file is uniquely named, so multiple shards can safely write into the same directory without colliding — see [`docs/LIMITATIONS.md`](./LIMITATIONS.md). |
| `shardIndex` | `QUALFLARE_SHARD_INDEX` | unset | This process's 0-based position among parallel shards of the same CI run, stamped onto every case it reports. No shard concept is auto-detected beyond this env var — set it yourself from your CI's own matrix index (e.g. `QUALFLARE_SHARD_INDEX: ${{ matrix.shard }}` in a GitHub Actions matrix). A normal single-process run needs no shard concept at all and can leave this unset — see [`docs/LIMITATIONS.md`](./LIMITATIONS.md). |
| `runId` | `QUALFLARE_RUN_ID` | CI run id, else a per-process UUID | Identifies the run a report belongs to. Every shard of one CI run resolves the same value (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, …), so `qf collect` can tell shards of this run apart from a file left over by an earlier one and refuse to merge them. Needs `@qualflare/cli` v0.1.19+. Only set it yourself if your CI is not auto-detected and you shard. |
| `enabled` | `QUALFLARE_ENABLED` | `true` | `false` fully disables accumulation and report writing (a complete no-op) but still registers no-op Cypress task handlers so `cy.task()` calls from the browser side never error. |

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


## `environment` is matched by uid, not display name

The server resolves this value against the environment's **uid** (its slug), never the name shown
in the UI:

```sql
SELECT * FROM environments WHERE project_id = $1 AND uid = $2;
```

Every project is seeded with four environments whose uid is lowercase and whose display name is
capitalized:

| Shown in the UI | Value to use here |
|---|---|
| Development | `development` |
| Staging | `staging` |
| Production | `production` |
| QA | `qa` |

So the environment you see as **Staging** is `staging` here. This is worth stating plainly because
the obvious reading of "must already exist" is that a 404 means you forgot to create it — when in
fact it exists, and the uid simply is not what the UI showed you.

It also fails late. This plugin makes no network calls, so a wrong value cannot fail during
`cypress run` — the run completes and writes a valid report. The 404 arrives afterwards, from
`qualflare-cli collect`, pointing at the CLI rather than at the config line that caused it.

If `collect` returns a 404 for an environment you can plainly see in the project, open its settings
and use the uid shown there.
