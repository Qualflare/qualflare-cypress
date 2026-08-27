import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import type { Case, Collect } from '../../src/shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixtures', 'cypress-project');

/** Real end-to-end coverage: spawns an actual `cypress run` (Electron,
 * bundled with Cypress — no extra browser install needed) against the
 * fixture project in `fixtures/cypress-project/`, then asserts against the
 * REAL contents of the report directory it writes (`outputDir`) — the one
 * Collect JSON file this process produces, plus any video file copied
 * alongside it — rather than a mocked network call. This reporter makes
 * zero network calls of its own; `qualflare-cli collect <outputDir>` is what
 * actually uploads a directory's contents (see README.md / docs/LIMITATIONS.md),
 * so there is nothing left here to intercept over HTTP.
 *
 * Requires `npm run build` to have already produced `dist/` — the fixture
 * imports the built package, not TypeScript source (see
 * `fixtures/cypress-project/cypress.config.ts`'s comment for why).
 */
describe('qualflare-cypress against a real cypress run', () => {
  let outputDir: string | undefined;

  afterAll(() => {
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it(
    'writes exactly one Collect report to outputDir, matching the wire contract, with a video attachment copied alongside it',
    async () => {
      outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cypress-integration-'));

      const result = await execa('npx', ['cypress', 'run', '--browser', 'electron'], {
        cwd: fixtureDir,
        env: {
          ...process.env,
          QUALFLARE_TEST_OUTPUT_DIR: outputDir,
        },
        // `failing.cy.ts`, `hook-failure.cy.ts`, and the first attempt of
        // `retried-flaky.cy.ts` fail by design — assert on the written
        // report, not Cypress's process exit code.
        reject: false,
      });

      let entries: string[];
      try {
        entries = fs.readdirSync(outputDir);
      } catch (err) {
        throw new Error(
          `outputDir "${outputDir}" could not be read after \`cypress run\` — it likely failed to even ` +
            `start. exit code: ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n--- cause ---\n${(err as Error).message}`,
        );
      }

      const jsonFiles = entries.filter((name) => name.endsWith('.json'));
      if (jsonFiles.length === 0) {
        throw new Error(
          `outputDir "${outputDir}" contains no .json report at all — cypress run likely failed to even ` +
            `start. exit code: ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }
      // One `cypress run` process writes exactly one report file — see
      // events.ts's `after:run` handler.
      expect(jsonFiles).toHaveLength(1);

      const reportPath = path.join(outputDir, jsonFiles[0]!);
      const collect = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Collect;

      expect(collect.framework).toBe('cypress');
      expect(collect.platform).toBe('web');
      expect(collect.branch).toBeNull();
      expect(collect.commit).toBeNull();
      expect(typeof collect.os).toBe('string');
      expect(Array.isArray(collect.suites)).toBe(true);
      expect(collect.suites.length).toBeGreaterThan(0);

      const allCases: Case[] = collect.suites.flatMap((s) => s.cases);
      expect(allCases.length).toBeGreaterThan(0);

      const passing = allCases.find((c) => c.name === 'passes normally');
      expect(passing).toBeDefined();
      expect(passing?.status).toBe('passed');
      expect(passing?.retryCount ?? 0).toBe(0);

      const failing = allCases.find((c) => c.name === 'fails with a recognizable error message');
      expect(failing).toBeDefined();
      expect(failing?.status).toBe('failed');
      expect(typeof failing?.error).toBe('string');
      expect(failing?.error).toContain('qualflare-cypress-integration-test-marker');

      const flaky = allCases.find((c) => c.name === 'is flaky and eventually passes');
      expect(flaky).toBeDefined();
      expect(flaky?.status).toBe('passed');
      expect(flaky?.retryCount).toBe(1);
      expect(flaky?.isFlaky).toBe(true);
      // One collapsed Case, not two — the whole point of retry-collapsing.
      expect(allCases.filter((c) => c.name === 'is flaky and eventually passes')).toHaveLength(1);

      // Regression coverage for a bug found by deep self-review: a test
      // whose beforeEach hook fails was previously silently dropped from
      // the report entirely (never reported as failed, never reported at
      // all) because Mocha's runner fires 'fail' with a Hook-typed
      // runnable for this, not the guarded Test — see mocha-listener.ts's
      // hook-failure handling.
      const hookFailureCase = allCases.find(
        (c) => c.name === 'never runs its body because the guarding beforeEach hook fails first',
      );
      expect(hookFailureCase).toBeDefined();
      expect(hookFailureCase?.status).toBe('failed');
      expect(typeof hookFailureCase?.error).toBe('string');
      expect(hookFailureCase?.error).toContain('qualflare-cypress-integration-test-hook-failure-marker');

      // Regression coverage for another bug found by deep self-review: a
      // statically-skipped test (it.skip(...)) previously leaked forever in
      // an internal Map (Mocha never runs afterEach for it at all) instead
      // of ever being reported — see mocha-listener.ts's `drainOrphaned`,
      // swept from the NEXT real test's afterEach in the same spec.
      const skippedCase = allCases.find((c) => c.name === 'is statically skipped and never runs');
      expect(skippedCase).toBeDefined();
      expect(skippedCase?.status).toBe('skipped');
      const afterSkipCase = allCases.find((c) => c.name === 'a normal test that runs right after the skip');
      expect(afterSkipCase).toBeDefined();
      expect(afterSkipCase?.status).toBe('passed');

      const metadataCase = allCases.find((c) => c.name === 'exercises the author-facing metadata calls');
      expect(metadataCase).toBeDefined();
      expect(metadataCase?.labels).toEqual(expect.arrayContaining([{ name: 'epic', value: 'Integration Testing' }]));
      expect(metadataCase?.tags).toEqual(expect.arrayContaining(['smoke', 'qualflare-cypress-self-test']));
      expect(metadataCase?.description).toContain('Exercises the qualflare.* metadata API');
      expect(metadataCase?.links?.[0]).toMatchObject({ type: 'issue', url: 'https://example.com/issue/1' });
      // A parameter() call outside any step lands in Case.properties (see
      // docs/METADATA-API.md's placement rule).
      expect(metadataCase?.properties?.['outside-step-param']).toBe('outside-value');
      // A parameter() call inside qualflare.step() lands on that step's parameters[].
      const manualStep = metadataCase?.steps?.find((s) => s.name === 'a manual step');
      expect(manualStep).toBeDefined();
      expect(manualStep?.parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'inside-step-param', value: 'inside-value' })]),
      );

      // Video-attachment coverage (see events.ts's after:spec handler /
      // video-writer.ts's copyVideoAttachment): the fixture project has
      // `video: true`, and both `failing.cy.ts` and `hook-failure.cy.ts` are
      // single-case specs whose one case fails — Cypress's per-spec video
      // recording gets copied into `outputDir` and attached to that case as
      // a `localVideoPath`-only Attachment, never `content`/`storageKey`
      // (this reporter never uploads it itself — see resolve-config.ts's
      // `outputDir` doc comment).
      for (const videoCase of [failing, hookFailureCase]) {
        const videoAttachment = videoCase?.attachments?.find((a) => a.mimeType?.startsWith('video/'));
        expect(videoAttachment, `expected a video attachment on case "${videoCase?.name}"`).toBeDefined();
        expect(videoAttachment?.localVideoPath).toBeTypeOf('string');
        expect(videoAttachment?.content).toBeUndefined();
        expect(videoAttachment?.storageKey).toBeUndefined();
        const videoPath = path.join(outputDir, videoAttachment!.localVideoPath!);
        expect(fs.existsSync(videoPath), `expected video file at ${videoPath}`).toBe(true);
        expect(fs.statSync(videoPath).size).toBeGreaterThan(0);
      }

      // No OTHER case picked up a stray video attachment — Cypress records
      // one video per spec, and only `failing.cy.ts` / `hook-failure.cy.ts`
      // have a failing case to attribute it to (an all-passing spec's video
      // is never attached — see events.ts).
      for (const c of allCases) {
        if (c === failing || c === hookFailureCase) {
          continue;
        }
        for (const att of c.attachments ?? []) {
          expect(att.mimeType).not.toMatch(/^video\//);
        }
      }
    },
    120_000,
  );
});
