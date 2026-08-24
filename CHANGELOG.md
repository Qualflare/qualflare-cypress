# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 — BREAKING

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
