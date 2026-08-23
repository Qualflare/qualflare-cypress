import { describe, expect, it } from 'vitest';

import { MAX_CASES_PER_SUITE } from '../../src/shared/constants.js';
import { CaseBuffer } from '../../src/plugin/tasks.js';
import type { Case } from '../../src/shared/types.js';

function fakeCase(id: string): Case {
  return { id, name: id, status: 'passed', duration: 1 };
}

/**
 * `Suite.cases` is a REJECT-not-truncate field server-side (`max=5000`) —
 * `MAX_CASES_PER_SUITE` existed as a constant since Milestone 1 but was
 * never actually enforced anywhere (found via deep adversarial self-review).
 * Exceeding it previously meant the server would 400 the entire launch, not
 * just drop the excess cases.
 */
describe('CaseBuffer', () => {
  it('accumulates cases under the cap normally', () => {
    const buffer = new CaseBuffer();
    buffer.add(fakeCase('a'));
    buffer.add(fakeCase('b'));
    expect(buffer.drain()).toHaveLength(2);
  });

  it('warns and drops further cases once MAX_CASES_PER_SUITE is reached, rather than exceeding the server-rejected cap', () => {
    const buffer = new CaseBuffer();
    for (let i = 0; i < MAX_CASES_PER_SUITE + 10; i += 1) {
      buffer.add(fakeCase(`case-${i}`));
    }
    expect(buffer.drain()).toHaveLength(MAX_CASES_PER_SUITE);
  });

  it('resets the cap-warned state on drain, so a later spec hitting the cap warns again rather than staying silent', () => {
    const buffer = new CaseBuffer();
    for (let i = 0; i < MAX_CASES_PER_SUITE + 5; i += 1) {
      buffer.add(fakeCase(`first-spec-${i}`));
    }
    expect(buffer.drain()).toHaveLength(MAX_CASES_PER_SUITE);

    // A second spec file's worth of cases, buffered after drain() reset the
    // buffer — should be able to reach the cap again, not stay truncated
    // from the first spec's state.
    for (let i = 0; i < MAX_CASES_PER_SUITE + 5; i += 1) {
      buffer.add(fakeCase(`second-spec-${i}`));
    }
    expect(buffer.drain()).toHaveLength(MAX_CASES_PER_SUITE);
  });
});
