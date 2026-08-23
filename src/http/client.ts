import { request } from 'undici';

import {
  HEADER_ACCEPT,
  HEADER_CONTENT_TYPE,
  HEADER_IDEMPOTENCY_KEY,
  HEADER_TOKEN,
  HEADER_USER_AGENT,
} from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { ApiErrorResponse, Collect, CollectResult } from '../shared/types.js';
import { computeDelay } from './backoff.js';
import { buildApiError, QualflareApiError } from './errors.js';
import { newIdempotencyKey } from './idempotency.js';

export interface RetryOptions {
  max: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface SendOptions {
  endpoint: string;
  token: string;
  timeoutMs: number;
  retry: RetryOptions;
  userAgent: string;
  debug: boolean;
}

/** HTTP status codes worth retrying: a transient/transport-level condition
 * that a later attempt might succeed at. Mirrors
 * `qualflare-cli/internal/adapters/http/client.go`'s `AddRetryConditions`
 * exactly. 400/401/403/404/413/422 are all client-error conditions a retry
 * cannot fix. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function redactToken(token: string): string {
  return token.length > 0 ? '***REDACTED***' : '(none)';
}

/** POSTs a `Collect` payload to `/api/v1/collect`, mirroring the Go CLI's
 * resty-based HTTP client behavior: a stable per-call Idempotency-Key reused
 * across retries, exponential backoff with jitter on transport errors and
 * 429/500/502/503/504, disabled redirects (the auth token must never leak to
 * a different host via a redirect hop), and a generous default timeout that
 * leaves real headroom over the server's own ~30s /collect transaction
 * budget. */
export class QualflareHttpClient {
  constructor(private readonly opts: SendOptions) {}

  async send(collect: Collect): Promise<CollectResult> {
    const url = `${this.opts.endpoint.replace(/\/+$/, '')}/api/v1/collect`;
    const idempotencyKey = newIdempotencyKey();
    const body = JSON.stringify(collect);
    const maxAttempts = Math.max(1, this.opts.retry.max + 1);

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.opts.debug) {
        logger.debug(
          `POST ${url} (attempt ${attempt}/${maxAttempts}, QF_TOKEN: ${redactToken(this.opts.token)})`,
        );
      }

      let statusCode: number;
      let responseBody: string;
      let responseHeaders: Record<string, string | string[] | undefined>;
      try {
        const res = await request(url, {
          method: 'POST',
          headers: {
            [HEADER_TOKEN]: this.opts.token,
            [HEADER_CONTENT_TYPE]: 'application/json',
            [HEADER_ACCEPT]: 'application/json',
            [HEADER_USER_AGENT]: this.opts.userAgent,
            [HEADER_IDEMPOTENCY_KEY]: idempotencyKey,
          },
          body,
          maxRedirections: 0,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        statusCode = res.statusCode;
        responseHeaders = res.headers;
        responseBody = await res.body.text();
      } catch (err) {
        lastError = err;
        if (this.opts.debug) {
          logger.debug(`attempt ${attempt} transport error: ${(err as Error)?.message ?? err}`);
        }
        if (attempt < maxAttempts) {
          await sleep(computeDelay(attempt, this.opts.retry.baseDelayMs, this.opts.retry.maxDelayMs));
          continue;
        }
        throw new QualflareApiError({
          message: `failed to send request to ${url}`,
          cause: err,
        });
      }

      if (this.opts.debug) {
        logger.debug(`attempt ${attempt} response: ${statusCode}`);
      }

      if (statusCode >= 200 && statusCode < 300) {
        return parseSuccess(responseBody);
      }

      const parsedError = parseErrorBody(responseBody);

      if (!RETRYABLE_STATUS_CODES.has(statusCode) || attempt === maxAttempts) {
        throw buildApiError(statusCode, parsedError);
      }

      const retryAfterMs = parseRetryAfter(responseHeaders['retry-after']);
      const delay = computeDelay(
        attempt,
        this.opts.retry.baseDelayMs,
        this.opts.retry.maxDelayMs,
        retryAfterMs,
      );
      if (this.opts.debug) {
        logger.debug(`retrying after ${Math.round(delay)}ms (status ${statusCode})`);
      }
      await sleep(delay);
    }

    // Unreachable in practice (the loop always returns or throws), but keeps
    // the function's return type honest without a non-null assertion.
    throw lastError instanceof Error
      ? lastError
      : new QualflareApiError({ message: 'request failed for an unknown reason' });
  }
}

function parseSuccess(responseBody: string): CollectResult {
  try {
    const parsed = JSON.parse(responseBody) as CollectResult;
    if (typeof parsed.seq !== 'number') {
      throw new Error('response body missing numeric "seq"');
    }
    return parsed;
  } catch (err) {
    throw new QualflareApiError({
      message: 'server returned a success status but an unparseable body',
      cause: err,
    });
  }
}

function parseErrorBody(responseBody: string): ApiErrorResponse | undefined {
  if (!responseBody) {
    return undefined;
  }
  try {
    return JSON.parse(responseBody) as ApiErrorResponse;
  } catch {
    return undefined;
  }
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return undefined;
  }
  // Retry-After is either a number of seconds or an HTTP-date; only the
  // (far more common, and simpler to trust) numeric-seconds form is honored
  // here — an HTTP-date value is ignored and falls back to the computed
  // exponential-backoff delay instead.
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
