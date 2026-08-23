import type { ApiErrorResponse, ApiFieldError } from '../shared/types.js';

/** CLI-side friendly hints for a few well-known server error codes — only
 * used as a fallback when the server sent no `message` of its own. Mirrors
 * `qualflare-cli/internal/adapters/http/client.go`'s `getUserFriendlyMessage`.
 * `common.resource_not_found` is deliberately NOT aliased to a specific
 * resource here — that's the generic 404 code and aliasing it caused a
 * documented bug in the Go CLI (every 404 rendering as "Language not found"). */
function friendlyHint(code: string | undefined): string | undefined {
  switch (code) {
    case 'environment.not_found':
      return 'Environment not found. Check the `environment` option or create it in Qualflare.';
    case 'milestone.not_found':
      return 'Milestone not found. Check the `milestone` option or its sequence number in Qualflare.';
    case 'common.validation_failed':
      return 'Validation failed. Check the request data below.';
    default:
      return undefined;
  }
}

function actionHint(statusCode: number | undefined): string | undefined {
  switch (statusCode) {
    case 401:
      return 'the configured token is missing or invalid — check `token`/QUALFLARE_TOKEN';
    case 403:
      return 'the token lacks access to this project';
    case 402:
      return 'a plan limit was reached — check your Qualflare subscription';
    default:
      return undefined;
  }
}

/** Renders the server's per-field validation errors into one readable line.
 * This is a real, confirmed gap the existing Go CLI has (it parses `fields`
 * off the wire but never renders them) — this package renders them from
 * day one instead of just showing the top-level `message`. */
function renderFields(fields: ApiFieldError[] | undefined): string | undefined {
  if (!fields || fields.length === 0) {
    return undefined;
  }
  return fields
    .map((f) => {
      const rule = f.rule ? ` (${f.rule})` : '';
      const msg = f.message ? `: ${f.message}` : '';
      return `${f.field}${rule}${msg}`;
    })
    .join('; ');
}

export interface QualflareApiErrorInit {
  message: string;
  code?: string;
  statusCode?: number;
  requestId?: string;
  fields?: ApiFieldError[];
  cause?: unknown;
}

/** Thrown by `QualflareHttpClient.send()` on any terminal (non-retried, or
 * retries-exhausted) failure. Carries everything needed to log something
 * actionable without the caller having to know the wire error shape. */
export class QualflareApiError extends Error {
  readonly code?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly fields?: ApiFieldError[];

  constructor(init: QualflareApiErrorInit) {
    const parts = [init.message];
    const fieldsRendered = renderFields(init.fields);
    if (fieldsRendered) {
      parts.push(`fields: ${fieldsRendered}`);
    }
    const hint = actionHint(init.statusCode);
    if (hint) {
      parts.push(`(${hint})`);
    }
    if (init.requestId) {
      parts.push(`[request_id: ${init.requestId}]`);
    }
    super(parts.join(' — '), init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'QualflareApiError';
    this.code = init.code;
    this.statusCode = init.statusCode;
    this.requestId = init.requestId;
    this.fields = init.fields;
  }
}

/** Parses the server's `{code, message, fields, request_id}` envelope (also
 * tolerating the legacy `{error}` key) into a `QualflareApiError`. `body`
 * may be `undefined` if the response wasn't valid JSON at all. */
export function buildApiError(statusCode: number, body: ApiErrorResponse | undefined): QualflareApiError {
  const code = body?.code;
  const message = body?.message || friendlyHint(code) || body?.error || `request failed with status ${statusCode}`;
  return new QualflareApiError({
    message,
    code,
    statusCode,
    requestId: body?.request_id,
    fields: body?.fields,
  });
}
