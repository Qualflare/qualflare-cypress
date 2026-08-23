import { randomUUID } from 'node:crypto';

import { MAX_IDEMPOTENCY_KEY_CHARS } from '../shared/constants.js';

/**
 * Returns a fresh RFC 4122 v4 UUID string for use as an `Idempotency-Key`.
 * Call ONCE per logical `send()` attempt and reuse the same value across
 * every retry of that call — the server resolves a retried key to the
 * already-created launch, so a mid-flight 5xx retry cannot double-create.
 * Mirrors `qualflare-cli/internal/adapters/http/client.go`'s
 * `newIdempotencyKey`, using the platform RNG instead of a hand-rolled one.
 */
export function newIdempotencyKey(): string {
  const key = randomUUID();
  // A UUID is always 36 chars, well under the server's 255-char cap — this
  // assertion exists purely to fail loudly if that invariant ever changes
  // upstream, not because truncation here would ever be reachable.
  if (key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return key.slice(0, MAX_IDEMPOTENCY_KEY_CHARS);
  }
  return key;
}
