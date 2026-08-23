import { describe, expect, it } from 'vitest';

import { msToNs } from '../../src/shared/duration.js';

describe('msToNs', () => {
  it('converts whole milliseconds to nanoseconds', () => {
    expect(msToNs(1)).toBe(1_000_000);
    expect(msToNs(1234)).toBe(1_234_000_000);
  });

  it('rounds fractional milliseconds rather than truncating', () => {
    // 1.5ms * 1_000_000 = 1_500_000 exactly, so this alone wouldn't catch a
    // truncate-vs-round bug — use a value whose ms*1e6 product itself has a
    // fractional component to force the distinction.
    expect(msToNs(0.0000001)).toBe(0);
    expect(msToNs(1.0000006)).toBe(1_000_001); // rounds up from 1_000_000.6
  });

  it('returns 0 for zero input', () => {
    expect(msToNs(0)).toBe(0);
  });

  it('clamps negative input to 0 instead of returning a negative duration', () => {
    expect(msToNs(-5)).toBe(0);
  });

  it('returns 0 for non-finite input rather than propagating NaN/Infinity onto the wire', () => {
    expect(msToNs(Number.NaN)).toBe(0);
    expect(msToNs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
