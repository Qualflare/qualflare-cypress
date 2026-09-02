import { describe, expect, it } from 'vitest';

import { collapseAttempts, type AttemptSnapshot } from '../../src/browser/case-builder.js';
import { MAX_ATTEMPTS_PER_CASE } from '../../src/shared/constants.js';

const failed = (error?: string): AttemptSnapshot => ({ status: 'failed', duration: 100, error });
const passed = (duration = 90): AttemptSnapshot => ({ status: 'passed', duration });

describe('collapseAttempts attempt history', () => {
  // A test that ran once has no history: its status, duration and error are
  // already on the Case. The server discards a one-element array, so sending
  // one is payload spent against the 10MB body limit for a row it drops.
  it('sends no history for a test that was not retried', () => {
    expect(collapseAttempts([passed()]).attempts).toBeUndefined();
  });

  it('numbers attempts 1..N in execution order, with nanosecond durations', () => {
    const result = collapseAttempts([failed('boom'), failed('boom again'), passed(90)]);

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts!.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(result.attempts!.map((a) => a.status)).toEqual(['failed', 'failed', 'passed']);
    // The snapshots are milliseconds; the wire is nanoseconds. `duration` on
    // the collapsed result stays ms, so these two units coexist deliberately.
    expect(result.attempts!.map((a) => a.duration)).toEqual([100_000_000, 100_000_000, 90_000_000]);
    expect(result.duration).toBe(290);
  });

  // The final attempt must be present. The server overwrites its status and
  // duration from the Case but keeps its message — omitting it would lose the
  // error text of the execution that actually counted.
  it('includes the final attempt, not only the failed ones', () => {
    const result = collapseAttempts([failed('boom'), passed()]);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts![1]!.status).toBe('passed');
  });

  // The collapsed `error` is dropped when the final attempt passed, which is
  // exactly when the earlier failure is most worth keeping — this is the gap
  // the attempt history closes.
  it('preserves an earlier failure that the collapsed error discards', () => {
    const result = collapseAttempts([failed('assertion failed on try 1'), passed()]);

    expect(result.error).toBeUndefined();
    expect(result.attempts![0]!.message).toBe('assertion failed on try 1');
    expect(result.attempts![1]!.message).toBeUndefined();
  });

  // Over the cap the server keeps the first 49 plus the final one. Trimming the
  // same way here means the bytes are never sent, and the FINAL attempt
  // survives — a plain slice(0, 50) would drop it.
  it('caps at the server limit while preserving the final attempt', () => {
    const attempts = [...Array.from({ length: 60 }, () => failed('boom')), passed(999)];
    const result = collapseAttempts(attempts);

    expect(result.attempts).toHaveLength(MAX_ATTEMPTS_PER_CASE);
    expect(result.attempts![MAX_ATTEMPTS_PER_CASE - 1]!.status).toBe('passed');
    expect(result.attempts![MAX_ATTEMPTS_PER_CASE - 1]!.duration).toBe(999_000_000);
    // Contiguous from 1, so the server does not read the trim as a hole.
    expect(result.attempts!.map((a) => a.attempt)).toEqual(
      Array.from({ length: MAX_ATTEMPTS_PER_CASE }, (_, i) => i + 1),
    );
  });

  // retryCount and isFlaky are aggregates the server also derives from the
  // attempt history; they must keep agreeing with it.
  it('stays consistent with retryCount and isFlaky', () => {
    const result = collapseAttempts([failed('boom'), failed('boom'), passed()]);
    expect(result.retryCount).toBe(2);
    expect(result.attempts).toHaveLength(result.retryCount + 1);
    expect(result.isFlaky).toBe(true);
  });
});
