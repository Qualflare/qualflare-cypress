# Known limitations

These are real, current constraints of `@qualflare/cypress` v1 — documented deliberately rather than
discovered by surprise. Several stem from Qualflare backend capabilities that don't exist yet;
others are inherent to how Cypress exposes information to a reporter.

## Video attachments

Video attachments (`.mp4`, `.webm`, `.mov`) are never uploaded by this reporter — it only copies the
file locally into `outputDir`, alongside the report JSON, and references it via the JSON's
`localVideoPath` field. [`qualflare-cli`](https://github.com/Qualflare/qualflare-cli) is what
resolves `localVideoPath` into a real upload (its own presigned-URL flow to R2) once it runs
`collect` against that directory. Two sources:

- Cypress's own per-spec recording (`after:spec`'s `results.video`), copied and attached to the
  first FAILING case in that spec — only when at least one case failed (an all-passing spec's video
  has little diagnostic value and isn't copied). Since Cypress records one video per spec, not per
  test, there is no exact owning case; attaching to the first failure avoids double-counting the same
  object's bytes against workspace storage quota, which attaching to every failing case would.
- `qualflare.attachmentFromFile()` called with a video path, copied and attached to whichever test
  called it, like any other file attachment.

Controlled by `maxVideoBytes` (default 50MB, matching the server's own cap) — checked via
`fs.statSync` before any file is copied, so an oversized video is never copied just to be rejected
later by `qualflare-cli`'s own upload attempt. A video that fails to copy (oversized, unsupported
format, or an unreadable source file) is skipped with a logged warning, the same fail-open behavior
as any other attachment — it never fails the `cypress run` itself.

## One `cypress run` process = one report file (until `qualflare-cli collect` runs)

Qualflare's `/api/v1/collect` endpoint still creates exactly one new Launch per request, with no
incremental or merge capability server-side — but this reporter no longer calls it. Every
`cypress run` process accumulates its own spec results in memory and, at `after:run`, writes them to
exactly one uniquely-named Collect JSON file in `outputDir` — nothing is merged and nothing is
uploaded by the reporter itself. Merging (when there's anything to merge) is entirely
`qualflare-cli`'s job, performed once, at collect time.

### Merging shards into one Launch

Point every shard's `cypress run` at the same shared `outputDir` (a CI cache path, or a directory an
artifact-download step assembles) — no path templating or unique-filename bookkeeping needed on your
end, since each process already writes its own uniquely-named file. Every case the reporter emits
carries a `shardIndex` (auto-detected from the `QUALFLARE_SHARD_INDEX` env var when set — see
[`docs/CONFIGURATION.md`](./CONFIGURATION.md)), passed straight through by `qualflare-cli`, never
renumbered.

Once every shard has run, collect the directory once:

```sh
qf my-project collect ./qualflare-results
```

Finding more than one report file in `outputDir` **is** the merge signal for this reporter's own
output — no `--shard` flag needed (`--shard` still exists for frameworks whose native report format
has no embedded shard index, e.g. JUnit XML).

GitHub Actions example (a matrix job per shard sharing one artifact, then a final job that collects
it):

```yaml
jobs:
  test:
    strategy:
      matrix:
        # 0-based to match shardIndex's documented semantics.
        shard: [0, 1, 2, 3]
    steps:
      - run: npx cypress run
        env:
          QUALFLARE_SHARD_INDEX: ${{ matrix.shard }}
      - uses: actions/upload-artifact@v4
        with:
          name: qualflare-results-${{ matrix.shard }}
          path: qualflare-results/

  upload:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: qualflare-results-*
          path: qualflare-results
          merge-multiple: true
      - run: |
          npm install -g @qualflare/cli
          qf login my-project "$QF_TOKEN" --force
          qf my-project collect ./qualflare-results
        env:
          QF_TOKEN: ${{ secrets.QF_TOKEN }}
```

`qf` auto-detects this reporter's JSON output from its content — no `--format` flag needed.

### Stale files are refused, not merged

Each report carries `metadata.runId` — the identifier every shard of one run shares and different
runs do not (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, and so on; a per-process UUID outside CI). If
`collect` finds files from more than one run it refuses to upload and names them:

```
Error: 2 different runs found in the report files:
    run 17244102887: 1 file(s)  (stale.json)
    run 17244981923: 2 file(s)  (shard-0.json, shard-1.json)
  A stale file from an earlier run would be merged into this launch.
  Clear the output directory before each run, or pass --allow-mixed-runs to upload anyway
```

Clearing `outputDir` at the start of each run is still the tidier habit — in CI it is usually free,
since the workspace is fresh — but forgetting now costs a failed upload rather than a launch
quietly containing results nobody ran.

Needs `@qualflare/cli` v0.1.19 or newer. An older CLI ignores `runId` and merges as before.

## Command-log step nesting is two levels only

Cypress's command log exposes exactly one typed nesting signal: `LogConfig.type: 'parent' | 'child'`
(verified directly against Cypress 14.5.4's shipped type declarations — no arbitrary-depth
group/parent-graph API exists in the typed surface). Auto-captured steps therefore nest at most one
level deep: a "parent" command's log entry becomes a root step, and any "child" entries under it
become that step's direct children — never grandchildren.

`qualflare.step()` (the manual, author-facing API) is not subject to this limit — it tracks its own
independent nesting stack and supports arbitrary depth, since it doesn't rely on Cypress's
command-log signal at all. Its nesting stack is pushed **synchronously** when `qualflare.step()` is
called (not deferred into the Cypress command queue) — this is deliberate and required: `fn`'s body
runs synchronously immediately after `step()` is called, so any `qualflare.parameter()` or nested
`qualflare.step()` call made directly inside it needs the stack already updated to see the correct
currently-open step. One consequence: a manual step's *start* time is when `step()` was called, not
the exact moment its wrapped commands begin executing — see the next section.

## Step timing is an approximation

There is no authoritative per-command elapsed-time field in Cypress's typed command-log API. An
auto-captured step's duration is measured as wall-clock time between when the log entry was first
seen (`log:added`) and the last update observed for it (`log:changed`, debounced internally by
Cypress) — a reasonable approximation, not precise instrumentation.

A manually-declared step (`qualflare.step()`) has its start time captured when `step()` is
JS-called (see the note above on why this must be synchronous) rather than the exact Cypress-queue
moment its first wrapped command actually executes — its end time, by contrast, is captured
precisely, once its wrapped commands genuinely finish. If there's a gap between when `step()` is
called and when its wrapped commands actually reach the front of Cypress's command queue (e.g. other
already-queued work ahead of it), that gap is counted toward the step's reported duration.

## `qualflare.parameter()` outside a step has no masking

The wire contract has no top-level `Parameter[]` on a `Case` — only `Step.parameters` exists. A
`qualflare.parameter()` call made while a `qualflare.step()` is open attaches to that step's
parameters (masking respected); called outside any step, it becomes a `Case.properties` entry
instead (the only test-level key/value bag the wire contract offers) — and `masked` has no analog on
a plain string map, so it's silently ignored in that case. This is a real, documented limitation, not
a bug.

## Per-case/per-attachment caps are independent, not pooled

`maxAttachmentBytes` (per file) and `maxTotalAttachmentBytes` (per run) govern screenshots and
Node-resolved `attachmentFromFile()` calls. The `MAX_ATTACHMENTS_PER_CASE` count cap on manually
attached content (`qualflare.attachment()`/`attachmentFromFile()`) is enforced independently of how
many screenshots a test also captured in the same run — the combined total across both sources isn't
currently capped as one pool.

Similarly, the command-log step cap and the manual-step cap (`qualflare.step()`) each track their own
count against the same limit value, rather than sharing one combined budget per test.

## Noise-filtering on command-log steps is a simple heuristic

Not every Cypress internal log entry becomes a step — entries with an empty `name` are filtered out,
which is a deliberately simple heuristic (no reliably typed signal exists to distinguish
user-meaningful commands/assertions from Cypress's internal bookkeeping entries). This may need
refinement once exercised against real command-log output from a variety of live Cypress projects.
