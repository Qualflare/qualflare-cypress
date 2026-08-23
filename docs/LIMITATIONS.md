# Known limitations

These are real, current constraints of `@qualflare/cypress` v1 — documented deliberately rather than
discovered by surprise. Several stem from Qualflare backend capabilities that don't exist yet;
others are inherent to how Cypress exposes information to a reporter.

## No video upload

Qualflare has no blob/video-attachment storage yet (a separate, larger backend feature — see the
project's Feature V in the platform's implementation plan). Cypress's per-spec video path (from
`after:spec`'s `results.video`) is logged for your own reference only:

```
Recorded video: cypress/videos/login.cy.ts.mp4 (not uploaded — Qualflare has no video attachment support yet)
```

It is never read into memory, never base64-encoded, and never referenced by any uploaded attachment.
This is enforced both structurally (no code path routes a video file through the attachment
pipeline) and defensively (`resolveAttachments()` explicitly refuses any video mimeType or file
extension even if something upstream tried).

## One `cypress run` process = one Launch

Qualflare's `/api/v1/collect` endpoint creates exactly one new Launch per request, with no
incremental or merge capability server-side. This reporter accumulates every spec file's results in
memory for the lifetime of one `cypress run` process and uploads them in a single POST at
`after:run`.

If your CI shards specs across **multiple separate `cypress run` processes or machines**, each shard
uploads its own separate Launch — you will see N Launches for one CI run, not one combined Launch.

A natural v2 extension (not built here) is an optional file-output mode that writes the exact
`Collect` JSON shape to disk instead of POSTing, so a separate aggregation step could combine
multiple shards' output before uploading once.

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
