# Native sharded-CI support via standardized report files

**Status:** Approved design, not yet implemented.
**Repos affected:** `qualflare-cypress`, `qualflare-cucumberjs`, `qualflare-cli` (this spec lives in
`qualflare-cypress` since that's where the work was scoped, but touches all three).
**Backend (`api-service`):** No changes required — see "Why no backend changes" below.

## Context / problem

Today, a sharded CI run (multiple separate `cypress run`/`cucumber-js` processes or machines)
produces N separate Launches by default, because each reporter accumulates results in memory for
one process and POSTs directly to `/collect` at run end — one POST, one Launch, no server-side
merge capability.

The existing workaround (`outputFile` + `qualflare-cli --shard`) already avoids the N-Launches
problem, but requires three manual steps from the user: configure `outputFile` with a
hand-templated unique path per shard, wire CI to upload/download those files as artifacts, and add
a separate final job that runs `qf ci collect --shard <files>`. This is real, working
infrastructure — the goal of this change is to make it require far less manual configuration, not
to replace its fundamentals.

## Goals

- A sharded run merges into one Launch without the user manually assigning each shard a unique
  output path or invoking a special merge mode.
- The non-sharded (single-process) case keeps working with a single `qf collect` step — no new
  distinction between "sharded" and "not sharded" from the user's perspective.
- Video attachments keep working (they were just added to both reporters, direct-POST-only) even
  though direct POST goes away.
- No backend changes, no new concept of a "partial" or "in-progress" Launch, no live progress UI.
  Results only appear once a human explicitly runs `qf collect` over finished output.

## Non-goals

- Live/incremental Launch visibility while shards are still running (explicitly rejected — see
  design log).
- Backward compatibility with today's direct-POST / `token` reporter config. Both packages are
  pre-1.0 with zero real adoption (published today); this is a clean breaking change.
- Changing how `--shard` works for other frameworks' native formats (JUnit XML, pytest, etc.) —
  unaffected by this change.

## Architecture overview

**Today:**
```
cypress run  →  reporter accumulates in memory  →  POST /collect (needs token)  →  1 Launch
```

**New:**
```
cypress run  →  reporter accumulates in memory  →  writes report dir (JSON + video files, no network)
                                                              ↓
                                          qf collect <dir>  →  POST /collect (needs token)  →  1 Launch
```

Every run, sharded or not, ends with a human (or a CI job) running `qf collect` over whatever the
reporter(s) wrote. Sharding stops being a special mode — it's just "more than one JSON file ended
up in the same directory."

## Why no backend changes

The wire contract already has everything needed:

- `launch.Case.ShardIndex *int` (`json:"shardIndex,omitempty"`) already exists — it's exactly the
  field `qualflare-cli`'s existing `--shard` flag (`tagShardsByFile`) stamps onto every case today,
  for any framework. Reporters can populate it directly; no new field required.
- `/collect` already accepts arbitrarily many suites/cases in one POST — merging N shards' worth of
  suites into one request is exactly what `--shard` already does today, just without needing to be
  told to do so via a flag.
- The only genuinely new piece — a reference to a not-yet-uploaded local video file — never reaches
  `/collect` at all (see below). It's resolved into a real `storageKey` by `qualflare-cli` before
  the POST happens, so the backend never sees anything it doesn't already understand.

## Reporter changes (`qualflare-cypress`, `qualflare-cucumberjs`)

### Output format

- `outputFile` (a single user-configured path) is replaced by `outputDir` (default
  `./qualflare-results`, override via plugin option or `QUALFLARE_OUTPUT_DIR`). This is now the
  *only* mode — there is no direct-POST mode anymore.
- Each process run writes its own uniquely-named JSON file into `outputDir` (e.g.
  `<timestamp>-<random>.json`), so multiple shards can safely write into the same directory without
  the user templating a shard index into a path themselves.
- Every case the reporter emits gets `shardIndex` populated from auto-detected shard info (see
  "Shard index auto-detection" below), or omitted entirely for a normal non-sharded run.
- A video attachment is copied byte-for-byte (`fs.copyFileSync`-equivalent — Allure's
  `FileSystemWriter.writeAttachmentFromPath` is the reference pattern; not read into memory) into
  the same `outputDir`, under a unique filename, and referenced from the JSON via `localVideoPath`
  (a path relative to the JSON file's own location, not absolute — see "Standardized report file
  format" below).

### Shard index auto-detection

Each reporter detects its own shard position from the signals already available to it:

- `qualflare-cucumberjs`: cucumber-js's own `--shard INDEX/TOTAL` CLI flag (already parsed by
  cucumber-js itself; the formatter can read it from the runtime environment/config it's handed).
- `qualflare-cypress`: no native Cypress shard concept exists, so this falls back to common CI
  matrix env vars (e.g. a GitHub Actions matrix index) — auto-detected the same way CI
  provider/build number/PR are already auto-detected today (see `docs/CONFIGURATION.md`'s existing
  detection table). If nothing is detected, `shardIndex` is simply omitted — a normal
  single-process run needs no shard concept at all.
- A manual override option remains available (e.g. `shardIndex` plugin option /
  `QUALFLARE_SHARD_INDEX`) for CI setups whose sharding signal isn't one of the auto-detected ones.

### Removed from reporter options

`token` / `QUALFLARE_TOKEN`, `uploadVideos`, `failOnUploadError` — all meaningless once the
reporter never makes a network call. `maxVideoBytes` **stays**: a cheap local pre-filter so the
reporter doesn't bother copying a video the server will reject anyway once `qf collect` tries to
upload it.

### Removed entirely

`src/http/client.ts` and all reporter-side upload/retry/backoff logic, in both packages. A reporter
never makes a network call again, in either package.

### Unchanged

CI/git/platform auto-detection (branch, commit, CI provider, browser/OS — all local), the full
`qualflare.*` metadata API (steps, labels, links, custom attachments, nested steps), the `enabled`
full-opt-out option.

## Standardized report file format

Reuses the existing `Collect` JSON shape verbatim — the same body `/collect` already accepts.
`outputFile` mode already just serializes this struct to disk today, so no new wire schema for
suites/cases/steps/labels/links/etc.

One addition, scoped to the file format only (never sent to `/collect` as-is):

```ts
interface Attachment {
  // ...existing fields (name, mimeType, content?, storageKey?, fileSize?, stepIndex?)...

  /** Set instead of `content`/`storageKey` when this attachment is a video the
   *  reporter copied into the same output directory as this JSON file, rather
   *  than uploading it itself. Relative to this JSON file's own location, not
   *  the CLI's cwd or an absolute path — matters once a merge pulls files from
   *  multiple shard subdirectories together. `qualflare-cli` resolves every
   *  `localVideoPath` into a real `storageKey`/`fileSize` via the presigned-URL
   *  upload flow before constructing the actual `/collect` request; this field
   *  never appears in that request. */
  localVideoPath?: string;
}
```

No wrapping/versioning envelope — kept minimal, consistent with `qf`'s existing content-based
format auto-detection (it already distinguishes this JSON shape from JUnit XML, TestNG, etc.
without a `--format` flag; nothing about that detection needs to change).

## `qualflare-cli` changes

### `qf collect <path>`

Accepts a file, a glob, or a directory (globs `*.json` inside, non-recursive — matching the
reporters' flat `outputDir` layout). This replaces the current single-file-argument form; existing
glob/multi-file usage for other frameworks is unaffected.

### Directory-based auto-merge

When more than one Qualflare-format report file is found (via directory expansion or multiple
explicit args), they are merged into **one Launch** automatically:

- Suites/cases from every file are combined into one request, same shape `--shard` already
  produces today.
- Each case's `shardIndex` comes from what the reporter already embedded — nothing is renumbered by
  file/argument order the way `tagShardsByFile` does today.
- No flag is required to opt into this — finding multiple report files *is* the signal.

### Stale-file caveat

Co-location is the *only* merge signal — there is no run identity check. If `outputDir` isn't
cleaned between runs (a local `cypress run` executed twice against the default
`./qualflare-results`, or a CI cache that persists the directory across builds), leftover JSON from
a previous run gets silently merged into the current one. This matches Allure's own convention
(`allure-results` is documented as something CI clears before each run) rather than inventing a new
problem; the fix is the same one Allure recipes use — document that `outputDir` should be removed
or created fresh at the start of each run, not a new dedup mechanism in the CLI.

### `--shard` flag: unchanged scope

Stays exactly as it is today, for exactly the case it exists for: other frameworks' native report
formats (JUnit XML, pytest, TestNG, ...) have no concept of an embedded shard index, so
file-argument-order tagging (`tagShardsByFile`) remains the only way to merge *those*. It becomes
unnecessary — not removed — for our own two reporters' JSON output, since that format now carries
its own shard index.

### Video upload

For every attachment with `localVideoPath` across every file being collected:

1. Resolve the path relative to *that specific JSON file's own directory* (not the CLI's cwd —
   necessary once a merge pulls files from different shard subdirectories together).
2. Request a presigned upload URL using the CLI's existing auth token (same token flow
   `qf login ci` / `qf ci collect` already uses — no new auth concept).
3. Upload the file; on success, replace the attachment's `localVideoPath` with a real
   `storageKey`/`fileSize` (the fields the backend already understands, from tonight's
   video-attachment backend work).
4. On failure (network error, oversized, unsupported format), skip the attachment with a logged
   warning and continue — fail-open, identical policy to what the reporters themselves did before
   this change, just relocated.

This is the CLI's only new capability: everything else (parsing, merging, tagging, POSTing) is the
`--shard` machinery already in `report_service.go` today, just triggered by file-count instead of a
flag.

## Versioning & migration

Both `@qualflare/cypress` and `@qualflare/cucumberjs` are pre-1.0 (`0.1.0`, published today) with
effectively zero real external adoption — a clean breaking change, no deprecation shim. Bump both
to `0.2.0` with an explicit CHANGELOG "BREAKING" entry:

- Direct POST removed; a reporter alone no longer uploads anything.
- `token` / `QUALFLARE_TOKEN` / `uploadVideos` / `failOnUploadError` options removed.
- `outputFile` renamed to `outputDir`, with different semantics (a directory, not a single path;
  always active, not opt-in).

`qualflare-cli` gets its own version bump for the new video-upload capability and directory-aware
`collect`.

Docs needing a full rewrite in both reporter repos: README's "Known limitations" section (the
sharding bullet becomes largely moot — see Open follow-up below), `docs/LIMITATIONS.md`'s "One
process = one Launch" section, `docs/CONFIGURATION.md`'s option table, and the quick-start/CI
example (every setup now needs a `qf collect` step, including the simple non-sharded case that
previously needed zero extra steps beyond setting a token in the reporter).

## Error handling

- **Reporter → disk write failure** (full disk, permissions): logged and swallowed, not thrown —
  same "never fail the user's test run over reporting infrastructure" philosophy the reporters
  already follow for upload failures today.
- **CLI → missing/malformed report file**: hard error, non-zero exit code. This is the CLI's actual
  job now; silently skipping a malformed file would be a much worse failure mode than it POSTing
  and getting a clear error.
- **CLI → video upload failure**: fail-open per attachment (skip + warn), as above.

## Testing strategy

- **Reporters** (unit): `outputDir` writing and unique-filename generation; video file copying
  (including the oversized/unsupported-format skip path); shard-index auto-detection from CI env
  and from the manual override option; confirming zero network calls are ever made.
- **`qualflare-cli`** (unit): directory-based multi-file discovery; merge + per-case `shardIndex`
  passthrough (not renumbered); `localVideoPath` resolution relative to each source file's own
  directory; presigned-upload fail-open behavior.
- **Integration** (one per reporter, extending the existing real-framework-run test): a real
  `cypress run` / `cucumber-js` invocation through to a real `qf collect` over the directory it
  produced, including at least one video attachment, asserting the final `/collect` POST body is
  correct end-to-end.

## Open follow-up (not blocking this spec)

The README "Known limitations" bullet about sharding needs new wording once this ships — it's no
longer "sharded setups get multiple Launches unless you manually merge," since merging is now the
default outcome of just running `qf collect` on the output directory. Exact wording is an
implementation-time doc detail, not a design decision, so it's left for the implementation plan
rather than specified here.
