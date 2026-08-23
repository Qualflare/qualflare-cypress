import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttemptSnapshot } from '../../src/browser/case-builder.js';
import { flushCase } from '../../src/browser/queue.js';
import { TASK_REPORT_CASE } from '../../src/shared/constants.js';

/** A minimal fake of the `Mocha.Test` surface `flushCase` actually reads:
 * `fullTitle()`, `title`, `parent?.fullTitle()`. */
function fakeTest(title: string, parentTitle?: string): Mocha.Test {
  return {
    title,
    fullTitle: () => (parentTitle ? `${parentTitle} ${title}` : title),
    parent: parentTitle ? { fullTitle: () => parentTitle } : undefined,
  } as unknown as Mocha.Test;
}

describe('flushCase', () => {
  let taskSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    taskSpy = vi.fn();
    (globalThis as unknown as { cy: { task: typeof taskSpy } }).cy = { task: taskSpy };
  });

  it('does nothing — never calls cy.task() — for zero attempts', () => {
    // e.g. a defensive no-op path when takeIfFinal()/takeNow() find nothing
    // to flush (already finalized elsewhere, or genuinely nothing recorded).
    flushCase(fakeTest('a test'), []);
    expect(taskSpy).not.toHaveBeenCalled();
  });

  it('sends the collapsed Case via cy.task(TASK_REPORT_CASE, ..., {log: false})', () => {
    const attempts: AttemptSnapshot[] = [{ status: 'passed', duration: 100 }];
    flushCase(fakeTest('does the thing', 'a suite'), attempts);

    expect(taskSpy).toHaveBeenCalledTimes(1);
    const [taskName, testCase, options] = taskSpy.mock.calls[0]!;
    expect(taskName).toBe(TASK_REPORT_CASE);
    expect(options).toEqual({ log: false });
    expect(testCase).toMatchObject({
      id: 'a suite does the thing',
      name: 'does the thing',
      className: 'a suite',
      status: 'passed',
    });
  });

  it('a test with no parent describe block has className undefined, not an empty string', () => {
    flushCase(fakeTest('top-level test'), [{ status: 'passed', duration: 10 }]);
    const testCase = taskSpy.mock.calls[0]![1];
    expect(testCase.className).toBeUndefined();
  });

  it('reflects a failed-then-passed (flaky) collapse correctly in the uploaded Case', () => {
    const attempts: AttemptSnapshot[] = [
      { status: 'failed', duration: 50, error: 'boom' },
      { status: 'passed', duration: 40 },
    ];
    flushCase(fakeTest('flaky test'), attempts);
    const testCase = taskSpy.mock.calls[0]![1];
    expect(testCase.status).toBe('passed');
    expect(testCase.retryCount).toBe(1);
    expect(testCase.isFlaky).toBe(true);
    expect(testCase.error).toBeUndefined();
  });

  it('carries priority through from the collapsed attempt', () => {
    const attempts: AttemptSnapshot[] = [{ status: 'passed', duration: 10, priority: 'high' }];
    flushCase(fakeTest('a prioritized test'), attempts);
    const testCase = taskSpy.mock.calls[0]![1];
    expect(testCase.priority).toBe('high');
  });

  it('a case guarded by a failed beforeEach hook (no attempt ever ran) still uploads as failed with the hook error', () => {
    // Mirrors what mocha-listener.ts's hook-failure handling produces: a
    // single synthetic attempt with duration 0 (the test body never ran)
    // and the hook's own error message.
    const attempts: AttemptSnapshot[] = [{ status: 'failed', duration: 0, error: 'beforeEach hook failed: setup error' }];
    flushCase(fakeTest('needs setup'), attempts);
    const testCase = taskSpy.mock.calls[0]![1];
    expect(testCase.status).toBe('failed');
    expect(testCase.duration).toBe(0);
    expect(testCase.error).toBe('beforeEach hook failed: setup error');
  });
});
