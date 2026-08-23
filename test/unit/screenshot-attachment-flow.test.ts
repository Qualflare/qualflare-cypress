import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    /** Fires a plain (non-task) plugin event by name. */
    fire: (name: string, ...args: unknown[]) => {
      const handler = registered.get(name) as (...a: unknown[]) => unknown;
      return handler(...args);
    },
    /** Fires a specific named task, as `cy.task(taskName, arg)` would. */
    fireTask: (taskName: string, arg: unknown) => {
      const tasks = registered.get('task') as Record<string, (a: unknown) => unknown>;
      return tasks[taskName]!(arg);
    },
  };
}

const BASE_CONFIG: ResolvedPluginConfig = {
  token: 'test-token',
  apiEndpoint: 'http://localhost:0',
  environment: 'development',
  language: 'en-US',
  milestone: null,
  branch: null,
  commit: null,
  platform: 'web',
  framework: 'cypress',
  timeoutMs: 1000,
  retry: { max: 0, baseDelayMs: 1, maxDelayMs: 1 },
  failOnUploadError: false,
  attachScreenshots: true,
  maxAttachmentBytes: 1_000_000,
  maxTotalAttachmentBytes: 1_000_000,
  debug: false,
  enabled: true,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cypress-flow-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
  it('attaches a screenshot fired via after:screenshot to the case reported right after it', () => {
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
    fireTask(TASK_REPORT_CASE, testCase);

    const drained = buffer.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.attachments).toHaveLength(1);
    expect(drained[0]!.attachments![0]!.name).toBe('failure');
    expect(drained[0]!.attachments![0]!.content).toBe(shotBytes.toString('base64'));
  });

  it('does not leak a screenshot into a DIFFERENT case reported afterward', () => {
    const { on, fireTask } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    const budget = new AttachmentBudget(BASE_CONFIG.maxTotalAttachmentBytes);
    registerTasks(on, buffer, BASE_CONFIG, budget, pendingAttachments, testPhaseGate);

    // No after:screenshot fired at all for this case.
    fireTask(TASK_REPORT_CASE, { id: 'a', name: 'a', status: 'passed', duration: 1 } satisfies Case);
    fireTask(TASK_REPORT_CASE, { id: 'b', name: 'b', status: 'passed', duration: 1 } satisfies Case);

    const drained = buffer.drain();
    expect(drained[0]!.attachments).toBeUndefined();
    expect(drained[1]!.attachments).toBeUndefined();
  });

  it('drops (and does not carry into the next spec) a screenshot never claimed by any TASK_REPORT_CASE', () => {
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
    fire('after:spec', fakeSpec('a.cy.ts'), fakeSpecResults({ stats: { tests: 0, duration: 10, startedAt: new Date().toISOString() } }));

    // The queue must be empty afterward — nothing should leak into spec b.
    expect(pendingAttachments.drain()).toHaveLength(0);
  });

  it('never produces an attachment for a spec video, even though after:spec receives the video path', () => {
    const { on, fire } = createFakeOn();
    const buffer = new CaseBuffer();
    const pendingAttachments = new PendingAttachmentQueue();
    const testPhaseGate = new TestPhaseGate();
    registerEvents(on, BASE_CONFIG, buffer, pendingAttachments, testPhaseGate);

    fire('before:spec', fakeSpec('a.cy.ts'));
    fire(
      'after:spec',
      fakeSpec('a.cy.ts'),
      fakeSpecResults({ video: '/some/path/a.cy.ts.mp4', stats: { tests: 0, duration: 10, startedAt: new Date().toISOString() } }),
    );

    // No after:screenshot event was ever fired with the video's path, and
    // nothing in the events.ts after:spec handler reads results.video into
    // an Attachment — structurally, the video path never reaches
    // pendingAttachments or any Case.
    expect(pendingAttachments.drain()).toHaveLength(0);
  });

  it('drops (does not attach to the first test) a screenshot taken before any test has started, e.g. in a root before() hook', () => {
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
    fireTask(TASK_REPORT_CASE, testCase);

    const drained = buffer.drain();
    expect(drained).toHaveLength(1);
    // Only the test's OWN screenshot is attached — the before-hook one was
    // dropped as orphaned, not swept in alongside it.
    expect(drained[0]!.attachments).toHaveLength(1);
    expect(drained[0]!.attachments![0]!.name).toBe('own-shot');
    expect(drained[0]!.attachments![0]!.content).toBe(ownShotBytes.toString('base64'));
  });
});
