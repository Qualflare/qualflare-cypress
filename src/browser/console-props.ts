import { MAX_PARAMETERS_PER_STEP } from '../shared/constants.js';
import type { Parameter } from '../shared/types.js';

const MAX_VALUE_CHARS = 500;
const MAX_STRINGIFY_DEPTH = 3;

/**
 * Renders an arbitrary value into a short, human-readable string for a
 * `Parameter.value`. Must NEVER throw, regardless of input shape — a
 * command's `consoleProps` is inherently unpredictable (varies per command
 * type, may contain DOM elements, functions, circular references, huge
 * arrays/strings) since it exists purely for devtools-console display, not
 * as a stable API contract.
 *
 * - Functions are skipped entirely (rendered as `'[function]'`) rather than
 *   attempting to serialize their source.
 * - A value that looks like a DOM element (duck-typed via `.tagName`, since
 *   this file must stay isomorphic and can't `instanceof Element` safely in
 *   every context this module might be evaluated in) is rendered as its tag
 *   name plus a short attribute summary, not a full serialization.
 * - Circular references are broken via a `seen` WeakSet, rendered as
 *   `'[circular]'` at the point of recursion.
 * - Long strings are truncated at `MAX_VALUE_CHARS`.
 */
export function safeStringify(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;
  if (type === 'string') {
    return truncate(value as string);
  }
  if (type === 'number' || type === 'boolean' || type === 'bigint') {
    // Routed through truncate() like every other branch: a number/boolean
    // is always short, but an arbitrarily large BigInt (plausible in
    // numeric-heavy command output) is not, and previously bypassed the
    // documented MAX_VALUE_CHARS cap entirely.
    return truncate(String(value));
  }
  if (type === 'function') {
    return '[function]';
  }
  if (type === 'symbol') {
    return (value as symbol).toString();
  }

  // From here down, `value` is an object (or array) — the only remaining
  // `typeof` result besides 'object'.
  const obj = value as object;
  if (seen.has(obj)) {
    return '[circular]';
  }

  // Every read of an unpredictable property on `obj` — including
  // `isDomElementLike`'s `.tagName` duck-type check and
  // `describeDomElementLike`'s `.id`/`.className` reads below — MUST happen
  // inside this try/catch, not before it. A Proxy with a throwing `get`
  // trap, or a plain object with a throwing `tagName`/`id`/`className`
  // getter, previously threw straight out of this function (the DOM-element
  // check ran BEFORE the guarded region even started), violating this
  // function's own "must never throw" contract — found via deep adversarial
  // self-review. `consoleProps` is explicitly unpredictable input; nothing
  // about it should be trusted to read safely without a guard.
  seen.add(obj);
  try {
    if (isDomElementLike(obj)) {
      return describeDomElementLike(obj);
    }

    if (depth >= MAX_STRINGIFY_DEPTH) {
      return Array.isArray(obj) ? '[array]' : '[object]';
    }

    if (Array.isArray(obj)) {
      const items = obj.slice(0, 20).map((item) => safeStringify(item, depth + 1, seen));
      const suffix = obj.length > 20 ? `, …(${obj.length - 20} more)` : '';
      return truncate(`[${items.join(', ')}${suffix}]`);
    }
    if (obj instanceof Error) {
      return truncate(obj.message ? `${obj.name}: ${obj.message}` : obj.name);
    }
    const entries = Object.entries(obj as Record<string, unknown>).slice(0, 20);
    const rendered = entries.map(([key, val]) => `${key}: ${safeStringify(val, depth + 1, seen)}`);
    return truncate(`{${rendered.join(', ')}}`);
  } catch {
    // Getters can throw; a value this hostile just becomes an opaque marker
    // rather than aborting the whole parameter-collection pass.
    return '[unserializable]';
  } finally {
    seen.delete(obj);
  }
}

function truncate(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

function isDomElementLike(obj: object): obj is { tagName: string; id?: string; className?: string } {
  return typeof (obj as { tagName?: unknown }).tagName === 'string';
}

function describeDomElementLike(el: { tagName: string; id?: string; className?: string }): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/).join('.')}` : '';
  return `<${tag}${id}${cls}>`;
}

/**
 * Flattens a command's `consoleProps` object into `Parameter[]`, capped at
 * the server's per-step limit.
 *
 * Cypress consistently wraps a command's actual human-meaningful detail one
 * level down, under a `props` key — `consoleProps()` for a real command
 * returns `{ name: 'visit', type: 'command', props: { 'Resolved Url': ...,
 * Redirects: [...], 'Cookies Set': [...] } }`, not the detail fields
 * directly at the top level. Verified against real captured command-log
 * output across seven different command/event types (visit, get, contains,
 * assert, wait, request, route) — every one had exactly this
 * `{name, type, props}` shape, `name`/`type` always redundant with
 * information already carried elsewhere (`name` duplicates the step's own
 * `name`/message; `type` is just `'command'` or `'event'`). Flattening
 * `props`'s keys instead of the outer object's turns one opaque
 * `props: "{Resolved Url: ..., Redirects: ...}"` blob into separate
 * `Resolved Url`/`Redirects` parameters a reader can actually scan.
 *
 * Falls back to flattening the outer object directly when `props` isn't a
 * plain object (absent, an array, a primitive) — a custom command's
 * `consoleProps`, or a future Cypress version, may not follow the standard
 * shape, and the top-level flatten is still strictly better than nothing
 * for those.
 *
 * Accepts `unknown` because the caller (`command-log-listener.ts`) reads
 * `consoleProps` off a log entry whose real runtime shape isn't reliably
 * typed (see that file's header comment) — it may be a plain object, a
 * zero-arg function returning one, `undefined`, or something unexpected.
 */
export function buildParametersFromConsoleProps(consoleProps: unknown): Parameter[] {
  let resolved: unknown = consoleProps;
  if (typeof resolved === 'function') {
    try {
      resolved = (resolved as () => unknown)();
    } catch {
      return [];
    }
  }
  if (resolved === null || typeof resolved !== 'object') {
    return [];
  }

  const outer = resolved as Record<string, unknown>;
  const nestedProps = outer.props;
  const source = nestedProps !== null && typeof nestedProps === 'object' && !Array.isArray(nestedProps)
    ? (nestedProps as Record<string, unknown>)
    : outer;

  const parameters: Parameter[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'function') {
      // Functions carry no useful reportable value (see safeStringify) and
      // are common in consoleProps (e.g. a `Snapshot` accessor) — skip
      // rather than emit a near-useless '[function]' parameter for every one.
      continue;
    }
    parameters.push({ name, value: safeStringify(value) });
    if (parameters.length >= MAX_PARAMETERS_PER_STEP) {
      break;
    }
  }
  return parameters;
}
