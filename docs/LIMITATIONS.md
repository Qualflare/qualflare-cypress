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
  first FAILING case in that spec. By DEFAULT only when at least one case failed — an all-passing
  spec's video has little diagnostic value and the bytes were not worth spending. Set
  `videoOnFailureOnly: false` to attach a green spec's video too (to the spec's first case); with
  the CLI's `--upload-artifacts` gate deciding what actually uploads, that cost is now settled at
  collect time rather than here. Since Cypress records one video per spec, not per
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

### A leftover report does not need clearing

Each report carries `metadata.runId` — the identifier every shard of one run shares and different
runs do not (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, and so on; a per-process UUID outside CI). When
`collect` finds files from more than one run it uploads the run that just finished and says what it
left out:

```
ignored 1 file(s) from 1 earlier run(s) (--allow-mixed-runs to include them)
Processing 2 test result file(s)...
OK Test results collected successfully
```

Nothing is deleted — the older files stay on disk, they are simply not uploaded.
`--allow-mixed-runs` merges every run into one launch instead, which is occasionally what you want
when several tools write into one directory.

There was a period where this was stricter than it needed to be: `collect` refused the whole upload
and left you to clear the directory by hand. Before that it merged the stale file silently, which
produced a launch that looked entirely plausible and contained results nobody ran.

**On `@qualflare/cli` older than v0.1.21 you get one of those two older behaviours** — a refusal on
v0.1.19–v0.1.20, and a silent merge before that.

## Retries: per-attempt error detail, final-attempt everything else

`Case.attempts` carries each attempt's status, duration and error, so a retried test reports
"attempt 1 failed with error X, attempt 2 passed" rather than collapsing to the final outcome.
`@qualflare/cucumberjs` and `@qualflare/playwright` send the same structure.

Everything *else* still comes from the final attempt: steps, labels, links, tags, description,
priority, properties and attachments. That is deliberate rather than a schema limit. An abandoned
attempt's step trace, replayed alongside the final one's, would misrepresent a single execution as
if the same steps ran twice — so earlier attempts' steps are discarded, never merged.

Two consequences worth knowing:

- A test that was **not** retried sends no `attempts` at all. There is no history in a run that
  happened once, and the server discards a single-element array, so sending one would only spend
  payload against the collect body limit.
- Past 50 attempts the server keeps the first 49 plus the final one and drops the middle. A test
  retrying more than fifty times is pathological; the launch still succeeds and `retryCount` still
  reflects the true total.

## `parameter()` masking redacts the value

`{ masked: true }` drops the value before the report is written. The secret never leaves this
process, so it is not stored server-side and cannot be read back through the API.

Inside a step, the parameter travels as `{ name, masked: true }` with no value, and the Qualflare UI
renders `••••••` from the flag. Outside any step it lands in the case's `properties`, a flat
`Record<string, string>` with nowhere to put the flag — so the value itself becomes `••••••`.
Either way the report carries no secret.

**The value is unrecoverable.** That is the point, but it is worth stating: masking is not a display
toggle you can undo later. Mask a value you may need to read back and it is gone.

This used to be a display hint only — the real value was sent, stored in plaintext and readable
through the API, while the UI drew dots over it. Anyone who trusted the name got no protection at
all, which is why the docs had to say "never put a real secret in one". They no longer do.

## Attachment caps

`maxAttachmentBytes` (5MB) bounds a single attachment; `maxTotalAttachmentBytes` (10MB) bounds the
run. Anything over either is dropped with a warning rather than truncated — a half-written screenshot
is worse than none.

They used to be 1.5MB and 750KB, and the run budget being *smaller* than the per-item cap was the
tell: every attachment was base64-inlined into `/collect`'s 10MB body, competing with the test
results, so the per-run number had to assume this process was one shard among many. It was a poor
assumption either way — the cap is per process, and `collect` merges every shard into one request,
so eleven shards each honouring 750KB still assembled a body over the limit and lost the whole
launch to a 413.

`@qualflare/cli` v0.1.22+ uploads attachments through the presigned-URL flow and references a
`storageKey`, so the body no longer grows with them. These numbers now only bound the report file on
disk.

**They require that CLI version.** An older one still inlines, and these limits would push it past
the body limit — the failure this change exists to remove. They stay bounded rather than unlimited
so the worst case is one launch rather than an out-of-memory.

## Noise-filtering on command-log steps is a simple heuristic

Not every Cypress internal log entry becomes a step — entries with an empty `name` are filtered out,
which is a deliberately simple heuristic (no reliably typed signal exists to distinguish
user-meaningful commands/assertions from Cypress's internal bookkeeping entries). This may need
refinement once exercised against real command-log output from a variety of live Cypress projects.

## Not limitations of this reporter

Things Cypress itself does not do. They are recorded here because people ask why a Cypress launch
looks different from the other reporters' — not because anything is being withheld. Each would need
a change in Cypress, not here.

**Command-log nesting is two levels deep.** Cypress's command log exposes exactly one typed
nesting signal — `LogConfig.type: 'parent' | 'child'` (verified against Cypress 14.5.4's shipped type
declarations; no arbitrary-depth group API exists in the typed surface). Auto-captured steps
therefore nest at most one level. `qualflare.step()` tracks its own stack and nests arbitrarily deep,
so use it where structure matters.

**Auto-captured step timing is approximate.** Command-log steps are timed from log events rather
than instrumented start/stop boundaries, so their durations are indicative. `qualflare.step()` timing
is exact — real elapsed time around the awaited body.
