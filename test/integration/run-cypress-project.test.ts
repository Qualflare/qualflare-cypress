import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMockCollectServer, type MockCollectServer } from './support/mock-collect-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixtures', 'cypress-project');

/** Real end-to-end coverage: spawns an actual `cypress run` (Electron,
 * bundled with Cypress — no extra browser install needed) against the
 * fixture project in `fixtures/cypress-project/`, pointed at a real local
 * HTTP server instead of the live Qualflare API, and asserts the single
 * captured POST body matches the wire contract byte-for-byte on the fields
 * that matter — not just "a request happened."
 *
 * Requires `npm run build` to have already produced `dist/` — the fixture
 * imports the built package, not TypeScript source (see
 * `fixtures/cypress-project/cypress.config.ts`'s comment for why).
 */
describe('qualflare-cypress against a real cypress run', () => {
  let server: MockCollectServer;

  beforeAll(async () => {
    server = await startMockCollectServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    'uploads one Collect payload matching the wire contract, retrying through a forced 503 first',
    async () => {
      // Exercises the retry path and the final payload shape in the same run:
      // the queued 503 forces the plugin's http client to retry once, so we
      // expect exactly 2 requests here, both carrying the SAME Idempotency-Key
      // (proving the key is stable across retries, not regenerated), with the
      // second succeeding.
      server.queueStatus(503);

      const result = await execa('npx', ['cypress', 'run', '--browser', 'electron'], {
        cwd: fixtureDir,
        env: {
          ...process.env,
          QUALFLARE_TEST_API_ENDPOINT: server.url,
        },
        // `failing.cy.ts` and the first attempt of `retried-flaky.cy.ts` fail
        // by design — assert on the captured payload, not Cypress's process
        // exit code.
        reject: false,
      });

      if (server.requests.length === 0) {
        throw new Error(
          `cypress run produced no captured requests at all — it likely failed to even start. ` +
            `exit code: ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }

      expect(server.requests).toHaveLength(2);
      const [first, second] = server.requests;

      const firstKey = first!.headers['idempotency-key'];
      const secondKey = second!.headers['idempotency-key'];
      expect(firstKey).toBeTypeOf('string');
      expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
      expect(secondKey).toBe(firstKey);

      for (const req of server.requests) {
        expect(req.headers['qf_token']).toBe('test-token');
        expect(req.headers['content-type']).toMatch(/^application\/json/);
        expect(req.headers['authorization']).toBeUndefined();
        expect(req.headers['access-token']).toBeUndefined();
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the captured body is untyped JSON from the wire, asserted field-by-field below
      const collect = second!.body as any;

      expect(collect.framework).toBe('cypress');
      expect(collect.platform).toBe('web');
      expect(collect.branch).toBeNull();
      expect(collect.commit).toBeNull();
      expect(typeof collect.os).toBe('string');
      expect(Array.isArray(collect.suites)).toBe(true);
      expect(collect.suites.length).toBeGreaterThan(0);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allCases = collect.suites.flatMap((s: any) => s.cases as any[]);
      expect(allCases.length).toBeGreaterThan(0);

      const passing = allCases.find((c) => c.name === 'passes normally');
      expect(passing).toBeDefined();
      expect(passing.status).toBe('passed');
      expect(passing.retryCount ?? 0).toBe(0);

      const failing = allCases.find((c) => c.name === 'fails with a recognizable error message');
      expect(failing).toBeDefined();
      expect(failing.status).toBe('failed');
      expect(typeof failing.error).toBe('string');
      expect(failing.error).toContain('qualflare-cypress-integration-test-marker');

      const flaky = allCases.find((c) => c.name === 'is flaky and eventually passes');
      expect(flaky).toBeDefined();
      expect(flaky.status).toBe('passed');
      expect(flaky.retryCount).toBe(1);
      expect(flaky.isFlaky).toBe(true);
      // One collapsed Case, not two — the whole point of retry-collapsing.
      expect(allCases.filter((c) => c.name === 'is flaky and eventually passes')).toHaveLength(1);

      // Regression coverage for a bug found by deep self-review: a test
      // whose beforeEach hook fails was previously silently dropped from
      // the report entirely (never uploaded as failed, never uploaded at
      // all) because Mocha's runner fires 'fail' with a Hook-typed
      // runnable for this, not the guarded Test — see mocha-listener.ts's
      // hook-failure handling.
      const hookFailureCase = allCases.find(
        (c) => c.name === 'never runs its body because the guarding beforeEach hook fails first',
      );
      expect(hookFailureCase).toBeDefined();
      expect(hookFailureCase.status).toBe('failed');
      expect(typeof hookFailureCase.error).toBe('string');
      expect(hookFailureCase.error).toContain('qualflare-cypress-integration-test-hook-failure-marker');

      // Regression coverage for another bug found by deep self-review: a
      // statically-skipped test (it.skip(...)) previously leaked forever in
      // an internal Map (Mocha never runs afterEach for it at all) instead
      // of ever being uploaded — see mocha-listener.ts's `drainOrphaned`,
      // swept from the NEXT real test's afterEach in the same spec.
      const skippedCase = allCases.find((c) => c.name === 'is statically skipped and never runs');
      expect(skippedCase).toBeDefined();
      expect(skippedCase.status).toBe('skipped');
      const afterSkipCase = allCases.find((c) => c.name === 'a normal test that runs right after the skip');
      expect(afterSkipCase).toBeDefined();
      expect(afterSkipCase.status).toBe('passed');

      const metadataCase = allCases.find((c) => c.name === 'exercises the author-facing metadata calls');
      expect(metadataCase).toBeDefined();
      expect(metadataCase.labels).toEqual(expect.arrayContaining([{ name: 'epic', value: 'Integration Testing' }]));
      expect(metadataCase.tags).toEqual(expect.arrayContaining(['smoke', 'qualflare-cypress-self-test']));
      expect(metadataCase.description).toContain('Exercises the qualflare.* metadata API');
      expect(metadataCase.links?.[0]).toMatchObject({ type: 'issue', url: 'https://example.com/issue/1' });
      // A parameter() call outside any step lands in Case.properties (see
      // docs/METADATA-API.md's placement rule).
      expect(metadataCase.properties?.['outside-step-param']).toBe('outside-value');
      // A parameter() call inside qualflare.step() lands on that step's parameters[].
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the wire, see the `collect` cast above
      const manualStep = (metadataCase.steps as any[] | undefined)?.find((s) => s.name === 'a manual step');
      expect(manualStep).toBeDefined();
      expect(manualStep.parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'inside-step-param', value: 'inside-value' })]),
      );

      // No video/screenshot content ever ships in this fixture (video: false,
      // no explicit cy.screenshot() calls) — a light structural guard that
      // nothing accidentally attached one.
      for (const c of allCases) {
        for (const att of c.attachments ?? []) {
          expect(att.mimeType).not.toMatch(/^video\//);
        }
      }
    },
    120_000,
  );
});
