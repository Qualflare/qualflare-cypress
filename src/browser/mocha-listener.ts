import type { CaseStatus } from '../shared/types.js';
import type { AttemptSnapshot } from './case-builder.js';
import { CommandLogBuffer, registerCommandLogListener } from './command-log-listener.js';
import { flushCase } from './queue.js';
import { getDefaultMetadataBuffer } from './test-metadata-buffer.js';

/**
 * `Cypress.mocha` is not part of Cypress's public TypeScript surface, but
 * `Cypress.mocha.getRunner()` is the documented-by-convention way every
 * existing Cypress reporter (allure-cypress, cypress-mochawesome-reporter,
 * etc.) accesses the live Mocha runner — there is no public/typed
 * alternative. Declared locally rather than widened globally so the
 * `any`-shaped access stays contained to this one file.
 */
interface CypressWithMocha {
  mocha: {
    getRunner(): Mocha.Runner;
  };
}

/** `Runnable._currentRetry`/`_retries` are declared `private` on Mocha's
 * `Runnable` class in the bundled type definitions (compile-time only —
 * they're ordinary properties at runtime). A standalone (non-intersected)
 * shape cast through `unknown` is required to read them — intersecting
 * directly with `Mocha.Test` collapses to `never`, since TypeScript treats
 * a private member of the same name as incompatible with any other
 * declaration of it, public or not. Also documented-by-convention: every
 * existing Cypress reporter reads these two fields the same way, since
 * Mocha exposes no public accessor. */
interface RetryFields {
  _currentRetry: number;
}

/** The runtime shape of a Mocha `Hook` runnable relevant to detecting a
 * `beforeEach` hook failure — verified directly against Cypress 14.5.4's
 * bundled runner source (`packages/runner/dist/cypress_runner.js`), not
 * assumed:
 *  - `Runner.prototype.hook`'s `next(i)` closure sets `hook.ctx.currentTest
 *    = self.test` before running a `beforeEach`/`afterEach` hook (a
 *    DIFFERENT assignment applies for `before all`/`after all`, see below),
 *    and only `delete`s it on the hook's SUCCESS path — on failure it
 *    remains set, which is exactly what lets a failure handler recover
 *    which test the hook was guarding.
 *  - `Runner.prototype.failHook` runs `hook.originalTitle = hook.originalTitle
 *    || hook.title` BEFORE emitting `'fail'`, and Mocha's own
 *    `Suite.prototype.beforeEach` always seeds a fresh hook's title as the
 *    literal string `'"before each" hook'` (optionally suffixed with
 *    `: <name>`) — so `originalTitle` reliably starts with that exact
 *    prefix for (and only for) a beforeEach-flavored hook, regardless of
 *    Cypress-driver-internal properties (like `hookName`) whose presence on
 *    the raw Mocha object at this exact point wasn't verifiable the same
 *    way.
 */
interface HookRunnable {
  type?: string;
  originalTitle?: string;
  title?: string;
  ctx?: { currentTest?: Mocha.Test };
}

function retryIndex(test: Mocha.Test): number {
  return (test as unknown as RetryFields)._currentRetry ?? 0;
}

function formatError(err: unknown): string | undefined {
  if (err === undefined || err === null) {
    return undefined;
  }
  if (err instanceof Error) {
    return err.stack ? `${err.message}\n${err.stack}` : err.message;
  }
  return String(err);
}

interface AttemptTrackerEntry {
  test: Mocha.Test;
  attempts: AttemptSnapshot[];
  lastRecordedRetryIndex?: number;
  willRetry: boolean;
}

/**
 * Pure, Cypress/Mocha-independent bookkeeping for collapsing one logical
 * test's retry attempts into the array `case-builder.ts`'s
 * `collapseAttempts` expects — extracted so it's unit-testable without a
 * real Mocha runtime (mirrors `CommandLogBuffer`'s pure-class/thin-adapter
 * split in `command-log-listener.ts`).
 *
 * Keyed by `test.fullTitle()` — Mocha permits duplicate/colliding titles
 * across different `describe` blocks — but WITHOUT ever leaking dedup state
 * across two different tests that happen to share a key: every piece of
 * per-attempt dedup bookkeeping (`lastRecordedRetryIndex`) lives INSIDE the
 * same entry as the attempts it protects, and both are deleted together the
 * instant that test is finalized (`takeIfFinal`/`drainOrphaned`). A LATER,
 * unrelated test that reuses the same key after the first one is finalized
 * starts from a brand-new entry with no memory of the first test's
 * attempts. This replaces an earlier design (a single spec-lifetime-global,
 * never-cleared `Set` of dedup keys) that caused a title-colliding test's
 * data to be silently dropped forever, independent of retries — found via
 * a deep adversarial self-review, never by any automated test (this file
 * previously had zero unit coverage).
 *
 * Each entry also retains the `Mocha.Test` reference it was recorded
 * against, not just its attempts — needed so `drainOrphaned` can hand back
 * something `queue.ts`'s `flushCase` can actually use, for entries whose
 * own test will never get a normal `afterEach` (see that method's doc
 * comment for why immediate flushing from other call sites was tried and
 * found unsafe).
 */
export class MochaAttemptTracker {
  private entries = new Map<string, AttemptTrackerEntry>();

  private entryFor(key: string, test: Mocha.Test): AttemptTrackerEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { test, attempts: [], willRetry: false };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Records one attempt, deduped against only the immediately-preceding
   * record for THIS test (never against any other test's history). More
   * than one Mocha/Cypress event can legitimately fire for the same
   * physical attempt (verified empirically: `runner.on('fail', ...)` AND
   * `runner.on('retry', ...)` both fire for one failing-and-retried
   * attempt) — a second call with the same `retryIndex` for the same key
   * is a no-op rather than double-recording. */
  record(key: string, retryIdx: number, test: Mocha.Test, snapshot: AttemptSnapshot): void {
    const entry = this.entryFor(key, test);
    if (entry.lastRecordedRetryIndex === retryIdx) {
      return;
    }
    entry.lastRecordedRetryIndex = retryIdx;
    entry.attempts.push(snapshot);
  }

  /** Marks this test's most-recently-recorded attempt as non-final — more
   * attempts are coming, so `takeIfFinal`/`drainOrphaned` must not flush
   * yet. Only meaningful immediately after a `record()` call for the same
   * attempt (Cypress's retry mechanism always records the failing attempt
   * before emitting `'retry'`). A no-op if no entry exists yet for `key`. */
  markWillRetry(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.willRetry = true;
    }
  }

  /** The `afterEach`-driven path for the CURRENTLY-ending test: returns its
   * attempts and forgets them — UNLESS `markWillRetry` was called for the
   * attempt just recorded, in which case this consumes that flag and
   * returns `undefined`, leaving the entry in place so the next attempt
   * appends to the same array instead of starting fresh. Returns
   * `undefined` (nothing to do) if no entry exists for `key` at all. */
  takeIfFinal(key: string): AttemptSnapshot[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.willRetry) {
      entry.willRetry = false;
      return undefined;
    }
    this.entries.delete(key);
    return entry.attempts;
  }

  /**
   * Sweeps every OTHER finalized-but-never-collected entry (excluding
   * `excludeKey`, the test this `afterEach` firing is already handling via
   * `takeIfFinal`), skipping anything still mid-retry. This exists for
   * exactly one real scenario: a statically-skipped test (`it.skip(...)` or
   * an inherited `.skip`) fires `'pending'` and gets `record()`ed, but
   * Mocha's skip path never runs `afterEach` for it at all — so nothing
   * else will ever collect it.
   *
   * The obvious-looking alternative — flush a skipped test immediately,
   * right in the `'pending'` handler — was tried and is UNSAFE: verified
   * empirically (a real `cypress run` against a fixture spec containing
   * `it.skip(...)`) that calling `cy.task()` synchronously from that
   * handler doesn't just silently no-op, it HANGS the entire run
   * indefinitely (Cypress's command-queue machinery for a test whose body
   * never executes at all appears to never reach a state where a
   * newly-enqueued command can be processed). `drainOrphaned` instead waits
   * until the NEXT real `afterEach` fires (a call site independently
   * proven safe for `cy.task()`, both here and by every other flush in this
   * file) and sweeps anything left over at that point.
   *
   * Residual, honestly-documented limitation: if EVERY test in a spec file
   * is statically skipped, no real `afterEach` ever fires at all in that
   * spec, so a lingering skip entry is never swept — the same outcome as
   * before this fix, for that one narrower sub-case. The common case (at
   * least one non-skipped test in the spec) is fully fixed.
   */
  drainOrphaned(excludeKey: string): Array<{ test: Mocha.Test; attempts: AttemptSnapshot[] }> {
    const drained: Array<{ test: Mocha.Test; attempts: AttemptSnapshot[] }> = [];
    for (const [key, entry] of this.entries) {
      if (key === excludeKey || entry.willRetry) {
        continue;
      }
      drained.push({ test: entry.test, attempts: entry.attempts });
      this.entries.delete(key);
    }
    return drained;
  }
}

/**
 * Wires the browser-side Mocha listener: accumulates one `AttemptSnapshot`
 * per test-attempt (Cypress's built-in retry re-runs the same `Test`
 * object in place, firing one 'pass'/'fail'/'retry'/'pending' per attempt —
 * not per logical test) into a `MochaAttemptTracker`, and flushes each
 * test's collapsed result to the Node side once its outcome is final.
 *
 * CRITICAL, verified-by-running-real-Cypress detail: Mocha's `afterEach`
 * fires after EVERY physical attempt of a retried test — including ones
 * that will be retried again — not just once after retries are exhausted.
 * The fix is `runner.on('retry', ...)`: Mocha fires this (not 'fail')
 * specifically for an attempt that has retries remaining — 'fail' is
 * reserved for a truly final failure. `MochaAttemptTracker.markWillRetry`
 * tracks which test is mid-retry so `takeIfFinal` (called from the root
 * `afterEach` below) can skip flushing for that attempt and wait for the
 * actual final one.
 *
 * Also verified directly against Cypress's bundled runner source
 * (`Runner.prototype.hook`'s retry-emission block): `runner.on('retry', ...)`
 * can fire for an attempt that actually PASSED, under Cypress's
 * experimental flake-detection retry strategies (`test.hasAttemptPassed`) —
 * in that case `err` is guaranteed falsy (the source's own comment: "we can
 * assume the test attempt failed as 'err' would have to be present here"
 * otherwise), so the handler below records `'passed'`, not `'failed'`, when
 * `err` is absent. This package doesn't advertise/configure that
 * experimental strategy today, so this is defensive, not exercised by any
 * current caller.
 *
 * Every flush in this file (`flushCase`, which calls `cy.task()`) happens
 * ONLY from the root-level `afterEach` below — verified the hard way (a
 * real hung `cypress run`) that calling it directly from other Mocha
 * runner event handlers (`'pending'`, a hook-failure `'fail'`) is not
 * reliably safe. Both `'pending'` and the hook-failure branch below only
 * `record()`; `afterEach` is what actually collects and uploads.
 *
 * A root-level `afterEach`, registered here at support-file load time,
 * flushes each test's accumulated attempts once confirmed final — Mocha's
 * innermost-first `afterEach` ordering guarantees this also runs after any
 * `afterEach` the spec itself authored.
 */
export function registerMochaListener(): void {
  const runner = (Cypress as unknown as CypressWithMocha).mocha.getRunner();
  const tracker = new MochaAttemptTracker();

  // One buffer, shared across the whole spec file's lifetime; reset per
  // attempt (below) and drained into each AttemptSnapshot at record() time —
  // see command-log-listener.ts for why steps are attempt-scoped, not
  // test-scoped (an abandoned/retried attempt's steps must never survive
  // into the next attempt's buffer).
  const stepBuffer = new CommandLogBuffer();
  registerCommandLogListener(stepBuffer);

  function buildSnapshot(test: Mocha.Test, status: CaseStatus, err?: unknown): AttemptSnapshot {
    const steps = stepBuffer.drain();
    const metadata = getDefaultMetadataBuffer().drain();
    return {
      status,
      duration: test.duration ?? 0,
      error: formatError(err),
      steps: steps.length > 0 ? steps : undefined,
      ...metadata,
    };
  }

  // Fires once per ATTEMPT (Cypress's retry mechanism re-runs the same Test
  // object in place, so this fires again on each retry) — resets both the
  // command-log step buffer AND the qualflare.* metadata buffer, so a fresh
  // attempt starts with empty state rather than inheriting entries from
  // whatever attempt (if any) just finished. The shared metadata buffer also
  // becomes "active" here (see `test-metadata-buffer.ts`) — a qualflare.*
  // call made before the first 'test' event of a spec (e.g. module-load
  // time, or inside a `before()` hook) correctly warns-and-no-ops instead of
  // silently writing into a buffer nothing has activated yet.
  runner.on('test', () => {
    stepBuffer.reset();
    getDefaultMetadataBuffer().reset();
  });

  runner.on('pass', (test) => {
    tracker.record(test.fullTitle(), retryIndex(test), test, buildSnapshot(test, 'passed'));
  });

  runner.on('fail', (test, err) => {
    const runnable = test as unknown as HookRunnable;
    if (runnable.type === 'test') {
      // Reached for a truly final failure (no retries remaining) OR —
      // verified empirically — sometimes ALSO for an attempt that 'retry'
      // below just handled; `tracker.record`'s per-attempt dedup covers
      // both cases.
      tracker.record(test.fullTitle(), retryIndex(test), test, buildSnapshot(test, 'failed', err));
      return;
    }

    // A Hook-typed failure. Only a `beforeEach` hook failure is handled
    // here: it fires BEFORE the guarded test's own body has run, so
    // nothing else will ever record that test's result — without this, the
    // test simply vanishes from the report (found via deep self-review,
    // verified against Cypress's actual runner source — see the
    // `HookRunnable` doc comment above for exactly how `ctx.currentTest`
    // and the `'"before each" hook'` title prefix were confirmed).
    // `before`/`afterEach`/`after` hook failures are deliberately NOT
    // synthesized here: `before` guards a whole suite, not one identifiable
    // test, and by the time an `afterEach`/`after` hook fails, the guarded
    // test's own pass/fail/pending has already been recorded normally —
    // re-recording it here would incorrectly overwrite a real result with
    // an unrelated hook-cleanup failure. This is a documented, deliberate
    // scope limitation, not an oversight.
    //
    // Deliberately only `record()`s here — does NOT call `flushCase`
    // directly (see the file header comment on why). Mocha's own
    // hook-failure handling still runs the suite's `afterEach` hooks
    // ("jumps to corresponding after each hook" — confirmed both in
    // Cypress's runner source comments and by observing this codebase's
    // own root-level `afterEach` correctly receiving
    // `this.currentTest === guardedTest` in a real run), so the normal
    // `afterEach` flush below picks this up via `takeIfFinal` exactly like
    // any other final attempt.
    const guardedTest = runnable.ctx?.currentTest;
    const isBeforeEachHook = (runnable.originalTitle ?? runnable.title ?? '').startsWith('"before each" hook');
    if (guardedTest && isBeforeEachHook) {
      tracker.record(guardedTest.fullTitle(), retryIndex(guardedTest), guardedTest, buildSnapshot(guardedTest, 'failed', err));
    }
  });

  // Fires for an attempt that has retries remaining — NOT necessarily a
  // failure (see the file header comment re: experimental flake-detection
  // strategies re-running a PASSED attempt). Still record its data
  // (steps/error/duration all feed `collapseAttempts`), and mark it so the
  // afterEach below skips flushing this attempt and waits for the actual
  // final one.
  runner.on('retry', (test: Mocha.Test, err: unknown) => {
    const status: CaseStatus = err ? 'failed' : 'passed';
    tracker.record(test.fullTitle(), retryIndex(test), test, buildSnapshot(test, status, err));
    tracker.markWillRetry(test.fullTitle());
  });

  runner.on('pending', (test) => {
    // A pending/skipped test never retries, so its outcome is always final
    // the moment 'pending' fires — but do NOT flush here (see the file
    // header comment: calling cy.task() from this handler was found, via a
    // real hung cypress run, to hang the whole process for a statically
    // skipped test). Just record; `drainOrphaned` (called from the next
    // real afterEach) sweeps this up from a call site proven safe.
    tracker.record(test.fullTitle(), retryIndex(test), test, buildSnapshot(test, 'skipped'));
  });

  // Fallback for failures that don't reach the Runner's own 'fail'/'retry'
  // events at all (e.g. some uncaught-exception paths) — `tracker.record`'s
  // dedup guard means this never double-counts an attempt already captured
  // through the normal path above.
  Cypress.on('fail', (err, runnable) => {
    // `Mocha.Runnable` (the base class) doesn't declare `type` — only its
    // `Test`/`Hook` subclasses do — so this is checked via a loose cast
    // rather than the type system, matching runner.on('fail')'s own
    // runtime-vs-declared-type mismatch above.
    if ((runnable as unknown as { type?: string }).type !== 'test') {
      throw err;
    }
    const test = runnable as Mocha.Test;
    tracker.record(test.fullTitle(), retryIndex(test), test, buildSnapshot(test, 'failed', err));
    throw err;
  });

  afterEach(function flushCurrentTest(this: Mocha.Context) {
    const test = this.currentTest;
    if (!test) {
      return;
    }
    const key = test.fullTitle();
    const attempts = tracker.takeIfFinal(key);
    if (attempts) {
      flushCase(test, attempts);
    }
    // Sweep any orphaned entries (statically-skipped tests, whose own
    // afterEach never runs) now that we know cy.task() is safe — we're
    // inside a real afterEach for a real test.
    for (const orphan of tracker.drainOrphaned(key)) {
      flushCase(orphan.test, orphan.attempts);
    }
  });
}
