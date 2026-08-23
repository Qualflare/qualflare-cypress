/**
 * Computes the delay before retry attempt `attempt` (1-based: the delay
 * before the SECOND request, i.e. after the first failure). Exponential
 * backoff with full jitter, capped at `maxDelayMs` — intent-parity with the
 * Go CLI's resty-based exponential 1s->30s backoff (not necessarily
 * byte-identical; resty's internal jitter algorithm isn't something worth
 * reverse-engineering).
 *
 * When the server sent a `Retry-After` value (in milliseconds, already
 * parsed by the caller), the returned delay is never shorter than that —
 * honoring it is a defensible improvement the Go CLI doesn't make, cheap to
 * add, and directly useful against the known "questionable retry-on-429/503
 * behavior server-side" gap noted in api-service's own code-quality review.
 */
export function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs?: number,
): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jittered = Math.random() * Math.min(exponential, maxDelayMs);
  const floor = retryAfterMs !== undefined ? retryAfterMs : 0;
  // Bounded by maxDelayMs even when honoring a server Retry-After: a
  // pathological/misconfigured server value should never be able to hang a
  // CI job indefinitely.
  return Math.min(Math.max(jittered, floor), maxDelayMs);
}
