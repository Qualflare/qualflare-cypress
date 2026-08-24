import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentBudget } from '../../src/plugin/attachment-reader.js';
import { registerEvents } from '../../src/plugin/events.js';
import type { ResolvedPluginConfig } from '../../src/plugin/resolve-config.js';
import { CaseBuffer, registerTasks } from '../../src/plugin/tasks.js';
import { PendingAttachmentQueue, TestPhaseGate } from '../../src/plugin/state.js';
import { TASK_MARK_TEST_PHASE_STARTED, TASK_REPORT_CASE } from '../../src/shared/constants.js';
import type { Case } from '../../src/shared/types.js';

/**
 * A minimal fake of `Cypress.PluginEvents`: `on(name, handler)` records
 * whatever was registered under `name` (a plain function for most events,
 * or — for the special `'task'` event — an OBJECT of named task handlers,
 * matching real Cypress's own `on('task', {...})` shape). This drives the
 * real `registerEvents`/`registerTasks` wiring end-to-end without a real
 * Cypress process, which is what actually proves `after:screenshot` → the
 * pending-attachment queue → `TASK_REPORT_CASE` → a resolved attachment on
 * the buffered Case works TOGETHER — the pure `resolveAttachments` unit
 * tests alone only prove the resolution logic in isolation, not the wiring.
 */
function createFakeOn() {
  const registered = new Map<string, unknown>();
  const on = ((name: string, handler: unknown) => {
    registered.set(name, handler);
  }) as unknown as Cypress.PluginEvents;

  return {
    on,
    /** Fires a plain (non-task) plugin event by name. May return a Promise
     * (after:spec, after:run) — callers that care about ordering must await it. */
    fire: (name: string, ...args: unknown[]) => {
      const handler = registered.get(name) as (...a: unknown[]) => unknown;
      return handler(...args);
    },
    /** Fires a specific named task, as `cy.task(taskName, arg)` would. May
     * return a Promise (TASK_REPORT_CASE) — callers must await it. */
    fireTask: (taskName: string, arg: unknown) => {
      const tasks = registered.get('task') as Record<string, (a: unknown) => unknown>;
      return tasks[taskName]!(arg);
    },
  };
}

let tmpDir: string;
/** outputDirs created by individual tests (distinct from the shared `tmpDir`,
 * since `after:run` needs a dedicated, empty directory to write into and
 * assert against) — cleaned up alongside `tmpDir` in `afterEach`. */
let outputDirs: string[];

function freshOutputDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-events-'));
  outputDirs.push(dir);
  return dir;
}

const BASE_CONFIG: ResolvedPluginConfig = {
  environment: 'development',
  language: 'en-US',
  milestone: null,
  branch: null,
  commit: null,
  platform: 'web',
  framework: 'cypress',
  attachScreenshots: true,
  maxAttachmentBytes: 1_000_000,
  maxTotalAttachmentBytes: 1_000_000,
  maxVideoBytes: 50_000_000,
  enabled: true,
  outputDir: './qualflare-results',
};

let mockAgent: MockAgent;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cypress-flow-test-'));
  outputDirs = [];
  // The reporter never makes an HTTP call of any kind (see events.ts's
  // "never POSTs" rewrite) — disableNetConnect with no interceptors
  // registered means any accidental network attempt fails immediately,
  // making this suite itself the regression guard for that invariant.
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const dir of outputDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await mockAgent.close();
  vi.restoreAllMocks();
});

function fakeSpec(relative: string): Cypress.Spec {
  return { relative } as Cypress.Spec;
}

function fakeSpecResults(overrides: Partial<CypressCommandLine.RunResult> = {}): CypressCommandLine.RunResult {
  return {
    stats: { tests: 1, duration: 100, startedAt: new Date().toISOString() },
    video: null,
    ...overrides,
  } as unknown as CypressCommandLine.RunResult;
}

describe('screenshot -> case attachment flow (real registerEvents + registerTasks wiring)', () => {
  it('attaches a screenshot fired via after:screenshot to the case reported right after it', async () => {
    const { on, fire, fireTask } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    const budget = new AttachmentBudget(BASE_CONFIG.maxTotalAttachmentBytes);

    registerTasks(on, buffer, BASE_CONFIG, budget, pendingAttachments, testPhaseGate);
    registerEvents(on, BASE_CONFIG, buffer, pendingAttachments, testPhaseGate);

    const shotBytes = Buffer.from('fake png bytes');
    const shotPath = path.join(tmpDir, 'failure.png');
    fs.writeFileSync(shotPath, shotBytes);

    // The test has already started (its beforeEach fired) by the time it
    // takes its own screenshot — matches real Cypress event ordering.
    testPhaseGate.markStarted();

    // Simulate Cypress's real event order: a test fails, Cypress captures
    // its automatic failure screenshot (after:screenshot fires), THEN the
    // test's own afterEach flushes its Case via TASK_REPORT_CASE.
    fire('after:screenshot', { name: 'failure', path: shotPath, testFailure: true });

    const testCase: Case = { id: 'suite > test', name: 'test', status: 'failed', duration: 1_000_000 };
    await fireTask(TASK_REPORT_CASE, testCase);

    const drained = buffer.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.attachments).toHaveLength(1);
    expect(drained[0]!.attachments![0]!.name).toBe('failure');
    expect(drained[0]!.attachments![0]!.content).toBe(shotBytes.toString('base64'));
  });

  it('does not leak a screenshot into a DIFFERENT case reported afterward', async () => {
    const { on, fireTask } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    const budget = new AttachmentBudget(BASE_CONFIG.maxTotalAttachmentBytes);
    registerTasks(on, buffer, BASE_CONFIG, budget, pendingAttachments, testPhaseGate);

    // No after:screenshot fired at all for this case.
    await fireTask(TASK_REPORT_CASE, { id: 'a', name: 'a', status: 'passed', duration: 1 } satisfies Case);
    await fireTask(TASK_REPORT_CASE, { id: 'b', name: 'b', status: 'passed', duration: 1 } satisfies Case);

    const drained = buffer.drain();
    expect(drained[0]!.attachments).toBeUndefined();
    expect(drained[1]!.attachments).toBeUndefined();
  });

  it('drops (and does not carry into the next spec) a screenshot never claimed by any TASK_REPORT_CASE', async () => {
    const { on, fire } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();

    registerEvents(on, BASE_CONFIG, buffer, pendingAttachments, testPhaseGate);

    const shotPath = path.join(tmpDir, 'orphan.png');
    fs.writeFileSync(shotPath, Buffer.from('orphan'));

    fire('before:spec', fakeSpec('a.cy.ts'));
    testPhaseGate.markStarted(); // simulates: taken during/after a real test, not in a before() hook
    // Screenshot fires but no case ever claims it (e.g. taken in an `after` hook).
    fire('after:screenshot', { name: 'orphan', path: shotPath, testFailure: false });
    await fire('after:spec', fakeSpec('a.cy.ts'), fakeSpecResults({ stats: { tests: 0, duration: 10, startedAt: new Date().toISOString() } }));

    // The queue must be empty afterward — nothing should leak into spec b.
    expect(pendingAttachments.drain()).toHaveLength(0);
  });

  it('never copies a spec video into outputDir when no case in the spec failed', async () => {
    const { on, fire } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    const outputDir = freshOutputDir();
    const config: ResolvedPluginConfig = { ...BASE_CONFIG, outputDir };
    registerEvents(on, config, buffer, pendingAttachments, testPhaseGate);

    fire('before:spec', fakeSpec('a.cy.ts'));
    await fire(
      'after:spec',
      fakeSpec('a.cy.ts'),
      fakeSpecResults({ video: '/some/path/a.cy.ts.mp4', stats: { tests: 0, duration: 10, startedAt: new Date().toISOString() } }),
    );

    // An all-passing (here: empty) spec's video is never copied — outputDir
    // stays untouched (it isn't even created).
    expect(pendingAttachments.drain()).toHaveLength(0);
    expect(fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []).toHaveLength(0);
  });

  it("copies a failing spec's video into outputDir and attaches localVideoPath to the first failing case", async () => {
    const { on, fire, fireTask } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    const budget = new AttachmentBudget(BASE_CONFIG.maxTotalAttachmentBytes);
    const outputDir = freshOutputDir();
    const config: ResolvedPluginConfig = { ...BASE_CONFIG, outputDir };

    registerTasks(on, buffer, config, budget, pendingAttachments, testPhaseGate);
    registerEvents(on, config, buffer, pendingAttachments, testPhaseGate);

    const videoBytes = Buffer.from('fake video bytes');
    const videoPath = path.join(tmpDir, 'a.cy.ts.mp4');
    fs.writeFileSync(videoPath, videoBytes);

    // before:spec fires first (as in real Cypress) — it defensively drains
    // the buffer, so reporting the case must happen after it, not before.
    fire('before:spec', fakeSpec('a.cy.ts'));
    testPhaseGate.markStarted();
    const testCase: Case = { id: 'suite > test', name: 'test', status: 'failed', duration: 1_000_000 };
    await fireTask(TASK_REPORT_CASE, testCase);

    // after:spec drains the buffer INTO the accumulator itself (not back out
    // to the caller) — the only externally observable proof of what ended up
    // on the Case is the eventual written Collect JSON, so drive the flow
    // all the way through after:run rather than trying to re-drain the buffer.
    await fire(
      'after:spec',
      fakeSpec('a.cy.ts'),
      fakeSpecResults({ video: videoPath, stats: { tests: 1, duration: 10, startedAt: new Date().toISOString() } }),
    );
    await fire('after:run');

    const writtenJson = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
    expect(writtenJson).toHaveLength(1);
    const collect = JSON.parse(fs.readFileSync(path.join(outputDir, writtenJson[0]!), 'utf8')) as {
      suites: Array<{ cases: Case[] }>;
    };
    const writtenCase = collect.suites[0]!.cases[0]!;
    expect(writtenCase.attachments).toHaveLength(1);
    const attachment = writtenCase.attachments![0]!;
    expect(attachment.mimeType).toBe('video/mp4');
    expect(attachment.storageKey).toBeUndefined();
    expect(attachment.content).toBeUndefined();
    expect(attachment.localVideoPath).toBeDefined();

    // The video file itself must actually have been copied into outputDir,
    // alongside the Collect JSON, under the localVideoPath it reports.
    const copiedVideoPath = path.join(outputDir, attachment.localVideoPath!);
    expect(fs.readFileSync(copiedVideoPath)).toEqual(videoBytes);
  });

  it('drops (does not attach to the first test) a screenshot taken before any test has started, e.g. in a root before() hook', async () => {
    // Regression test for the misattribution bug found via deep adversarial
    // self-review: a screenshot taken in a root `before()` hook fires
    // after:screenshot BEFORE any test has started — previously it sat in
    // PendingAttachmentQueue and got silently swept into whichever test's
    // TASK_REPORT_CASE happened to arrive first, misattributing it.
    const { on, fire, fireTask } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    const budget = new AttachmentBudget(BASE_CONFIG.maxTotalAttachmentBytes);

    registerTasks(on, buffer, BASE_CONFIG, budget, pendingAttachments, testPhaseGate);
    registerEvents(on, BASE_CONFIG, buffer, pendingAttachments, testPhaseGate);

    fire('before:spec', fakeSpec('a.cy.ts'));

    const beforeHookShotPath = path.join(tmpDir, 'before-hook.png');
    fs.writeFileSync(beforeHookShotPath, Buffer.from('before hook screenshot'));

    // A before() hook screenshot: after:screenshot fires BEFORE the
    // TASK_MARK_TEST_PHASE_STARTED task ever does.
    fire('after:screenshot', { name: 'before-hook-shot', path: beforeHookShotPath, testFailure: false });

    // NOW the first test starts (its root beforeEach fires the one-shot signal).
    fireTask(TASK_MARK_TEST_PHASE_STARTED, null);

    // The first real test takes its OWN screenshot during its own execution.
    const ownShotPath = path.join(tmpDir, 'own.png');
    const ownShotBytes = Buffer.from('the real test\'s own screenshot');
    fs.writeFileSync(ownShotPath, ownShotBytes);
    fire('after:screenshot', { name: 'own-shot', path: ownShotPath, testFailure: false });

    const testCase: Case = { id: 'suite > first test', name: 'first test', status: 'passed', duration: 1_000_000 };
    await fireTask(TASK_REPORT_CASE, testCase);

    const drained = buffer.drain();
    expect(drained).toHaveLength(1);
    // Only the test's OWN screenshot is attached — the before-hook one was
    // dropped as orphaned, not swept in alongside it.
    expect(drained[0]!.attachments).toHaveLength(1);
    expect(drained[0]!.attachments![0]!.name).toBe('own-shot');
    expect(drained[0]!.attachments![0]!.content).toBe(ownShotBytes.toString('base64'));
  });

  it('always writes the Collect payload to outputDir, never POSTs', async () => {
    const { on, fire, fireTask } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    const budget = new AttachmentBudget(BASE_CONFIG.maxTotalAttachmentBytes);
    const outputDir = freshOutputDir();
    const config: ResolvedPluginConfig = { ...BASE_CONFIG, outputDir };

    registerTasks(on, buffer, config, budget, pendingAttachments, testPhaseGate);
    registerEvents(on, config, buffer, pendingAttachments, testPhaseGate);

    fire('before:spec', fakeSpec('a.cy.ts'));
    testPhaseGate.markStarted();
    const testCase: Case = { id: 'suite > a passing test', name: 'a passing test', status: 'passed', duration: 1_000_000 };
    await fireTask(TASK_REPORT_CASE, testCase);
    await fire(
      'after:spec',
      fakeSpec('a.cy.ts'),
      fakeSpecResults({ stats: { tests: 1, duration: 10, startedAt: new Date().toISOString() } }),
    );

    await fire('after:run');

    const written = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
    expect(written).toHaveLength(1);
    const collect = JSON.parse(fs.readFileSync(path.join(outputDir, written[0]!), 'utf8')) as {
      suites: Array<{ cases: Case[] }>;
    };
    expect(collect.suites[0]!.cases[0]!.name).toBe('a passing test');
  });

  it('stamps shardIndex on every case when config.shardIndex is set', async () => {
    const { on, fire, fireTask } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    const budget = new AttachmentBudget(BASE_CONFIG.maxTotalAttachmentBytes);
    const outputDir = freshOutputDir();
    const config: ResolvedPluginConfig = { ...BASE_CONFIG, outputDir, shardIndex: 2 };

    registerTasks(on, buffer, config, budget, pendingAttachments, testPhaseGate);
    registerEvents(on, config, buffer, pendingAttachments, testPhaseGate);

    fire('before:spec', fakeSpec('a.cy.ts'));
    testPhaseGate.markStarted();
    const testCase: Case = { id: 'suite > a passing test', name: 'a passing test', status: 'passed', duration: 1_000_000 };
    await fireTask(TASK_REPORT_CASE, testCase);
    await fire(
      'after:spec',
      fakeSpec('a.cy.ts'),
      fakeSpecResults({ stats: { tests: 1, duration: 10, startedAt: new Date().toISOString() } }),
    );

    await fire('after:run');

    const written = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'))[0]!;
    const collect = JSON.parse(fs.readFileSync(path.join(outputDir, written), 'utf8')) as {
      suites: Array<{ cases: Case[] }>;
    };
    expect(collect.suites[0]!.cases[0]!.shardIndex).toBe(2);
  });

  it('writes distinct filenames across two consecutive runs into the same outputDir', async () => {
    const outputDir = freshOutputDir();

    for (let i = 0; i < 2; i++) {
      const { on, fire, fireTask } = createFakeOn();
      const buffer = new CaseBuffer();
      const pendingAttachments = new PendingAttachmentQueue();
      const testPhaseGate = new TestPhaseGate();
      const budget = new AttachmentBudget(BASE_CONFIG.maxTotalAttachmentBytes);
      const config: ResolvedPluginConfig = { ...BASE_CONFIG, outputDir };

      registerTasks(on, buffer, config, budget, pendingAttachments, testPhaseGate);
      registerEvents(on, config, buffer, pendingAttachments, testPhaseGate);

      fire('before:spec', fakeSpec('a.cy.ts'));
      testPhaseGate.markStarted();
      const testCase: Case = { id: `suite > test ${i}`, name: `test ${i}`, status: 'passed', duration: 1_000_000 };
      await fireTask(TASK_REPORT_CASE, testCase);
      await fire(
        'after:spec',
        fakeSpec('a.cy.ts'),
        fakeSpecResults({ stats: { tests: 1, duration: 10, startedAt: new Date().toISOString() } }),
      );

      await fire('after:run');
    }

    const written = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
    expect(written).toHaveLength(2);
  });
});
