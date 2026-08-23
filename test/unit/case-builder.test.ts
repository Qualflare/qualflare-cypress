import { describe, expect, it } from 'vitest';

import { collapseAttempts, type AttemptSnapshot } from '../../src/browser/case-builder.js';

describe('collapseAttempts', () => {
  it('passing on the first try: retryCount 0, not flaky', () => {
    const attempts: AttemptSnapshot[] = [{ status: 'passed', duration: 120 }];
    const result = collapseAttempts(attempts);
    expect(result).toEqual({
      status: 'passed',
      duration: 120,
      retryCount: 0,
      isFlaky: false,
      error: undefined,
    });
  });

  it('fails then passes on retry: flaky, retryCount reflects attempt count, duration is summed', () => {
    const attempts: AttemptSnapshot[] = [
      { status: 'failed', duration: 100, error: 'boom' },
      { status: 'passed', duration: 90 },
    ];
    const result = collapseAttempts(attempts);
    expect(result.status).toBe('passed');
    expect(result.retryCount).toBe(1);
    expect(result.isFlaky).toBe(true);
    expect(result.duration).toBe(190);
    // Final status is passed, so the error from the earlier failed attempt
    // is not carried onto the collapsed result.
    expect(result.error).toBeUndefined();
  });

  it('fails on every attempt: not flaky (never recovered), final error is reported', () => {
    const attempts: AttemptSnapshot[] = [
      { status: 'failed', duration: 50, error: 'first failure' },
      { status: 'failed', duration: 55, error: 'second failure' },
    ];
    const result = collapseAttempts(attempts);
    expect(result.status).toBe('failed');
    expect(result.retryCount).toBe(1);
    expect(result.isFlaky).toBe(false);
    expect(result.duration).toBe(105);
    expect(result.error).toBe('second failure');
  });

  it('a single failed attempt with no retry: not flaky', () => {
    const attempts: AttemptSnapshot[] = [{ status: 'failed', duration: 10, error: 'nope' }];
    const result = collapseAttempts(attempts);
    expect(result.retryCount).toBe(0);
    expect(result.isFlaky).toBe(false);
    expect(result.error).toBe('nope');
  });

  it('throws on an empty attempts array rather than fabricating a result', () => {
    expect(() => collapseAttempts([])).toThrow();
  });

  describe('steps', () => {
    it('a single-attempt test carries that attempt\'s steps through unchanged', () => {
      const steps = [{ name: 'get', status: 'passed' as const, duration: 1000 }];
      const attempts: AttemptSnapshot[] = [{ status: 'passed', duration: 120, steps }];
      // toStrictEqual (value), not toBe (reference): collapseAttempts now
      // combines auto-captured and qualflare.step()-declared steps into a
      // freshly-built array (see case-builder.ts's combineSteps), so it no
      // longer passes the input steps array through by reference even when
      // there are no manual steps to merge in — the DATA is still expected
      // to be unchanged, which this now correctly asserts.
      expect(collapseAttempts(attempts).steps).toStrictEqual(steps);
    });

    it('on retry, only the FINAL attempt\'s steps ship — earlier attempts\' steps are discarded, not merged', () => {
      const failedAttemptSteps = [{ name: 'get', status: 'failed' as const, duration: 500 }];
      const passedAttemptSteps = [
        { name: 'get', status: 'passed' as const, duration: 300 },
        { name: 'click', status: 'passed' as const, duration: 100 },
      ];
      const attempts: AttemptSnapshot[] = [
        { status: 'failed', duration: 500, error: 'boom', steps: failedAttemptSteps },
        { status: 'passed', duration: 400, steps: passedAttemptSteps },
      ];
      const result = collapseAttempts(attempts);
      expect(result.steps).toStrictEqual(passedAttemptSteps);
      expect(result.steps).toHaveLength(2);
    });

    it('an attempt with no captured steps collapses to undefined, not an empty array', () => {
      const attempts: AttemptSnapshot[] = [{ status: 'passed', duration: 50 }];
      expect(collapseAttempts(attempts).steps).toBeUndefined();
    });

    describe('combining auto-captured (command-log) and manual (qualflare.step()) steps', () => {
      it('manual steps are appended after auto steps, with parentIndex shifted by the auto-step count', () => {
        const autoSteps = [
          { name: 'get', status: 'passed' as const, duration: 100 },
          { name: 'click', status: 'passed' as const, duration: 50 },
        ];
        const attempts: AttemptSnapshot[] = [
          {
            status: 'passed',
            duration: 200,
            steps: autoSteps,
            manualSteps: [
              { name: 'outer', status: 'passed', startedAt: 0, durationMs: 100 },
              { name: 'inner', status: 'passed', startedAt: 10, durationMs: 50, parentIndex: 0 },
            ],
          },
        ];
        const result = collapseAttempts(attempts);
        expect(result.steps).toStrictEqual([
          { name: 'get', status: 'passed', duration: 100 },
          { name: 'click', status: 'passed', duration: 50 },
          // manual step 0's own parentIndex was undefined (top-level) — stays undefined.
          { name: 'outer', status: 'passed', duration: 100_000_000 }, // 100ms -> ns
          // manual step 1's parentIndex was 0 (relative to the manual-only array) ->
          // shifted by autoSteps.length (2) to correctly index into the combined array.
          { name: 'inner', status: 'passed', duration: 50_000_000, parentIndex: 2 },
        ]);
      });

      it('manual steps alone (no auto-captured steps) still produce a correctly-indexed array', () => {
        const attempts: AttemptSnapshot[] = [
          {
            status: 'passed',
            duration: 100,
            manualSteps: [{ name: 'only step', status: 'passed', startedAt: 0, durationMs: 10 }],
          },
        ];
        expect(collapseAttempts(attempts).steps).toStrictEqual([
          { name: 'only step', status: 'passed', duration: 10_000_000 },
        ]);
      });

      it('a manual step with no recorded duration (endStep never ran) falls back to 0, not NaN/undefined', () => {
        const attempts: AttemptSnapshot[] = [
          { status: 'failed', duration: 100, manualSteps: [{ name: 'abandoned', status: 'pending', startedAt: 0 }] },
        ];
        expect(collapseAttempts(attempts).steps).toStrictEqual([{ name: 'abandoned', status: 'pending', duration: 0 }]);
      });

      it('neither auto nor manual steps present -> undefined, not an empty array', () => {
        const attempts: AttemptSnapshot[] = [{ status: 'passed', duration: 10, manualSteps: [] }];
        expect(collapseAttempts(attempts).steps).toBeUndefined();
      });
    });
  });

  describe('carrying labels/links/tags/description/priority/properties/attachments from the final attempt', () => {
    it('passes through everything the final attempt\'s qualflare.* metadata accumulated', () => {
      const attempts: AttemptSnapshot[] = [
        { status: 'failed', duration: 10, labels: [{ name: 'x', value: 'y' }], priority: 'low' }, // abandoned attempt
        {
          status: 'passed',
          duration: 20,
          labels: [{ name: 'epic', value: 'Checkout' }],
          links: [{ type: 'custom', url: 'https://example.com' }],
          tags: ['smoke'],
          description: 'a description',
          priority: 'critical',
          properties: { userId: '1' },
          attachments: [{ name: 'a.txt', content: 'aGk=' }],
        },
      ];
      const result = collapseAttempts(attempts);
      // Only the FINAL attempt's data survives — the abandoned first
      // attempt's label/priority must not leak through.
      expect(result.labels).toStrictEqual([{ name: 'epic', value: 'Checkout' }]);
      expect(result.links).toStrictEqual([{ type: 'custom', url: 'https://example.com' }]);
      expect(result.tags).toStrictEqual(['smoke']);
      expect(result.description).toBe('a description');
      expect(result.priority).toBe('critical');
      expect(result.properties).toStrictEqual({ userId: '1' });
      expect(result.attachments).toStrictEqual([{ name: 'a.txt', content: 'aGk=' }]);
    });

    it('priority is undefined when the final attempt never set one', () => {
      const attempts: AttemptSnapshot[] = [{ status: 'passed', duration: 20 }];
      expect(collapseAttempts(attempts).priority).toBeUndefined();
    });
  });
});
