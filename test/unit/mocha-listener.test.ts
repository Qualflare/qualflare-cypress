import { describe, expect, it } from 'vitest';

import { MochaAttemptTracker } from '../../src/browser/mocha-listener.js';
import type { AttemptSnapshot } from '../../src/browser/case-builder.js';

function snapshot(status: AttemptSnapshot['status'], duration = 10): AttemptSnapshot {
  return { status, duration };
}

/** A minimal fake `Mocha.Test` — `MochaAttemptTracker` never calls anything
 * on it, just stores and hands it back, so identity (`toBe`) is what
 * matters in these tests, not any particular shape. */
function fakeTest(label: string): Mocha.Test {
  return { label } as unknown as Mocha.Test;
}

describe('MochaAttemptTracker', () => {
  describe('record() dedup', () => {
    it('a second record() with the same retryIndex for the same key is a no-op, not a duplicate', () => {
      const tracker = new MochaAttemptTracker();
      const test = fakeTest('a test');
      tracker.record('a test', 0, test, snapshot('failed'));
      tracker.record('a test', 0, test, snapshot('failed')); // e.g. both 'fail' and 'retry' firing for one attempt
      expect(tracker.takeIfFinal('a test')).toHaveLength(1);
    });

    it('a different retryIndex for the same key is recorded as a new attempt', () => {
      const tracker = new MochaAttemptTracker();
      const test = fakeTest('a test');
      tracker.record('a test', 0, test, snapshot('failed'));
      tracker.record('a test', 1, test, snapshot('passed'));
      expect(tracker.takeIfFinal('a test')).toHaveLength(2);
    });
  });

  describe('exhausted retries: fails on every attempt including the final one', () => {
    it('the final attempt correctly flushes even though it is itself a failure, not just a recovery', () => {
      // Proves the assumption `mocha-listener.ts` relies on (verified via
      // hand-tracing Cypress's actual runner source, but previously had
      // ZERO automated coverage): Mocha only emits 'retry' for an attempt
      // that still has retries remaining; the truly final, exhausted
      // failure fires 'fail' instead, never 'retry' — so `markWillRetry`
      // must NOT be called for it, and `takeIfFinal` must flush normally.
      const tracker = new MochaAttemptTracker();
      const key = 'flaky-but-never-recovers';
      const test = fakeTest(key);

      // Attempt 0: fails, has retries remaining.
      tracker.record(key, 0, test, snapshot('failed'));
      tracker.markWillRetry(key);
      expect(tracker.takeIfFinal(key)).toBeUndefined(); // afterEach for attempt 0: not final yet

      // Attempt 1: fails, has retries remaining.
      tracker.record(key, 1, test, snapshot('failed'));
      tracker.markWillRetry(key);
      expect(tracker.takeIfFinal(key)).toBeUndefined(); // afterEach for attempt 1: still not final

      // Attempt 2: fails, retries exhausted (Mocha does NOT emit 'retry'
      // for this one, so nothing calls markWillRetry here).
      tracker.record(key, 2, test, snapshot('failed'));
      const finalAttempts = tracker.takeIfFinal(key);
      expect(finalAttempts).toHaveLength(3);
      expect(finalAttempts!.every((a) => a.status === 'failed')).toBe(true);
    });
  });

  describe('flake-detection retry of a PASSED attempt (experimental strategies)', () => {
    it('markWillRetry can be paired with a passed snapshot without breaking the eventual final flush', () => {
      const tracker = new MochaAttemptTracker();
      const key = 'flake-detection-rerun';
      const test = fakeTest(key);
      tracker.record(key, 0, test, snapshot('passed'));
      tracker.markWillRetry(key); // 'retry' fired for a PASSED attempt (see mocha-listener.ts's guard on `err`)
      expect(tracker.takeIfFinal(key)).toBeUndefined();
      tracker.record(key, 1, test, snapshot('passed'));
      const final = tracker.takeIfFinal(key);
      expect(final).toHaveLength(2);
      expect(final!.every((a) => a.status === 'passed')).toBe(true);
    });
  });

  describe('takeIfFinal() edge cases', () => {
    it('returns undefined for a key that was never recorded, rather than throwing', () => {
      const tracker = new MochaAttemptTracker();
      expect(tracker.takeIfFinal('never seen')).toBeUndefined();
    });

    it('markWillRetry on a key with no entry yet is a harmless no-op', () => {
      const tracker = new MochaAttemptTracker();
      expect(() => tracker.markWillRetry('nothing recorded yet')).not.toThrow();
    });
  });

  describe('drainOrphaned(): statically-skipped tests, swept from the next real afterEach', () => {
    it('a recorded-but-never-collected entry is returned by drainOrphaned, with its test reference intact', () => {
      // Mirrors a statically-skipped test: 'pending' fires and records it,
      // but Mocha never runs afterEach for it — so nothing ever calls
      // takeIfFinal('skipped test'). The NEXT real test's afterEach must
      // sweep it via drainOrphaned instead.
      const tracker = new MochaAttemptTracker();
      const skippedTest = fakeTest('skipped test');
      tracker.record('skipped test', 0, skippedTest, snapshot('skipped'));

      // A different, real test's afterEach fires next, excluding its own key.
      const orphans = tracker.drainOrphaned('a real test that ran next');
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.test).toBe(skippedTest);
      expect(orphans[0]!.attempts).toHaveLength(1);
      expect(orphans[0]!.attempts[0]!.status).toBe('skipped');
    });

    it('does not re-return an already-drained entry on a later call (no duplicate upload)', () => {
      const tracker = new MochaAttemptTracker();
      tracker.record('skipped test', 0, fakeTest('skipped test'), snapshot('skipped'));
      expect(tracker.drainOrphaned('some other key')).toHaveLength(1);
      expect(tracker.drainOrphaned('some other key')).toHaveLength(0);
    });

    it('excludes the key passed as excludeKey (the afterEach caller is already handling that one itself)', () => {
      const tracker = new MochaAttemptTracker();
      const currentTest = fakeTest('the test whose own afterEach is running');
      tracker.record('the test whose own afterEach is running', 0, currentTest, snapshot('passed'));
      tracker.record('an orphaned skip', 0, fakeTest('an orphaned skip'), snapshot('skipped'));

      const orphans = tracker.drainOrphaned('the test whose own afterEach is running');
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.attempts[0]!.status).toBe('skipped');
      // The excluded key is untouched — still available via takeIfFinal, as
      // the real afterEach flow would do separately.
      expect(tracker.takeIfFinal('the test whose own afterEach is running')).toHaveLength(1);
    });

    it('never sweeps an entry that is still mid-retry (willRetry), even if some unrelated afterEach fires while it is in flight', () => {
      const tracker = new MochaAttemptTracker();
      const midRetryTest = fakeTest('failing, about to retry');
      tracker.record('failing, about to retry', 0, midRetryTest, snapshot('failed'));
      tracker.markWillRetry('failing, about to retry');

      // drainOrphaned must never sweep this — it's still waiting for its
      // own next attempt, not orphaned. drainOrphaned() deliberately does
      // NOT consume/reset the willRetry flag it skips over, unlike
      // takeIfFinal() — that consumption only happens on the entry's OWN
      // test's own afterEach cycle, simulated below via takeIfFinal, the
      // same call the real registerMochaListener flow makes for it.
      expect(tracker.drainOrphaned('some unrelated current test')).toHaveLength(0);

      // The entry's own afterEach (attempt 0, still mid-retry) correctly
      // finds nothing final yet, and consumes the flag.
      expect(tracker.takeIfFinal('failing, about to retry')).toBeUndefined();

      // Attempt 1 is the real final attempt (no further markWillRetry).
      tracker.record('failing, about to retry', 1, midRetryTest, snapshot('passed'));
      expect(tracker.takeIfFinal('failing, about to retry')).toHaveLength(2);
    });

    it('returns an empty array (not undefined) when nothing is orphaned', () => {
      const tracker = new MochaAttemptTracker();
      expect(tracker.drainOrphaned('whatever')).toEqual([]);
    });
  });

  describe('title collisions between two different, unrelated tests', () => {
    it('a second, later test sharing the first test\'s fullTitle() is recorded independently, not silently dropped', () => {
      // This is the core regression test for the bug found by deep review:
      // a spec-lifetime-global, never-cleared dedup Set caused a
      // title-colliding SECOND test's data to be dropped entirely,
      // independent of retries. The fix scopes dedup state to each test's
      // own entry, which is deleted the moment that test is finalized.
      const tracker = new MochaAttemptTracker();
      const collidingKey = 'describe a > describe b > it renders correctly';

      // Test A: passes, gets flushed and forgotten via the normal afterEach path.
      tracker.record(collidingKey, 0, fakeTest('Test A'), snapshot('passed'));
      const testAResult = tracker.takeIfFinal(collidingKey);
      expect(testAResult).toHaveLength(1);
      expect(testAResult![0]!.status).toBe('passed');

      // Test B: a LATER, DIFFERENT test that happens to produce the exact
      // same fullTitle() string. Must be recorded fresh, not silently
      // dropped by stale dedup state from Test A.
      const testB = fakeTest('Test B');
      tracker.record(collidingKey, 0, testB, snapshot('failed'));
      const testBResult = tracker.takeIfFinal(collidingKey);
      expect(testBResult).toHaveLength(1);
      expect(testBResult![0]!.status).toBe('failed');
    });

    it('a colliding test finalized via drainOrphaned (Test A was a static skip) does not poison a later Test B either', () => {
      const tracker = new MochaAttemptTracker();
      const collidingKey = 'it does the thing';

      tracker.record(collidingKey, 0, fakeTest('Test A (skipped)'), snapshot('skipped'));
      tracker.drainOrphaned('unrelated current test'); // Test A finalized immediately

      tracker.record(collidingKey, 0, fakeTest('Test B'), snapshot('passed'));
      const testBResult = tracker.takeIfFinal(collidingKey);
      expect(testBResult).toHaveLength(1);
      expect(testBResult![0]!.status).toBe('passed');
    });
  });
});
