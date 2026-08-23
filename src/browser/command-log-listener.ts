import { MAX_STEPS_PER_TEST_ATTEMPT } from '../shared/constants.js';
import { msToNs } from '../shared/duration.js';
import { logger } from '../shared/logger.js';
import type { CaseStatus, Step } from '../shared/types.js';
import { buildParametersFromConsoleProps } from './console-props.js';

/**
 * The runtime shape of a Cypress command-log entry, as actually observed —
 * NOT the same as `Cypress.LogConfig` in `node_modules/cypress/types/cypress.d.ts`
 * (checked directly against Cypress 14.5.4's shipped types before writing
 * this file, not assumed from memory or from allure-cypress's implementation).
 *
 * What the types confirm:
 *  - `Cypress.on('log:added'|'log:changed', (attributes, log) => void)` —
 *    `attributes` is typed `ObjectLike` (`{[key: string]: any}`, i.e. no
 *    fixed shape enforced by the compiler) and `log` itself is typed `any`.
 *  - `LogConfig` (what `log.get()` returns) declares `id`, `type: 'parent' |
 *    'child'`, `name`, `displayName`, `message`, and `consoleProps(): ObjectLike`
 *    — i.e. THE TYPES SAY `consoleProps` IS A METHOD, not a property. A
 *    sibling type, `LogAttrs`, declares `consoleProps: ObjectLike` as a plain
 *    property instead — the two disagree, which is itself evidence this has
 *    genuinely varied across Cypress versions/call sites. `consoleProps` is
 *    therefore read defensively in `console-props.ts` (call it if it's a
 *    function, use it directly otherwise).
 *  - No `state` (pass/fail/pending) field and no elapsed-time field
 *    (`wallClockStartedAt` or similar) appear ANYWHERE in the typed surface.
 *
 * Real Cypress command logs DO carry a runtime `state` in practice (every
 * published Cypress reporter — allure-cypress, cypress-mochawesome-reporter —
 * reads it the same way), it's just not part of the declared `.d.ts` surface;
 * `ObjectLike`'s open index signature means TypeScript won't stop reading it,
 * so it's accessed here the same documented-by-convention way this codebase
 * already reads `Mocha.Test['_currentRetry']` in `mocha-listener.ts` — cast
 * through a local interface, not the `any`-typed real parameter directly.
 *
 * Because there is NO typed/reliable elapsed-time signal, this module
 * approximates a step's duration as wall-clock time between when the log
 * entry was first seen (`log:added`) and the last update observed for it
 * (`log:changed`, debounced by Cypress itself) or, failing that, the moment
 * the buffer is drained — this is a real approximation, not authoritative
 * per-command timing, and is documented as such rather than presented as
 * precise.
 */
interface RawLogAttributes {
  id?: string;
  name?: string;
  displayName?: string;
  /** The one genuinely typed nesting signal Cypress exposes (see file header)
   * — used directly as this module's nesting strategy, in place of the
   * group/parent-graph mechanism an earlier draft of the implementation plan
   * speculated about (which does not appear anywhere in the shipped types). */
  type?: 'parent' | 'child';
  state?: string;
  err?: { message?: string; stack?: string } | Error | string;
  consoleProps?: unknown;
  /** "additional information to include in the log" per `Cypress.LogConfig`
   * (typed `any` there — this is the field Cypress's own Command Log UI uses
   * to show e.g. a `cy.visit()`'s URL or a `cy.get()`'s selector next to the
   * bare command name). Read defensively: most commands set a short string,
   * but the type permits anything, and some commands set none at all. */
  message?: unknown;
}

/** Cap on the `message` text folded into a step's name — this is a display
 * enrichment, not a data field with its own budget, so an unusually long
 * message (a huge typed string, a multi-line selector) is truncated rather
 * than bloating the step name indefinitely. */
const MAX_STEP_MESSAGE_CHARS = 200;

/** Extracts a usable short string from a log entry's `message`, or
 * `undefined` if it isn't one worth appending — `message` is typed `any` in
 * Cypress's own declarations, so this must not assume it is always a
 * non-empty string. */
function describeMessage(message: unknown): string | undefined {
  if (typeof message !== 'string') {
    return undefined;
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > MAX_STEP_MESSAGE_CHARS ? `${trimmed.slice(0, MAX_STEP_MESSAGE_CHARS)}…` : trimmed;
}

interface StepRecord {
  name: string;
  keyword?: string;
  status: CaseStatus;
  error?: string;
  location?: string;
  parentIndex?: number;
  startedAt: number;
  lastSeenAt: number;
  consoleProps?: unknown;
}

function formatLogError(err: RawLogAttributes['err']): string | undefined {
  if (err === undefined || err === null) {
    return undefined;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error) {
    return err.stack ? `${err.message}\n${err.stack}` : err.message;
  }
  return err.stack ? `${err.message ?? ''}\n${err.stack}`.trim() : err.message;
}

/** Maps a log entry's runtime `state` to the shared status vocabulary.
 * `'failed'` ALWAYS maps to `'failed'` — never silently defaults to
 * `'passed'` for an ambiguous/unrecognized/missing state, matching this
 * org's documented history of "silently uploads as green" bugs elsewhere in
 * the platform (see api-service/docs/code-quality/public-api-cli-review.md).
 * An unresolved/unknown state honestly reports as `'pending'` — a real,
 * valid `CaseStatus` meaning "we never observed a terminal outcome for
 * this," not a guess in either direction. */
function mapLogState(state: string | undefined): CaseStatus {
  if (state === 'failed') return 'failed';
  if (state === 'passed') return 'passed';
  return 'pending';
}

/**
 * Accumulates one test-ATTEMPT's worth of command-log entries into `Step[]`.
 * One instance is shared for the whole spec file's lifetime; `reset()` is
 * called at the start of every test attempt (including retries — a fresh
 * attempt gets a fresh, empty step buffer, matching how `AttemptSnapshot`
 * itself is per-attempt) and `drain()` at the end of one.
 *
 * Filtering: only log entries with a non-empty `name` become steps — this is
 * a deliberately simple heuristic (there is no reliably typed signal to
 * distinguish user-meaningful commands/assertions from Cypress's internal
 * bookkeeping log entries), not an exhaustive noise filter. Good enough to
 * avoid recording obviously-empty entries; may need refinement once
 * exercised against real command-log output from a live Cypress run.
 */
export class CommandLogBuffer {
  private records: StepRecord[] = [];
  private indexById = new Map<string, number>();
  private lastParentIndex: number | undefined;
  private capWarned = false;

  handleAdded(attrs: RawLogAttributes, now: number = Date.now()): void {
    if (!attrs.name) {
      return;
    }
    if (this.records.length >= MAX_STEPS_PER_TEST_ATTEMPT) {
      if (!this.capWarned) {
        this.capWarned = true;
        logger.warn(
          `reached the ${MAX_STEPS_PER_TEST_ATTEMPT}-step-per-test soft cap — further command-log ` +
            'entries for this test attempt will not be recorded.',
        );
      }
      return;
    }

    const index = this.records.length;
    const parentIndex = attrs.type === 'child' ? this.lastParentIndex : undefined;
    if (attrs.type === 'parent') {
      this.lastParentIndex = index;
    }

    // Enriches the bare command verb with its target/detail — "visit" alone
    // vs. "visit http://localhost:3000/login" — the same information
    // Cypress's own Command Log UI shows next to the command name. Computed
    // once here rather than kept live via handleChanged: name/keyword are
    // otherwise immutable after creation in this class (only
    // status/error/consoleProps update later), and every message observed
    // in real captured command-log output was already present at
    // 'log:added' time.
    const message = describeMessage(attrs.message);
    const name = message ? `${attrs.name} ${message}` : attrs.name;

    this.records.push({
      name,
      keyword: attrs.displayName && attrs.displayName !== attrs.name ? attrs.displayName : undefined,
      status: mapLogState(attrs.state),
      error: formatLogError(attrs.err),
      parentIndex,
      startedAt: now,
      lastSeenAt: now,
      consoleProps: attrs.consoleProps,
    });
    if (attrs.id) {
      this.indexById.set(attrs.id, index);
    }
  }

  handleChanged(attrs: RawLogAttributes, now: number = Date.now()): void {
    const index = attrs.id ? this.indexById.get(attrs.id) : undefined;
    if (index === undefined) {
      // A 'log:changed' for an id we never saw 'log:added' for (e.g. it
      // arrived for an entry recorded before this buffer's current attempt
      // started, or was dropped by the soft cap) — nothing to update.
      return;
    }
    const record = this.records[index];
    if (!record) {
      return;
    }
    record.lastSeenAt = now;
    if (attrs.state !== undefined) {
      record.status = mapLogState(attrs.state);
    }
    if (attrs.err !== undefined) {
      record.error = formatLogError(attrs.err);
    }
    if (attrs.consoleProps !== undefined) {
      record.consoleProps = attrs.consoleProps;
    }
  }

  /** Returns this attempt's steps as wire-shaped `Step[]` (durations already
   * converted to nanoseconds — unlike `Case`-level duration, which stays in
   * milliseconds until `queue.ts`, `Step` has no separate internal/ms-shaped
   * representation elsewhere in this codebase, so there's no benefit to
   * threading one through here only to convert it later) and clears the
   * buffer for the next attempt. */
  drain(): Step[] {
    const steps = this.records.map((record) => {
      const step: Step = {
        name: record.name,
        status: record.status,
        duration: msToNs(Math.max(0, record.lastSeenAt - record.startedAt)),
      };
      if (record.keyword) step.keyword = record.keyword;
      if (record.error) step.error = record.error;
      if (record.location) step.location = record.location;
      if (record.parentIndex !== undefined) step.parentIndex = record.parentIndex;
      const parameters = buildParametersFromConsoleProps(record.consoleProps);
      if (parameters.length > 0) step.parameters = parameters;
      return step;
    });
    this.reset();
    return steps;
  }

  /** Starts a fresh attempt: clears all recorded steps and nesting state.
   * Steps from an abandoned (retried) attempt are discarded, never merged
   * into the next attempt's buffer — see `mocha-listener.ts`, which calls
   * this on every `runner.on('test', ...)` (fired once per attempt,
   * including retries) so only the FINAL attempt's steps ever reach
   * `drain()`. */
  reset(): void {
    this.records = [];
    this.indexById.clear();
    this.lastParentIndex = undefined;
    this.capWarned = false;
  }
}

/**
 * Registers the real Cypress log-event wiring around a `CommandLogBuffer`.
 * Kept as a thin adapter over the buffer's pure, independently-testable
 * methods — this function itself is not unit-tested directly (it can't be,
 * without a real Cypress runtime), `CommandLogBuffer`'s methods are.
 */
export function registerCommandLogListener(buffer: CommandLogBuffer): void {
  Cypress.on('log:added', (attributes: RawLogAttributes) => {
    buffer.handleAdded(attributes);
  });
  Cypress.on('log:changed', (attributes: RawLogAttributes) => {
    buffer.handleChanged(attributes);
  });
}
