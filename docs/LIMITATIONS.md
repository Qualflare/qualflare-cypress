# Known limitations

These are real, current constraints of `@qualflare/cypress` v1 — documented deliberately rather than
discovered by surprise. Several stem from Qualflare backend capabilities that don't exist yet;
others are inherent to how Cypress exposes information to a reporter.

## Video upload

Video attachments (`.mp4`, `.webm`, `.mov`) upload to R2 via a presigned-URL flow, separate from the
inline-base64 path small attachments (screenshots) use — a typical video is far too large to inline
in the `/collect` request body. Two sources:

- Cypress's own per-spec recording (`after:spec`'s `results.video`), uploaded and attached to the
  first FAILING case in that spec — only when at least one case failed (an all-passing spec's video
  has little diagnostic value and isn't uploaded). Since Cypress records one video per spec, not per
  test, there is no exact owning case; attaching to the first failure avoids double-counting the same
  R2 object's bytes against workspace storage quota, which attaching to every failing case would.
- `qualflare.attachmentFromFile()` called with a video path, uploaded and attached to whichever test
  called it, like any other file attachment.

Controlled by two options: `uploadVideos` (default `true`) and `maxVideoBytes` (default 50MB,
matching the server's own cap — checked via `fs.statSync` before any upload attempt). A video that
fails to upload (oversized, unsupported format, or a network/API error) is skipped with a logged
warning, the same fail-open behavior as any other attachment — it never fails the run, independent of
`failOnUploadError` (which is scoped to the final `/collect` POST, not to attachment resolution).

## One `cypress run` process = one Launch (unless you merge sharded runs)

Qualflare's `/api/v1/collect` endpoint creates exactly one new Launch per request, with no
incremental or merge capability server-side. This reporter accumulates every spec file's results in
memory for the lifetime of one `cypress run` process and uploads them in a single POST at
`after:run`.

If your CI shards specs across **multiple separate `cypress run` processes or machines**, each shard
uploads its own separate Launch by default — you will see N Launches for one CI run, not one
combined Launch.

### Merging shards into one Launch

Set `outputFile` (or `QUALFLARE_OUTPUT_FILE`) instead of relying on the default POST-per-process
behavior: the reporter writes its `Collect` JSON to that path and uploads nothing itself (no token
is even required in this mode). Give each shard a unique path, upload it as a CI artifact, then
merge and upload once via [`qualflare-cli`](https://github.com/Qualflare/qualflare-cli)'s `--shard`
flag, which already implements exactly this file-merge pattern for every framework it supports.

Video attachments are never uploaded in this mode — `uploadVideos` is forced off automatically,
regardless of what's configured. Video upload needs a real token (this mode deliberately has none),
and even a successful upload's `storageKey` has no equivalent in `qualflare-cli`'s merge parser and
would be dropped at merge time anyway. A spec's failing-test video (or a `qualflare.attachmentFromFile()`
call given a video path) is simply skipped, with a logged warning, the same as `uploadVideos: false`.

```ts
// cypress.config.ts
export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      return qualflareCypress(on, config, {
        outputFile: `qualflare-report-${process.env.SHARD_INDEX}.json`,
      });
    },
  },
});
```

GitHub Actions example (a matrix job per shard, then a final job that merges and uploads):

```yaml
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: npx cypress run
        env:
          SHARD_INDEX: ${{ matrix.shard }}
          # No QUALFLARE_TOKEN here — outputFile mode never authenticates.
      - uses: actions/upload-artifact@v4
        with:
          name: qualflare-report-${{ matrix.shard }}
          path: qualflare-report-${{ matrix.shard }}.json

  upload:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: qualflare-report-*
          merge-multiple: true
      - run: |
          npm install -g @qualflare/cli
          qf login ci "$QF_TOKEN" --force
          qf ci collect --shard qualflare-report-*.json
        env:
          QF_TOKEN: ${{ secrets.QF_TOKEN }}
```

`qf` auto-detects this reporter's JSON output from its content — no `--format` flag needed.

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
