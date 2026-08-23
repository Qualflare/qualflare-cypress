import { describe, expect, it } from 'vitest';

import { newIdempotencyKey } from '../../src/http/idempotency.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('newIdempotencyKey', () => {
  it('returns a well-formed RFC 4122 v4 UUID string', () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4_RE);
  });

  it('returns a different value on each call', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  it('is well under the server-side 255-character cap', () => {
    expect(newIdempotencyKey().length).toBeLessThanOrEqual(255);
  });
});
