import { msToNs } from '../shared/duration.js';
import { MAX_ATTEMPTS_PER_CASE, MAX_ATTEMPT_MESSAGE_RUNES } from '../shared/constants.js';
import { truncateRunes } from '../shared/text.js';
import type { Attachment, Attempt, CasePriority, CaseStatus, Label, Link, Step } from '../shared/types.js';
import type { ManualStepRecord, TestMetadataSnapshot } from './test-metadata-buffer.js';

/** One attempt of a test — Cypress's built-in retry mechanism re-runs the
 * same logical test in place; each run produces one of these. Durations
 * here are plain MILLISECONDS (Mocha's native unit) — conversion to the
 * wire format's nanoseconds happens later, in `queue.ts`, not here, so this
 * module stays independently testable without needing to know about the
 * wire format's unit convention. */
export interface AttemptSnapshot extends TestMetadataSnapshot {
  status: CaseStatus;
  /** Milliseconds. */
  duration: number;
  error?: string;
  /** This attempt's command-log-derived (auto-captured) steps, already
   * wire-shaped — see `command-log-listener.ts`'s `CommandLogBuffer.drain()`.
   * Kept separate from `manualSteps` (inherited from `TestMetadataSnapshot`,
   * from `qualflare.step()` calls — see `test-metadata-buffer.ts`) until
   * `collapseAttempts` combines the two; each has its own independent
   * `parentIndex` numbering until then. */
  steps?: Step[];
}

export interface CollapsedResult {
  status: CaseStatus;
  /** Milliseconds — sum of every attempt (reflects true CI wall-clock cost,
   * not just the final attempt's duration). */
  duration: number;
  retryCount: number;
  isFlaky: boolean;
  /** Per-attempt history, present only when the test actually retried (>= 2
   * attempts). Durations are already NANOSECONDS here, unlike `duration`
   * above — the same convention `steps` follows in this module, since both
   * are wire-shaped types where the unit is part of the contract. */
  attempts?: Attempt[];
  error?: string;
  /** Only the FINAL attempt's steps — an abandoned (retried) attempt's step
   * trace would misrepresent a single execution as if the same commands ran
   * twice, so earlier attempts' steps are discarded, never merged. This is
   * the fully-combined array (auto-captured command-log steps followed by
   * `qualflare.step()`-declared manual steps, `parentIndex` values already
   * adjusted so both sets index correctly into this one array) — ready to
   * assign directly to `Case.steps`. */
  steps?: Step[];
  labels?: Label[];
  links?: Link[];
  tags?: string[];
  description?: string;
  priority?: CasePriority;
  properties?: Record<string, string>;
  attachments?: Attachment[];
}

/** Appends `manualSteps` (from `qualflare.step()`, indices/`parentIndex`
 * valid only relative to each other) after `autoSteps` (from
 * `CommandLogBuffer`, indices/`parentIndex` valid only relative to each
 * other) into one combined, correctly-indexed `Step[]`. A manual step's
 * `parentIndex`, if set, refers to another manual step — never an auto
 * step — so it only ever needs shifting by `autoSteps.length`, never
 * cross-referencing into the auto range (see `test-metadata-buffer.ts`'s
 * header comment for why the two nesting mechanisms are kept independent
 * rather than unified). */
function combineSteps(autoSteps: Step[] | undefined, manualSteps: ManualStepRecord[] | undefined): Step[] | undefined {
  const auto = autoSteps ?? [];
  const manual = manualSteps ?? [];
  if (auto.length === 0 && manual.length === 0) {
    return undefined;
  }
  const offsetManual: Step[] = manual.map((record) => {
    const step: Step = { name: record.name, status: record.status, duration: msToNs(record.durationMs ?? 0) };
    if (record.error) step.error = record.error;
    if (record.parentIndex !== undefined) step.parentIndex = record.parentIndex + auto.length;
    if (record.parameters && record.parameters.length > 0) step.parameters = record.parameters;
    return step;
  });
  return [...auto, ...offsetManual];
}

/**
 * Collapses every attempt of one logical test (as recorded across Cypress's
 * automatic retries) into the single `Case` this reporter uploads. Cypress
 * re-runs the same Mocha `Test` object in place on retry — from the
 * runner's perspective there is one 'test'/'pass'/'fail' event per attempt,
 * not per logical test — so the caller is responsible for grouping
 * attempts by a stable per-test key (this function only does the collapse).
 */
/**
 * Builds the per-attempt history, or `undefined` when there is nothing worth
 * sending.
 *
 * Unlike the rest of `collapseAttempts`, which keeps only the final attempt's
 * data, this preserves every attempt — that is the entire point. `retryCount`
 * and `isFlaky` say a test retried; this says what went wrong each time.
 *
 * # Why a single attempt sends nothing
 *
 * The server discards a one-element array (there is no history in a test that
 * ran once — its status, duration and error are already on the Case), so
 * sending one spends payload against the 10MB body limit for a dropped row.
 *
 * # Why the whole error string goes into `message`
 *
 * Cypress hands us `${message}\n${stack}` already flattened by
 * `mocha-listener.ts`'s `formatError`, with no separate stack field to read.
 * Splitting on the first newline to fill `trace` would look tidier and would
 * corrupt every multiline assertion message — which Cypress produces routinely
 * ("expected X to deep equal Y" wraps). The server truncates `message` at 8192
 * runes rather than rejecting, and the Case's own `error` (65536 runes) still
 * carries the final attempt's full text, so nothing is actually lost.
 */
function buildAttempts(attempts: AttemptSnapshot[]): Attempt[] | undefined {
  if (attempts.length < 2) {
    return undefined;
  }

  // Past the cap the server keeps the first 49 plus the final one and drops the
  // middle. Mirroring that here means the bytes are never sent, and the FINAL
  // attempt survives the trim — a plain slice(0, 50) would discard it.
  let kept = attempts;
  if (attempts.length > MAX_ATTEMPTS_PER_CASE) {
    kept = [...attempts.slice(0, MAX_ATTEMPTS_PER_CASE - 1), attempts[attempts.length - 1]!];
  }

  return kept.map((a, i) => {
    const attempt: Attempt = {
      attempt: i + 1,
      status: a.status,
      duration: msToNs(a.duration),
    };
    if (a.error) {
      // Bounded to what the server stores. The whole formatted error goes into
      // `message` (see the note above), so this single field carries the stack
      // too and is what makes an attempt unboundedly large.
      attempt.message = truncateRunes(a.error, MAX_ATTEMPT_MESSAGE_RUNES);
    }
    return attempt;
  });
}

export function collapseAttempts(attempts: AttemptSnapshot[]): CollapsedResult {
  if (attempts.length === 0) {
    throw new Error('collapseAttempts: at least one attempt is required');
  }
  const final = attempts[attempts.length - 1]!;
  const retryCount = attempts.length - 1;
  const isFlaky = retryCount > 0 && final.status === 'passed' && attempts.some((a) => a.status !== 'passed');
  const duration = attempts.reduce((sum, a) => sum + a.duration, 0);
  const attemptHistory = buildAttempts(attempts);

  return {
    status: final.status,
    duration,
    retryCount,
    isFlaky,
    ...(attemptHistory ? { attempts: attemptHistory } : {}),
    error: final.status === 'passed' ? undefined : final.error,
    steps: combineSteps(final.steps, final.manualSteps),
    labels: final.labels,
    links: final.links,
    tags: final.tags,
    description: final.description,
    priority: final.priority,
    properties: final.properties,
    attachments: final.attachments,
  };
}
