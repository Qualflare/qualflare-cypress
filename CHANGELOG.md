# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Per-attempt execution history on every retried test, sent as `Case.attempts`.

  `collapseAttempts` already tracked every attempt of a retried test and then kept only the
  final one, so `retryCount`/`isFlaky` said a test retried while the reason it failed the
  first time was discarded — most visibly when the retry passed, which is exactly when the
  collapsed `error` is dropped too.

  Each attempt's status, duration and error is now sent individually, including the final
  one. A test that was not retried sends nothing, and steps/labels/attachments still come
  from the final attempt only (an abandoned attempt's step trace would misrepresent one
  execution as two). Requires an API that stores attempt history; older servers ignore the
  field.

## 0.3.0

### Added

- `metadata.runId` on every report, plus a `runId` option (`QUALFLARE_RUN_ID`) to set it
  explicitly. Every shard of one CI run resolves the same value (`GITHUB_RUN_ID`,
  `CI_PIPELINE_ID`, and so on); outside CI it is a per-process UUID.

  This is what lets `qf collect` tell the shards of the current run apart from a file left behind
  by an earlier one. Until now a stale report sitting in `outputDir` was merged into the launch
  silently — the launch looked entirely plausible and contained results nobody ran, which corrupts
  the history flaky-detection is built on. Requires `@qualflare/cli` v0.1.19 or newer, which
  refuses the merge and names the offending files; older CLIs ignore `runId` and merge as before.

### Changed

- The stale-file caveat in `README.md` and `docs/LIMITATIONS.md` documents what now actually
  happens, instead of asking you to remember to clear the directory.



- `src/plugin/video-uploader.ts` renamed to `video-writer.ts`. It has only exported
  `copyVideoAttachment` since 0.2.0 — it copies a file into `outputDir` and uploads nothing.
  Internal only; the bundled entry points are unchanged.
- `RELEASING.md` no longer tells the releaser to set `QUALFLARE_TOKEN` for the manual smoke
  test (this reporter has no token), and gains two checks learned the hard way: smoke-test the
  published tarball rather than the local build, and confirm the matching `@qualflare/cli`
  release is out first.

### Removed

- `src/http/` deleted entirely (`backoff.ts`, `errors.ts`, `idempotency.ts`). Nothing has
  imported these since 0.2.0 removed the HTTP client; they tree-shook out of the published bundle,
  so this changes no shipped behavior — it just stops the repo claiming to have an HTTP layer.
- `MAX_IDEMPOTENCY_KEY_CHARS`, whose only consumer was the deleted `idempotency.ts`.


- `QualflareConfigError` is no longer exported. It existed only to report an unresolvable `token`,
  which `0.2.0` removed — leaving a public error class that could never be thrown. Nothing can have
  a working `catch` on it, so this is breaking by letter only.

### Fixed

- `examples/basic/` updated for the `outputDir` model: its README documented the removed
  `QUALFLARE_TOKEN` upload flow, its `package.json` still pinned `@qualflare/cypress@^0.1.0`, and
  its config comment claimed a token was required. Shipped stale in `0.2.0`.
- CI's integration matrix no longer installs the matrix Cypress version incrementally
  (`npm ci` + `npm install --no-save cypress@X`), which trips npm's optional-dependency pruning bug
  ([npm/cli#4828](https://github.com/npm/cli/issues/4828)) and silently drops platform binaries.
- README now states the contributor Node floor (`>=20.1`, from developing against Cypress 15),
  which differs from the consumer floor (`>=18`, still valid for Cypress 12–14).

## 0.2.0 — BREAKING

- `peerDependencies.cypress` widened from `>=12.0.0 <15.0.0` to `>=12.0.0`. The upper bound made
  every new Cypress major a hard `npm install` failure (peer conflicts are errors, not warnings,
  in npm 7+) until a release of this package caught up — including Cypress 15, which is fully
  compatible. Verified against Cypress 15.21.1: typecheck, 190 unit tests, and the real
  `cypress run` integration suite all pass unchanged. CI's integration matrix gains a `^15.0.0`
  leg alongside 12/13/14.
- **Requires `qualflare-cli >= v0.1.16`**, the first release whose `qf collect` can parse the
  report directory this reporter writes. Older CLI versions will not recognize the output.
- Direct POST to `/collect` removed. This reporter now only ever writes a report file (and any
  video attachments) into `outputDir` — `qualflare-cli collect <outputDir>` is required to upload
  results, for every run, sharded or not.
- Removed options: `token`, `uploadVideos`, `failOnUploadError` (all meaningless once the reporter
  never makes a network call).
- `outputFile` renamed to `outputDir`: a directory, not a single file path, and always active
  rather than opt-in.
- Added `shardIndex` option (auto-detected from `QUALFLARE_SHARD_INDEX` when unset), stamped onto
  every case reported.

## [0.1.0] - Unreleased

Initial public release.

### Added

- Native Cypress reporter: suite/case results, real retry counts, and duration upload as one
  Launch per `cypress run`.
- Automatic screenshot attachment on failure.
- Command-log step traces (two levels of nesting, Cypress's own API limit).
- Author-facing `qualflare` metadata API: `label`, `link`, `tag`, `description`, `priority`,
  `parameter`, `step` (arbitrary nesting depth), `attachment` / `attachmentFromFile`.
- CI/git/browser/OS auto-detection with `QUALFLARE_*` environment variable overrides for every
  option.
- Dual ESM + CJS build with bundled type declarations.
