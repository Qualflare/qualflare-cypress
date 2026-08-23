# qualflare-cypress: standardized report output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove direct-POST from `@qualflare/cypress` entirely — the reporter always writes a
standardized report directory (JSON + copied video files, zero network calls), which
`qualflare-cli` becomes solely responsible for uploading.

**Architecture:** `outputFile` (a single user-configured path, opt-in) is replaced by `outputDir`
(always active, sensible default). Every process run writes its own uniquely-named JSON file into
that directory and copies any video attachment alongside it (`fs.copyFileSync`, Allure's
`FileSystemWriter.writeAttachmentFromPath` pattern — never read into memory), referencing it via a
new `localVideoPath` field instead of uploading. Every case gets `shardIndex` populated from
auto-detected or manually-configured shard info. `src/http/client.ts` and everything that calls it
are deleted.

**Tech Stack:** TypeScript, Vitest, tsup (dual ESM+CJS build), Cypress plugin API.

**Spec:** `docs/superpowers/specs/2026-08-24-native-sharded-collect-design.md`

## Global Constraints

- No backend (`api-service`) changes — the wire contract this reporter emits into its output file
  is unchanged except for the new file-format-only `localVideoPath` field, which never reaches
  `/collect` (that's `qualflare-cli`'s job, covered in the sibling `qualflare-cli` plan).
- Both `@qualflare/cypress` and `@qualflare/cucumberjs` bump to `0.2.0` with a breaking-change
  CHANGELOG entry — no deprecation shim, per the spec (pre-1.0, zero real adoption).
- `maxVideoBytes` stays as a config option (cheap pre-filter before copying); `token`,
  `uploadVideos`, `failOnUploadError` are removed entirely.
- Every existing non-video-related behavior (CI/git auto-detection, the `qualflare.*` metadata API,
  screenshot/attachment budget handling) is unchanged.

---

## Task 1: `outputDir` replaces `outputFile`, `token`/`uploadVideos`/`failOnUploadError` removed, shard options added

**Files:**
- Modify: `src/plugin/resolve-config.ts`
- Test: `src/plugin/resolve-config.test.ts` (create if it doesn't already cover this — check
  `test/unit/resolve-config-output-file.test.ts` and `test/unit/resolve-config-detection.test.ts`
  first; add new cases there if a suite already exists for `resolveConfig`)

**Interfaces:**
- Produces: `ResolvedPluginConfig` gains `outputDir: string`, `shardIndex?: number`. Loses `token`,
  `uploadVideos`, `failOnUploadError`, `outputFile`.
- Produces: `QualflareCypressOptions` gains `outputDir?: string`, `shardIndex?: number`. Loses
  `token`, `uploadVideos`, `failOnUploadError`, `outputFile`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/resolve-config-output-file.test.ts` (rename file's intent stays valid — it's
still testing output-path resolution, just for a directory now):

```ts
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/plugin/resolve-config.js'

describe('resolveConfig — outputDir', () => {
  it('defaults outputDir to ./qualflare-results', () => {
    const resolved = resolveConfig({})
    expect(resolved.outputDir).toBe('./qualflare-results')
  })

  it('honors an explicit outputDir option', () => {
    const resolved = resolveConfig({ outputDir: './custom-dir' })
    expect(resolved.outputDir).toBe('./custom-dir')
  })

  it('honors QUALFLARE_OUTPUT_DIR when no option is given', () => {
    const resolved = resolveConfig(
      {},
      { detectGit: () => ({}), detectCi: () => ({}) },
    )
    expect(resolved.outputDir).toBeDefined()
    // Full env-var precedence already covered by existing QUALFLARE_OUTPUT_FILE-style
    // tests elsewhere in this file — this just confirms the new var name is read.
  })

  it('never throws for a missing token — token no longer exists', () => {
    expect(() => resolveConfig({})).not.toThrow()
  })

  it('passes an explicit shardIndex through unchanged', () => {
    const resolved = resolveConfig({ shardIndex: 3 })
    expect(resolved.shardIndex).toBe(3)
  })

  it('omits shardIndex when nothing sets it', () => {
    const resolved = resolveConfig({})
    expect(resolved.shardIndex).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- resolve-config-output-file`
Expected: FAIL — `outputDir` is `undefined` (property doesn't exist yet), `shardIndex` doesn't
exist, `resolveConfig({})` currently throws `QualflareConfigError` (no token).

- [ ] **Step 3: Rewrite `resolve-config.ts`**

In the `QualflareCypressOptions` interface, replace:

```ts
  failOnUploadError?: boolean;
```
with nothing (delete the field and its doc comment).

Replace:
```ts
  /** Upload a spec's failure video recording (Cypress's own `video: true`
   * output) to the failing test's attachments. Only uploaded when at least
   * one case in the spec failed — a video from an all-passing spec has
   * little diagnostic value and isn't worth the upload. Default `true`. */
  uploadVideos?: boolean;
```
with nothing (delete — video attachment is now unconditional whenever a failing case and a
recording exist; `maxVideoBytes` is still the size gate).

Replace the `token?: string;` field and the `outputFile?: string;` field (with its whole doc
comment) with:

```ts
  /** Directory `after:run` writes this process's report file (and any video
   * attachments) into. Default `./qualflare-results`. Always active — this
   * reporter never uploads anything itself; `qualflare-cli` reads whatever
   * ends up in this directory. Every JSON file this process writes is
   * uniquely named, so multiple shards can safely share one `outputDir`
   * without colliding — see docs/LIMITATIONS.md. */
  outputDir?: string;
  /** This process's 0-based position among parallel shards of the same CI
   * run, stamped onto every case it reports. Auto-detected from CI env vars
   * when omitted (see docs/CONFIGURATION.md's detection table) — a normal
   * single-process run needs no shard concept at all and can leave this
   * unset. */
  shardIndex?: number;
```

In `ResolvedPluginConfig`, remove `token: string;`, `failOnUploadError: boolean;`,
`uploadVideos: boolean;`, `outputFile?: string;`, and add:

```ts
  outputDir: string;
  shardIndex?: number;
```

In `resolveConfig`'s body, delete the `outputFile`/`token` resolution block and the
`QualflareConfigError` throw entirely (a token is never needed by this process anymore). Replace
with:

```ts
  const outputDir = options.outputDir || firstEnv('QUALFLARE_OUTPUT_DIR') || './qualflare-results';
  const shardIndex = options.shardIndex ?? envInt('QUALFLARE_SHARD_INDEX');
```

Delete `failOnUploadError: options.failOnUploadError ?? envBool('QUALFLARE_FAIL_ON_UPLOAD_ERROR') ?? false,`
and the `uploadVideos: outputFile !== undefined ? false : (...)` line (and its long doc comment
above it) from the returned object. Replace `outputFile,` at the end of the returned object with
`outputDir,\n    shardIndex,`. Remove `token,` from the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- resolve-config-output-file resolve-config-detection`
Expected: PASS. (The old `outputFile`-specific tests in `resolve-config-output-file.test.ts` will
now fail to compile/reference a removed field — fix those in the same pass: replace every
`outputFile` reference in that file with `outputDir`, and delete the token-throws-without-one test
case, since a token is no longer required.)

- [ ] **Step 5: Commit**

```bash
git add src/plugin/resolve-config.ts test/unit/resolve-config-output-file.test.ts
git commit -m "feat(config): outputDir replaces outputFile; remove token/uploadVideos/failOnUploadError"
```

---

## Task 2: `Attachment.localVideoPath` replaces the upload result shape; `video-uploader.ts` copies instead of uploading

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/plugin/video-uploader.ts`
- Modify: `test/unit/http-client.test.ts` → delete (see Task 5)
- Test: `test/unit/video-uploader.test.ts` (new)

**Interfaces:**
- Consumes: `ResolvedPluginConfig.outputDir`, `ResolvedPluginConfig.maxVideoBytes` (from Task 1).
- Produces: `copyVideoAttachment(filePath: string, outputDir: string, maxVideoBytes: number): { localVideoPath: string; fileSize: number; mimeType: string } | undefined` — replaces `uploadVideo`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/video-uploader.test.ts`:

```ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyVideoAttachment } from '../../src/plugin/video-uploader.js'

describe('copyVideoAttachment', () => {
  let tmpDir: string
  let outputDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-video-src-'))
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-video-out-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  it('copies the video into outputDir and returns a relative localVideoPath', () => {
    const src = path.join(tmpDir, 'a.mp4')
    fs.writeFileSync(src, 'fake-video-bytes')

    const result = copyVideoAttachment(src, outputDir, 1_000_000)

    expect(result).toBeDefined()
    expect(result!.mimeType).toBe('video/mp4')
    expect(result!.fileSize).toBe('fake-video-bytes'.length)
    const copiedPath = path.join(outputDir, result!.localVideoPath)
    expect(fs.readFileSync(copiedPath, 'utf8')).toBe('fake-video-bytes')
  })

  it('skips an unsupported extension without touching outputDir', () => {
    const src = path.join(tmpDir, 'a.avi')
    fs.writeFileSync(src, 'x')

    const result = copyVideoAttachment(src, outputDir, 1_000_000)

    expect(result).toBeUndefined()
    expect(fs.readdirSync(outputDir)).toHaveLength(0)
  })

  it('skips a file exceeding maxVideoBytes without reading it', () => {
    const src = path.join(tmpDir, 'a.mp4')
    fs.writeFileSync(src, 'this-is-11-bytes')

    const result = copyVideoAttachment(src, outputDir, 5)

    expect(result).toBeUndefined()
    expect(fs.readdirSync(outputDir)).toHaveLength(0)
  })

  it('gives two videos copied into the same outputDir distinct filenames', () => {
    const srcA = path.join(tmpDir, 'a.mp4')
    const srcB = path.join(tmpDir, 'b.mp4')
    fs.writeFileSync(srcA, 'a')
    fs.writeFileSync(srcB, 'b')

    const resultA = copyVideoAttachment(srcA, outputDir, 1_000_000)
    const resultB = copyVideoAttachment(srcB, outputDir, 1_000_000)

    expect(resultA!.localVideoPath).not.toBe(resultB!.localVideoPath)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- video-uploader`
Expected: FAIL — `copyVideoAttachment` is not exported (`uploadVideo` still is).

- [ ] **Step 3: Rewrite `video-uploader.ts`**

Replace the entire file content:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { logger } from '../shared/logger.js';

/** Extension -> MIME type for the video formats the server accepts (see
 * `launch.AllowedAttachmentUploadMimeTypes` server-side). Cypress itself
 * always records `.mp4` today, but `.webm`/`.mov` are listed for parity with
 * the server's own allowlist and in case that ever changes. An extension not
 * in this map (a user could point `qualflare.attachmentFromFile()` at an
 * arbitrary file) is skipped — see `copyVideoAttachment`'s doc comment. */
const VIDEO_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export interface VideoCopyResult {
  /** Filename relative to the `outputDir` this was copied into — never an
   * absolute path, since the whole directory travels together as one CI
   * artifact bundle (see the design spec's "Why no backend changes"
   * section). */
  localVideoPath: string;
  fileSize: number;
  mimeType: string;
}

/**
 * Copies one video file into `outputDir` under a unique filename (Allure's
 * `FileSystemWriter.writeAttachmentFromPath` pattern: `fs.copyFileSync`,
 * never read into memory) and returns enough to build that `Attachment`
 * entry's `localVideoPath`. `qualflare-cli` is what actually uploads this
 * file later, once it has a real auth token — see the design spec.
 *
 * Best-effort, like the rest of this reporter's attachment handling
 * (`attachment-reader.ts`'s oversized/unreadable-file skip): any failure —
 * oversized file, unsupported extension, an unreadable source file — is
 * logged as a warning and resolves to `undefined` rather than throwing, so a
 * video problem never fails the whole run.
 */
export function copyVideoAttachment(
  filePath: string,
  outputDir: string,
  maxVideoBytes: number,
): VideoCopyResult | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = VIDEO_MIME_TYPES_BY_EXTENSION[ext];
  if (!mimeType) {
    logger.warn(`skipping video attachment "${filePath}": unsupported video format.`);
    return undefined;
  }

  let fileSize: number;
  try {
    // Stat BEFORE copying — an oversized file must never be copied just to
    // discover it should be skipped.
    fileSize = fs.statSync(filePath).size;
  } catch (err) {
    logger.warn(`skipping video attachment "${filePath}": could not stat file: ${(err as Error).message}`);
    return undefined;
  }
  if (fileSize > maxVideoBytes) {
    logger.warn(
      `skipping video attachment "${filePath}": ${fileSize} bytes exceeds the configured ` +
        `maxVideoBytes cap of ${maxVideoBytes} bytes.`,
    );
    return undefined;
  }

  const localVideoPath = `${randomUUID()}${ext}`;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(outputDir, localVideoPath));
  } catch (err) {
    logger.warn(`skipping video attachment "${filePath}": could not copy file: ${(err as Error).message}`);
    return undefined;
  }

  return { localVideoPath, fileSize, mimeType };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- video-uploader`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/plugin/video-uploader.ts test/unit/video-uploader.test.ts
git commit -m "feat(video): copy attachments into outputDir instead of uploading"
```

---

## Task 3: `types.ts` gains `localVideoPath`; `attachment-reader.ts` uses the new copy function

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/plugin/attachment-reader.ts`
- Modify: `test/unit/attachment-reader.test.ts`

**Interfaces:**
- Consumes: `copyVideoAttachment` from Task 2.
- Produces: `AttachmentReaderConfig` loses `uploadVideos: boolean` and `httpOptions: SendOptions`,
  gains `outputDir: string`.

- [ ] **Step 1: Write the failing test**

In `test/unit/attachment-reader.test.ts`, find the existing video-attachment test case(s) (search
for `isVideoLike`/`uploadVideos`/`storageKey` in that file) and replace them with:

```ts
it('routes a video-like attachment through copyVideoAttachment and sets localVideoPath', async () => {
  const src = path.join(tmpDir, 'clip.mp4')
  fs.writeFileSync(src, 'video-bytes')

  const resolved = await resolveAttachments(
    [{ name: 'video', path: src, mimeType: 'video/mp4' }],
    { attachScreenshots: true, maxAttachmentBytes: 1_000_000, maxTotalAttachmentBytes: 1_000_000, maxVideoBytes: 1_000_000, outputDir },
    new AttachmentBudget(1_000_000),
  )

  expect(resolved).toHaveLength(1)
  expect(resolved![0].localVideoPath).toBeDefined()
  expect(resolved![0].content).toBeUndefined()
})

it('drops a video attachment with no local path to copy', async () => {
  const resolved = await resolveAttachments(
    [{ name: 'video', mimeType: 'video/mp4' }],
    { attachScreenshots: true, maxAttachmentBytes: 1_000_000, maxTotalAttachmentBytes: 1_000_000, maxVideoBytes: 1_000_000, outputDir },
    new AttachmentBudget(1_000_000),
  )

  expect(resolved).toBeUndefined()
})
```

(Adjust `tmpDir`/`outputDir` setup to match this test file's existing `beforeEach`/`afterEach`
convention — if none exists yet for temp directories, add one mirroring Task 2's pattern.) Delete
the old test(s) asserting `uploadVideos: false` skips a video and asserting `storageKey` gets set —
those options/fields no longer exist.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- attachment-reader`
Expected: FAIL — `AttachmentReaderConfig` has no `outputDir` field yet, `resolveAttachments` still
calls the now-deleted `uploadVideo`.

- [ ] **Step 3: Update `attachment-reader.ts`**

Change the import:
```ts
import { copyVideoAttachment } from './video-uploader.js';
```

Change `AttachmentReaderConfig`:
```ts
export interface AttachmentReaderConfig {
  attachScreenshots: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxVideoBytes: number;
  outputDir: string;
}
```
(Remove `uploadVideos: boolean;` and `httpOptions: SendOptions;`; remove the now-unused
`SendOptions` import.)

In `resolveAttachments`, replace the video branch:
```ts
    if (isVideoLike(attachment)) {
      if (!config.uploadVideos) {
        logger.info(`skipping video attachment "${attachment.name}": uploadVideos is disabled.`);
        continue;
      }
      if (!attachment.path) {
        logger.warn(`skipping video attachment "${attachment.name}": no local file path to upload.`);
        continue;
      }
      const uploaded = await uploadVideo(attachment.path, config.maxVideoBytes, config.httpOptions);
      if (!uploaded) {
        // uploadVideo already logged the specific reason.
        continue;
      }
      resolved.push({
        ...attachment,
        mimeType: uploaded.mimeType,
        storageKey: uploaded.storageKey,
        fileSize: uploaded.fileSize,
      });
      continue;
    }
```
with:
```ts
    if (isVideoLike(attachment)) {
      if (!attachment.path) {
        logger.warn(`skipping video attachment "${attachment.name}": no local file path to copy.`);
        continue;
      }
      const copied = copyVideoAttachment(attachment.path, config.outputDir, config.maxVideoBytes);
      if (!copied) {
        // copyVideoAttachment already logged the specific reason.
        continue;
      }
      resolved.push({
        ...attachment,
        mimeType: copied.mimeType,
        localVideoPath: copied.localVideoPath,
        fileSize: copied.fileSize,
      });
      continue;
    }
```
`resolveAttachments` no longer needs to be `async` if nothing else in it awaits — check the rest of
the function; if `readAttachmentFile` and everything else are synchronous, drop `async`/`Promise<>`
from its signature and update both call sites (`tasks.ts`, and this test file) accordingly. If in
doubt, leave it `async` (a sync function wrapped in `Promise` is harmless) — do not spend extra
cycles chasing this if it risks missing a real await elsewhere in the file.

Add `localVideoPath?: string;` to `src/shared/types.ts`'s `Attachment` interface, next to
`storageKey`:
```ts
  /** Set when this is a video the reporter copied into the same output
   * directory as the report file, rather than uploading it itself —
   * `qualflare-cli` resolves this into a real `storageKey` at collect time.
   * Relative to the report file's own directory. Never sent to `/collect`
   * directly; mutually exclusive with `content`/`storageKey`. */
  localVideoPath?: string;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- attachment-reader`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/plugin/attachment-reader.ts test/unit/attachment-reader.test.ts
git commit -m "feat(video): attachment-reader copies videos via copyVideoAttachment, sets localVideoPath"
```

---

## Task 4: `events.ts` always writes `outputDir`, stamps `shardIndex`, drops the HTTP path entirely

**Files:**
- Modify: `src/plugin/events.ts`
- Modify: `test/unit/screenshot-attachment-flow.test.ts`

**Interfaces:**
- Consumes: `copyVideoAttachment` (Task 2), `ResolvedPluginConfig.outputDir`/`shardIndex` (Task 1).
- Produces: `registerEvents` no longer takes an HTTP client dependency; `after:run` always writes
  `<outputDir>/<uuid>.json`.

- [ ] **Step 1: Write/update the failing tests**

In `test/unit/screenshot-attachment-flow.test.ts`, find the tests asserting `after:run` POSTs (the
one asserting `"uploaded launch #1 to Qualflare"` and the outputFile-mode ones) and replace them
with:

```ts
it('always writes the Collect payload to outputDir, never POSTs', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-events-'))
  // ...set up registerEvents/on() harness exactly as the existing tests in
  // this file do, with config.outputDir = outputDir...

  await triggerAfterRun()

  const written = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'))
  expect(written).toHaveLength(1)
  const collect = JSON.parse(fs.readFileSync(path.join(outputDir, written[0]), 'utf8'))
  expect(collect.suites[0].cases[0].name).toBe('a passing test')
})

it('stamps shardIndex on every case when config.shardIndex is set', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-events-'))
  // ...same harness, config.shardIndex = 2...

  await triggerAfterRun()

  const written = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'))[0]
  const collect = JSON.parse(fs.readFileSync(path.join(outputDir, written), 'utf8'))
  expect(collect.suites[0].cases[0].shardIndex).toBe(2)
})

it('writes distinct filenames across two consecutive runs into the same outputDir', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-events-'))
  // ...trigger after:run twice against two separate registerEvents() instances
  // pointed at the same outputDir...

  const written = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'))
  expect(written).toHaveLength(2)
})
```

(Follow this file's existing harness setup exactly — it already wires a fake `on()` and drives
`after:spec`/`after:run`; adapt the assertions above to that harness's actual helper names rather
than introducing a parallel one.) Delete every test asserting `uploadVideos: false` skips a video,
or asserting an outputFile-mode single fixed path — replace with the outputDir-always-copies
behavior from Task 2/3.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- screenshot-attachment-flow`
Expected: FAIL — `events.ts` still branches on `config.outputFile` and POSTs otherwise.

- [ ] **Step 3: Rewrite `events.ts`**

Remove the import `import { QualflareHttpClient } from '../http/client.js';` and change
`import { buildHttpOptions, uploadVideo } from './video-uploader.js';` to
`import { copyVideoAttachment } from './video-uploader.js';`. Add `import * as path from 'node:path';`
and `import { randomUUID } from 'node:crypto';` alongside the existing `import * as fs from 'node:fs';`.

Delete the `httpOptions` hoisting (`const httpOptions = buildHttpOptions(config);`) — nothing needs
it anymore.

In `after:spec`, replace:
```ts
    if (results.video && config.uploadVideos) {
      const failedCase = cases.find((c) => FAILURE_STATUSES.has(c.status));
      if (failedCase) {
        const uploaded = await uploadVideo(results.video, config.maxVideoBytes, httpOptions);
        if (uploaded) {
          attachVideo(failedCase, uploaded);
        }
      } else {
        logger.info(
          `spec ${spec.relative} recorded a video but no test failed — not uploaded ` +
            '(only failure recordings are uploaded; set `uploadVideos: false` to silence this).',
        );
      }
    } else if (results.video) {
      logger.info(`spec ${spec.relative} recorded a video at ${results.video} — not uploaded (uploadVideos is disabled).`);
    }
```
with:
```ts
    if (results.video) {
      const failedCase = cases.find((c) => FAILURE_STATUSES.has(c.status));
      if (failedCase) {
        const copied = copyVideoAttachment(results.video, config.outputDir, config.maxVideoBytes);
        if (copied) {
          attachVideo(failedCase, copied);
        }
      } else {
        logger.info(`spec ${spec.relative} recorded a video but no test failed — not attached.`);
      }
    }
```

Change `attachVideo`'s signature and body:
```ts
function attachVideo(testCase: Case, copied: { localVideoPath: string; fileSize: number; mimeType: string }): void {
  const attachments = testCase.attachments ?? [];
  if (attachments.length >= MAX_ATTACHMENTS_PER_CASE) {
    logger.warn(
      `not attaching video to "${testCase.name}": already at the server's ${MAX_ATTACHMENTS_PER_CASE}-attachment-per-case cap.`,
    );
    return;
  }
  testCase.attachments = [
    ...attachments,
    {
      name: 'video',
      mimeType: copied.mimeType,
      localVideoPath: copied.localVideoPath,
      fileSize: copied.fileSize,
    },
  ];
}
```

Replace the whole `on('after:run', ...)` body:
```ts
  on('after:run', async () => {
    const suites = accumulator.getSuites();
    if (suites.length === 0) {
      logger.info('no test results were captured this run — skipping file write.');
      return;
    }

    const collect = buildCollectPayload(accumulator, config, browserInfo);
    if (config.shardIndex !== undefined) {
      for (const suite of collect.suites) {
        for (const c of suite.cases) {
          c.shardIndex = config.shardIndex;
        }
      }
    }

    fs.mkdirSync(config.outputDir, { recursive: true });
    const outputPath = path.join(config.outputDir, `${randomUUID()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(collect));
    logger.info(`wrote Collect payload to ${outputPath} — run \`qualflare-cli collect ${config.outputDir}\` to upload it.`);
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- screenshot-attachment-flow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugin/events.ts test/unit/screenshot-attachment-flow.test.ts
git commit -m "feat(events): after:run always writes outputDir, stamps shardIndex, never POSTs"
```

---

## Task 5: Delete the HTTP client and every remaining reference to it

**Files:**
- Delete: `src/http/client.ts`
- Delete: `test/unit/http-client.test.ts`
- Delete: `test/unit/backoff.test.ts` (only exercised retry/backoff logic that lived in `http/client.ts` — verify before deleting; keep it if it tests something reused elsewhere)
- Modify: `src/plugin/index.ts`
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: Confirm nothing else imports from `../http/client.js`**

Run: `grep -rn "http/client" src test`
Expected: only `src/plugin/index.ts` (the `buildHttpOptions` import, already partially handled by
earlier tasks removing it from `video-uploader.ts`/`events.ts`/`attachment-reader.ts`) and the two
test files listed above.

- [ ] **Step 2: Update `index.ts`**

Remove `import { buildHttpOptions } from './video-uploader.js';` and the
`httpOptions: buildHttpOptions(resolved)` line from the `attachmentConfig` construction. Add
`outputDir: resolved.outputDir` there instead, matching `AttachmentReaderConfig`'s new shape from
Task 3:

```ts
  const attachmentConfig: AttachmentReaderConfig = { ...resolved, outputDir: resolved.outputDir };
```

(If `resolved` already has `outputDir` as a same-named field — it does, from Task 1 — the spread
already covers it; simplify to `const attachmentConfig: AttachmentReaderConfig = resolved;` if
`ResolvedPluginConfig` is now a strict superset of `AttachmentReaderConfig`'s fields. Check the two
interfaces side by side before deciding; don't leave a redundant explicit field if the spread
already provides it.)

- [ ] **Step 3: Delete the files**

```bash
rm src/http/client.ts test/unit/http-client.test.ts
rmdir src/http 2>/dev/null || true
```

Check `test/unit/backoff.test.ts`'s import — if it imports from `../../src/http/client.js`, delete
it too; if the backoff logic it tests lives somewhere else reusable, leave it.

- [ ] **Step 4: Remove now-dead constants**

In `src/shared/constants.ts`, delete:
```ts
/** HTTP headers used against `/api/v1/collect`. */
export const HEADER_TOKEN = 'QF_TOKEN';
export const HEADER_IDEMPOTENCY_KEY = 'Idempotency-Key';
export const HEADER_CONTENT_TYPE = 'Content-Type';
export const HEADER_ACCEPT = 'Accept';
export const HEADER_USER_AGENT = 'User-Agent';
```
Run `grep -rn "HEADER_TOKEN\|HEADER_IDEMPOTENCY_KEY\|HEADER_CONTENT_TYPE\|HEADER_ACCEPT\|HEADER_USER_AGENT" src test`
first to confirm nothing else references them before deleting.

- [ ] **Step 5: Verify the whole suite still typechecks, lints, and passes**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green, zero references to the deleted file remain.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: delete http/client.ts and every remaining reference to it"
```

---

## Task 6: Integration test, version bump, docs rewrite

**Files:**
- Modify: `test/integration/*` (find via `find test/integration -type f`; adapt the existing
  real-Cypress-run test to assert against `outputDir` instead of a mocked POST)
- Modify: `package.json` (version `0.1.0` → `0.2.0`)
- Modify: `CHANGELOG.md`
- Modify: `README.md`, `docs/CONFIGURATION.md`, `docs/LIMITATIONS.md`

- [ ] **Step 1: Update the integration test**

Read the existing integration test file(s) under `test/integration/` in full first — they exercise
a real `cypress run` against a fixture project. Update whatever currently configures `token`/
`outputFile` on the plugin to configure `outputDir` instead, and change the assertion from "the
mock collect server received a POST" to "the outputDir contains exactly one JSON file whose
contents match the expected `Collect` shape, and any video attachment fixture produces a
`localVideoPath`-only attachment with the corresponding file present in `outputDir`." This is the
single most important test in the plan — it's the only one exercising the real Cypress event
lifecycle end to end.

- [ ] **Step 2: Run the integration test**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 3: Version bump and CHANGELOG**

In `package.json`, change `"version": "0.1.0"` to `"version": "0.2.0"`.

Add to the top of `CHANGELOG.md` (create it in the standard Keep-a-Changelog format if it doesn't
already have a top section for unreleased changes):

```markdown
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
```

- [ ] **Step 4: Rewrite the docs**

In `README.md`'s "Known limitations" section, remove the "One `cypress run` process uploads as one
Launch by default..." bullet entirely — replace it with nothing, or with a note that sharded runs
merge automatically once `qualflare-cli collect` is run over the shared `outputDir` (this wording
is a judgment call, not a design decision — pick whichever reads more naturally once the rest of
the README reflects the new quick-start).

Rewrite the quick-start / CI example (find it near the top of `README.md`) to show `outputDir`
instead of a `token`-configured direct-POST setup, followed by a `qualflare-cli collect
./qualflare-results` CI step — every setup needs this step now, not just sharded ones.

In `docs/CONFIGURATION.md`, remove the `token`, `uploadVideos`, `failOnUploadError` rows from the
options table; add `outputDir` and `shardIndex` rows with their defaults and env var names.

In `docs/LIMITATIONS.md`, rewrite the "Video upload" section (it currently describes a presigned-URL
upload the reporter itself performs — that's no longer true, `qualflare-cli` does it now) and the
"One `cypress run` process = one Launch" section (the manual `outputFile` + explicit merge step it
currently documents is now just "run `qualflare-cli collect` on the directory" — no more manual
path templating). Add an explicit caveat to that section (per the design spec's "Stale-file
caveat"): merging is based purely on which files are sitting in `outputDir` when `qualflare-cli
collect` runs, with no run-identity check, so a directory left over from a previous run (a local
`cypress run` executed twice against the default `./qualflare-results`, or a CI cache that
persists it across builds) gets silently merged into the current one — recommend clearing or
freshly creating `outputDir` at the start of each run, the same convention Allure documents for
its own `allure-results` directory.

- [ ] **Step 5: Full verification pass**

Run: `npm run typecheck && npm run lint && npm run test && npm run test:integration`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: rewrite for standardized outputDir + qualflare-cli-only upload; bump to 0.2.0"
```
