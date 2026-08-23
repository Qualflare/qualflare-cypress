import {
  MAX_ATTACHMENTS_PER_CASE,
  MAX_LABELS_PER_CASE,
  MAX_LINKS_PER_CASE,
  MAX_PARAMETERS_PER_STEP,
  MAX_STEPS_PER_TEST_ATTEMPT,
  MAX_TAGS_PER_CASE,
  MAX_TAG_LENGTH,
} from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { Attachment, CasePriority, CaseStatus, Label, Link, LinkType, Parameter } from '../shared/types.js';

/** One manually-declared step (`qualflare.step()`), tracked entirely
 * separately from `CommandLogBuffer`'s auto-captured command-log steps (see
 * `command-log-listener.ts`). Combining the two into one truly
 * chronologically-interleaved array would require this buffer and that one
 * to share mutable state — fragile for two independently-testable modules to
 * coordinate. Simpler, deliberate choice instead: manual steps get their own
 * flat array with their own nesting stack (supporting arbitrary depth, unlike
 * Cypress's own flat parent/child signal), and are appended AFTER all
 * auto-captured steps at the point the two arrays are combined
 * (`case-builder.ts`'s `collapseAttempts`), with `parentIndex` shifted by the
 * auto-steps' count so indices remain valid into the final combined array. */
export interface ManualStepRecord {
  name: string;
  status: CaseStatus;
  error?: string;
  parentIndex?: number;
  parameters?: Parameter[];
  /** Milliseconds — captured at the actual `cy.then()` execution point in
   * `metadata-api.ts`'s `step()`, i.e. real wall-clock time the wrapped
   * commands ran, not when `qualflare.step()` was textually called. */
  startedAt: number;
  /** Milliseconds — set by `endStep()`; `undefined` until then (e.g. if a
   * step's wrapped commands fail/throw before `endStep()` ever runs — see
   * `metadata-api.ts`'s `step()` doc comment). */
  durationMs?: number;
}

/** Everything one test-ATTEMPT's `qualflare.*` calls accumulated, drained at
 * the end of that attempt (mirrors `CommandLogBuffer.drain()`'s per-attempt
 * lifecycle — see `mocha-listener.ts`). `manualSteps` is intentionally kept
 * separate from wire-shaped `Step[]` here (its `parentIndex` values are only
 * valid within this array, not yet offset into a combined steps array) —
 * `case-builder.ts` does that combination. */
export interface TestMetadataSnapshot {
  labels?: Label[];
  links?: Link[];
  tags?: string[];
  description?: string;
  priority?: CasePriority;
  properties?: Record<string, string>;
  attachments?: Attachment[];
  manualSteps?: ManualStepRecord[];
}

/**
 * Accumulates one test-attempt's worth of author-facing `qualflare.*` API
 * calls (see `metadata-api.ts`). Attempt-scoped, exactly like
 * `CommandLogBuffer`: `reset()` at the start of every attempt (including
 * retries), `drain()` at the end — so an abandoned/retried attempt's
 * labels/tags/attachments/etc. are discarded, never merged into the next
 * attempt's data, matching how steps already behave (`case-builder.ts`'s
 * "final attempt wins" rule).
 *
 * `active` distinguishes "a test is currently running" from "no test is in
 * progress" (e.g. a `qualflare.*` call made in a `before`/`after` hook, or at
 * spec-file module-load time) — every public method checks it and warns
 * instead of silently recording into data nothing will ever drain, per this
 * codebase's established "never let incidental misuse abort the run"
 * philosophy (see `command-log-listener.ts`/`case-builder.ts`).
 */
export class TestMetadataBuffer {
  private active = false;
  private labels: Label[] = [];
  private links: Link[] = [];
  private tags: string[] = [];
  private descriptionText: string | undefined;
  private priorityValue: CasePriority | undefined;
  private properties: Record<string, string> = {};
  private attachments: Attachment[] = [];
  private manualSteps: ManualStepRecord[] = [];
  private manualStepStack: number[] = [];
  private cappedWarnings = new Set<string>();

  isActive(): boolean {
    return this.active;
  }

  /** Starts a fresh attempt: clears all accumulated data and marks the
   * buffer active. Called from `mocha-listener.ts`'s `runner.on('test', ...)`
   * — fired once per attempt, including retries. */
  reset(): void {
    this.active = true;
    this.labels = [];
    this.links = [];
    this.tags = [];
    this.descriptionText = undefined;
    this.priorityValue = undefined;
    this.properties = {};
    this.attachments = [];
    this.manualSteps = [];
    this.manualStepStack = [];
    this.cappedWarnings.clear();
  }

  /** Ends the current attempt: returns everything accumulated (undefined for
   * any field with nothing recorded, matching this codebase's
   * omit-rather-than-empty-array convention elsewhere), marks the buffer
   * inactive, and clears state. */
  drain(): TestMetadataSnapshot {
    const snapshot: TestMetadataSnapshot = {
      labels: this.labels.length > 0 ? this.labels : undefined,
      links: this.links.length > 0 ? this.links : undefined,
      tags: this.tags.length > 0 ? this.tags : undefined,
      description: this.descriptionText,
      priority: this.priorityValue,
      properties: Object.keys(this.properties).length > 0 ? this.properties : undefined,
      attachments: this.attachments.length > 0 ? this.attachments : undefined,
      manualSteps: this.manualSteps.length > 0 ? this.manualSteps : undefined,
    };
    this.active = false;
    this.labels = [];
    this.links = [];
    this.tags = [];
    this.descriptionText = undefined;
    this.priorityValue = undefined;
    this.properties = {};
    this.attachments = [];
    this.manualSteps = [];
    this.manualStepStack = [];
    return snapshot;
  }

  private warnInactive(fnName: string): void {
    logger.warn(
      `qualflare.${fnName}() was called while no test is currently running (e.g. from a before/after ` +
        'hook, or at module-load time) — this call has no effect.',
    );
  }

  /** Warns at most once per (buffer lifetime, cap-name) pair, so a loop that
   * blows through a cap doesn't spam the log once per iteration. */
  private warnCappedOnce(capName: string, message: string): void {
    if (this.cappedWarnings.has(capName)) return;
    this.cappedWarnings.add(capName);
    logger.warn(message);
  }

  label(name: string, value: string): void {
    if (!this.active) return this.warnInactive('label');
    if (this.labels.length >= MAX_LABELS_PER_CASE) {
      return this.warnCappedOnce(
        'labels',
        `reached the ${MAX_LABELS_PER_CASE}-label-per-case cap — further qualflare.label() calls this test will be dropped.`,
      );
    }
    this.labels.push({ name, value });
  }

  link(url: string, opts?: { type?: LinkType; name?: string }): void {
    if (!this.active) return this.warnInactive('link');
    if (this.links.length >= MAX_LINKS_PER_CASE) {
      return this.warnCappedOnce(
        'links',
        `reached the ${MAX_LINKS_PER_CASE}-link-per-case cap — further qualflare.link() calls this test will be dropped.`,
      );
    }
    const link: Link = { type: opts?.type ?? 'custom', url };
    if (opts?.name) link.name = opts.name;
    this.links.push(link);
  }

  /** `Case.tags` is a REJECT-not-truncate field server-side (`max=64` items,
   * `max=255` chars each) — unlike most other caps in this file, exceeding
   * it 400s the whole launch, not just this one test's tags. Count is
   * enforced the same warn-and-drop-excess way as `label()`/`link()`; an
   * individual over-length tag is truncated (not dropped) instead, since a
   * single long string is a shortenable formatting issue, not a structural
   * one — matching how other length-only limits elsewhere in this codebase
   * (e.g. `console-props.ts`'s `truncate()`) are handled. */
  tag(...tags: string[]): void {
    if (!this.active) return this.warnInactive('tag');
    for (const rawTag of tags) {
      if (this.tags.length >= MAX_TAGS_PER_CASE) {
        this.warnCappedOnce(
          'tags',
          `reached the ${MAX_TAGS_PER_CASE}-tag-per-case cap — further qualflare.tag() calls this test will be dropped.`,
        );
        return;
      }
      let tag = rawTag;
      if (tag.length > MAX_TAG_LENGTH) {
        this.warnCappedOnce('tag-length', `a tag exceeded ${MAX_TAG_LENGTH} characters and was truncated.`);
        tag = tag.slice(0, MAX_TAG_LENGTH);
      }
      this.tags.push(tag);
    }
  }

  /** Last-write-wins if called more than once in one test — simpler than
   * concatenation, and matches how most comparable metadata APIs (a single
   * "set the description" call, not an accumulating log) behave. */
  description(text: string): void {
    if (!this.active) return this.warnInactive('description');
    this.descriptionText = text;
  }

  /** Last-write-wins if called more than once in one test, same as
   * `description()`. Server-side, an unrecognized value is normalized/
   * dropped rather than rejecting the request (`shared/types.ts`), so —
   * like `link()`'s `type` option — this does no runtime validation of
   * its own and simply takes the caller's word for it. */
  priority(value: CasePriority): void {
    if (!this.active) return this.warnInactive('priority');
    this.priorityValue = value;
  }

  /**
   * Placement decision (the wire contract has no top-level `Parameter[]` on
   * `Case` — only `Step.parameters` exists, see `shared/types.ts`): a call
   * made while a `qualflare.step()` is currently open attaches to that
   * step's `parameters[]` (capped at `MAX_PARAMETERS_PER_STEP`, shared with
   * whatever `consoleProps`-derived parameters that step might separately
   * accumulate — no, actually a manual step never has consoleProps, only
   * auto-captured command-log steps do, so no sharing/collision is possible
   * here). A call made OUTSIDE any step becomes a `Case.properties` entry
   * instead, since that's the only test-level key/value bag the wire
   * contract offers. `opts.masked` has no analog on `properties` (a plain
   * `Record<string,string>`) and is silently ignored in that branch — real,
   * documented limitation, not a bug: masking only has meaning for a
   * step-level `Parameter`.
   */
  parameter(name: string, value?: string, opts?: { masked?: boolean }): void {
    if (!this.active) return this.warnInactive('parameter');
    const openStepIndex = this.manualStepStack[this.manualStepStack.length - 1];
    if (openStepIndex !== undefined) {
      const step = this.manualSteps[openStepIndex];
      if (!step) return;
      step.parameters ??= [];
      if (step.parameters.length >= MAX_PARAMETERS_PER_STEP) {
        return this.warnCappedOnce(
          'step-parameters',
          `reached the ${MAX_PARAMETERS_PER_STEP}-parameter-per-step cap — further qualflare.parameter() ` +
            'calls within this step will be dropped.',
        );
      }
      const parameter: Parameter = { name };
      if (value !== undefined) parameter.value = value;
      if (opts?.masked) parameter.masked = true;
      step.parameters.push(parameter);
      return;
    }
    this.properties[name] = value ?? '';
  }

  /** `encoding` defaults to `'utf8'`: `content` is treated as plain text and
   * base64-encoded before being placed into the wire format's
   * always-base64 `Attachment.content` (see `shared/types.ts`). `'base64'`
   * means the caller already has base64 text and it's passed through
   * unencoded. Uses `TextEncoder`/`btoa` rather than Node's `Buffer` — this
   * module runs in the browser (Cypress's actual browser context, not
   * Node), where `Buffer` does not exist; both are standard Web APIs
   * available in every browser Cypress supports. */
  attachment(name: string, content: string, opts?: { encoding?: 'utf8' | 'base64'; mimeType?: string }): void {
    if (!this.active) return this.warnInactive('attachment');
    if (this.attachments.length >= MAX_ATTACHMENTS_PER_CASE) {
      return this.warnCappedOnce(
        'attachments',
        `reached the ${MAX_ATTACHMENTS_PER_CASE}-attachment-per-case cap — further qualflare.attachment()/` +
          'attachmentFromFile() calls this test will be dropped. Note this cap is enforced independently ' +
          'of any screenshots captured during the same test, which are merged in Node-side — the combined ' +
          'total is not currently capped.',
      );
    }
    const base64 = opts?.encoding === 'base64' ? content : utf8ToBase64(content);
    const attachment: Attachment = { name, content: base64 };
    if (opts?.mimeType) attachment.mimeType = opts.mimeType;
    this.attachments.push(attachment);
  }

  /** Mirrors the screenshot flow (`plugin/attachment-reader.ts`): the file's
   * bytes are never read here (this runs browser-side, with no filesystem
   * access) — a path-only `Attachment{name, path, mimeType}` is queued, and
   * the EXISTING Node-side `resolveAttachments()` pipeline (already
   * generic — it reads and size-guards any attachment that has a `path` but
   * no `content`) resolves it once this test's `Case` reaches
   * `TASK_REPORT_CASE`. No new Node-side code needed for this to work. */
  attachmentFromFile(name: string, path: string, opts?: { mimeType?: string }): void {
    if (!this.active) return this.warnInactive('attachmentFromFile');
    if (this.attachments.length >= MAX_ATTACHMENTS_PER_CASE) {
      return this.warnCappedOnce(
        'attachments',
        `reached the ${MAX_ATTACHMENTS_PER_CASE}-attachment-per-case cap — further qualflare.attachment()/` +
          'attachmentFromFile() calls this test will be dropped.',
      );
    }
    const attachment: Attachment = { name, path };
    if (opts?.mimeType) attachment.mimeType = opts.mimeType;
    this.attachments.push(attachment);
  }

  /** Starts a manually-declared step, nested under whatever manual step (if
   * any) is currently open — an independent nesting stack from
   * `CommandLogBuffer`'s command-log-derived parent/child tracking (see this
   * file's header comment for why the two aren't unified). Returns an index
   * to pass back to `endStep()`. Soft-capped at `MAX_STEPS_PER_TEST_ATTEMPT`,
   * same limit `CommandLogBuffer` uses (the two counts aren't combined
   * against a single shared budget — a deliberate, documented simplification;
   * either buffer alone can reach its own cap independently). Returns
   * `undefined` if inactive or capped — `endStep(undefined, ...)` is a
   * documented no-op, so callers don't need to branch on this themselves. */
  beginStep(name: string, now: number = Date.now()): number | undefined {
    if (!this.active) {
      this.warnInactive('step');
      return undefined;
    }
    if (this.manualSteps.length >= MAX_STEPS_PER_TEST_ATTEMPT) {
      this.warnCappedOnce(
        'manual-steps',
        `reached the ${MAX_STEPS_PER_TEST_ATTEMPT}-step-per-test soft cap — further qualflare.step() calls ` +
          'this test attempt will still run their wrapped commands, but will not be recorded as steps.',
      );
      return undefined;
    }
    const index = this.manualSteps.length;
    const parentIndex = this.manualStepStack[this.manualStepStack.length - 1];
    const record: ManualStepRecord = { name, status: 'pending', startedAt: now };
    if (parentIndex !== undefined) record.parentIndex = parentIndex;
    this.manualSteps.push(record);
    this.manualStepStack.push(index);
    return index;
  }

  /** Finalizes a step started by `beginStep()`, recording its real
   * wall-clock duration. A no-op if `index` is `undefined` (the documented
   * signal from `beginStep()` that nothing was actually recorded —
   * inactive buffer or step-count cap reached). If a step's wrapped
   * commands fail/throw, this never runs — see `metadata-api.ts`'s
   * `step()` doc comment — so `durationMs` stays `undefined` and
   * `combineSteps` (`case-builder.ts`) falls back to 0 for that step. */
  endStep(index: number | undefined, status: CaseStatus, error?: string, now: number = Date.now()): void {
    if (index === undefined) return;
    const record = this.manualSteps[index];
    if (record) {
      record.status = status;
      if (error) record.error = error;
      record.durationMs = Math.max(0, now - record.startedAt);
    }
    // Pop defensively rather than assuming `index` is the stack's current
    // top: if steps somehow end out of order (shouldn't happen given the
    // cy.then()-interleaved design in metadata-api.ts, but this keeps the
    // stack from getting stuck open if it ever does), remove this specific
    // index wherever it sits rather than only ever popping the tail.
    const stackPos = this.manualStepStack.lastIndexOf(index);
    if (stackPos !== -1) {
      this.manualStepStack.splice(stackPos, 1);
    }
  }
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * One instance per spec-file load, shared between `metadata-api.ts` (the
 * `qualflare` object a test imports and calls directly) and
 * `mocha-listener.ts` (which drives its reset/drain lifecycle).
 *
 * Deliberately NOT a plain `export const ... = new TestMetadataBuffer()`
 * module-level singleton — verified by running a real `cypress run` (see
 * `test/integration/`) that this breaks in practice: Cypress compiles the
 * support file and each spec file as SEPARATE webpack bundles, and a spec
 * file importing this module gets its own independently-evaluated copy of
 * it (a fresh `TestMetadataBuffer` instance), not the SAME instance the
 * support file's `mocha-listener.ts` is reading from — so every
 * `qualflare.label()`/`.tag()`/etc. call from a spec silently wrote into a
 * buffer nothing ever drained. Anchoring the singleton to a property on the
 * `Cypress` object instead works because `Cypress` itself is injected once,
 * genuinely shared across every bundle running in the same spec-runner page
 * — unlike ES module state, which is NOT guaranteed shared across separate
 * webpack compilations even when they resolve to the identical source file.
 */
interface CypressWithMetadataBuffer {
  __qualflareMetadataBuffer?: TestMetadataBuffer;
}

/** A module-level fallback used only when `Cypress` isn't defined (e.g. this
 * module loaded under Vitest for unit testing, not inside a real Cypress
 * browser) — plain module-singleton semantics are fine there, since a unit
 * test never spans multiple webpack bundles. */
let fallbackBuffer: TestMetadataBuffer | undefined;

/** Returns the one shared `TestMetadataBuffer` instance, creating it on
 * first call. A function (not a top-level `const`) specifically so that
 * merely importing this module never touches the `Cypress` global at
 * module-evaluation time — every call site (`metadata-api.ts`,
 * `mocha-listener.ts`) calls this fresh rather than closing over a
 * module-level object reference, avoiding any `this`-binding subtlety a
 * Proxy-based "looks like a plain object" wrapper would introduce. */
export function getDefaultMetadataBuffer(): TestMetadataBuffer {
  if (typeof Cypress === 'undefined') {
    fallbackBuffer ??= new TestMetadataBuffer();
    return fallbackBuffer;
  }
  const target = Cypress as unknown as CypressWithMetadataBuffer;
  target.__qualflareMetadataBuffer ??= new TestMetadataBuffer();
  return target.__qualflareMetadataBuffer;
}
