import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeDelay } from '../../src/http/backoff.js';

describe('computeDelay', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(1); // full jitter at its max — deterministic upper bound
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grows exponentially with attempt number, up to the cap', () => {
    expect(computeDelay(1, 1000, 30_000)).toBe(1000); // 1000 * 2^0 * jitter(1) = 1000
    expect(computeDelay(2, 1000, 30_000)).toBe(2000); // 1000 * 2^1
    expect(computeDelay(3, 1000, 30_000)).toBe(4000); // 1000 * 2^2
  });

  it('caps the delay at maxDelayMs even for a large attempt number', () => {
    expect(computeDelay(10, 1000, 30_000)).toBe(30_000);
  });

  it('never returns a negative delay for attempt 0 or below', () => {
    expect(computeDelay(0, 1000, 30_000)).toBe(1000); // treated the same as attempt 1
  });

  it('honors a Retry-After value that exceeds the computed delay', () => {
    expect(computeDelay(1, 1000, 30_000, 5000)).toBe(5000);
  });

  it('does not let Retry-After exceed maxDelayMs', () => {
    expect(computeDelay(1, 1000, 30_000, 999_999)).toBe(30_000);
  });

  it('ignores a Retry-After value smaller than the computed delay', () => {
    expect(computeDelay(3, 1000, 30_000, 10)).toBe(4000);
  });

  it('applies jitter — with Math.random mocked to 0, the delay is 0 (no Retry-After floor)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(computeDelay(2, 1000, 30_000)).toBe(0);
  });
});
