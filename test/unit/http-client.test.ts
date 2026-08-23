import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QualflareHttpClient } from '../../src/http/client.js';
import { QualflareApiError } from '../../src/http/errors.js';
import type { Collect } from '../../src/shared/types.js';

const ENDPOINT = 'https://qualflare.test';

const MINIMAL_COLLECT: Collect = {
  framework: 'cypress',
  platform: 'web',
  os: 'macOS',
  browser: 'chrome',
  branch: null,
  commit: null,
  environment: 'development',
  language: 'en-US',
  milestone: null,
  metadata: null,
  suites: [],
};

function baseOptions() {
  return {
    endpoint: ENDPOINT,
    token: 'test-token',
    timeoutMs: 5000,
    retry: { max: 3, baseDelayMs: 1, maxDelayMs: 5 }, // tiny delays so tests run fast
    userAgent: 'qualflare-cypress-test',
    debug: false,
  };
}

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
  vi.restoreAllMocks();
});

describe('QualflareHttpClient.send', () => {
  it('succeeds on the first attempt and returns the parsed seq', async () => {
    const pool = mockAgent.get(ENDPOINT);
    pool
      .intercept({ path: '/api/v1/collect', method: 'POST' })
      .reply(201, JSON.stringify({ seq: 42 }), { headers: { 'content-type': 'application/json' } });

    const client = new QualflareHttpClient(baseOptions());
    const result = await client.send(MINIMAL_COLLECT);
    expect(result).toEqual({ seq: 42 });
  });

  it('retries on 503 twice then succeeds, reusing the SAME Idempotency-Key across every attempt', async () => {
    const pool = mockAgent.get(ENDPOINT);
    const seenIdempotencyKeys: unknown[] = [];

    const recordAndReply = (statusCode: number, data: unknown) =>
      pool
        .intercept({ path: '/api/v1/collect', method: 'POST' })
        .reply((opts) => {
          const headers = opts.headers as Record<string, string>;
          seenIdempotencyKeys.push(headers['Idempotency-Key']);
          return {
            statusCode,
            data: JSON.stringify(data),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        })
        .times(1);

    recordAndReply(503, { code: 'common.unknown', message: 'temporarily unavailable' });
    recordAndReply(503, { code: 'common.unknown', message: 'temporarily unavailable' });
    recordAndReply(201, { seq: 7 });

    const client = new QualflareHttpClient(baseOptions());
    const result = await client.send(MINIMAL_COLLECT);

    expect(result).toEqual({ seq: 7 });
    expect(seenIdempotencyKeys).toHaveLength(3);
    expect(seenIdempotencyKeys[0]).toBeTruthy();
    expect(seenIdempotencyKeys[0]).toBe(seenIdempotencyKeys[1]);
    expect(seenIdempotencyKeys[1]).toBe(seenIdempotencyKeys[2]);
  });

  it('does not retry a 400 — fails immediately with the server-provided message', async () => {
    const pool = mockAgent.get(ENDPOINT);
    let requestCount = 0;
    pool
      .intercept({ path: '/api/v1/collect', method: 'POST' })
      .reply(() => {
        requestCount += 1;
        return {
          statusCode: 400,
          data: JSON.stringify({
            code: 'common.validation_failed',
            message: 'some fields are invalid',
            fields: [{ field: 'name', rule: 'required', message: 'field is required' }],
            request_id: 'req-123',
          }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .times(5); // only 1 should actually be consumed

    const client = new QualflareHttpClient(baseOptions());
    await expect(client.send(MINIMAL_COLLECT)).rejects.toThrow(QualflareApiError);
    expect(requestCount).toBe(1);
  });

  it('renders fields[] into the thrown error message (a gap the existing Go CLI has)', async () => {
    const pool = mockAgent.get(ENDPOINT);
    pool.intercept({ path: '/api/v1/collect', method: 'POST' }).reply(
      400,
      JSON.stringify({
        code: 'common.validation_failed',
        message: 'some fields are invalid',
        fields: [{ field: 'name', rule: 'required', message: 'field is required' }],
      }),
      { headers: { 'content-type': 'application/json' } },
    );

    const client = new QualflareHttpClient(baseOptions());
    await expect(client.send(MINIMAL_COLLECT)).rejects.toThrow(/name \(required\): field is required/);
  });

  it('gives up after exhausting all retries on repeated 503s', async () => {
    const pool = mockAgent.get(ENDPOINT);
    let requestCount = 0;
    pool
      .intercept({ path: '/api/v1/collect', method: 'POST' })
      .reply(() => {
        requestCount += 1;
        return { statusCode: 503, data: JSON.stringify({ message: 'still down' }) };
      })
      .times(10);

    const client = new QualflareHttpClient(baseOptions()); // retry.max = 3 -> 4 total attempts
    await expect(client.send(MINIMAL_COLLECT)).rejects.toThrow(QualflareApiError);
    expect(requestCount).toBe(4);
  });

  it('never follows a redirect', async () => {
    const pool = mockAgent.get(ENDPOINT);
    pool
      .intercept({ path: '/api/v1/collect', method: 'POST' })
      .reply(302, undefined, { headers: { location: 'https://evil.test/steal-token' } });

    const client = new QualflareHttpClient(baseOptions());
    // A 302 is not in the retryable set and undici must not have chased the
    // redirect itself (maxRedirections: 0) — either way this must not
    // resolve as if it were a 2xx success.
    await expect(client.send(MINIMAL_COLLECT)).rejects.toThrow();
  });
});
