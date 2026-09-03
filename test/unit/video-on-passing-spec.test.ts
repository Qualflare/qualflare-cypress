import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/plugin/resolve-config.js';

const NOOP_DEPS = { detectGit: () => ({ branch: null, commit: null }), detectCi: () => ({}) };

describe('videoOnFailureOnly', () => {
  // The historical behaviour, kept as the default: a green spec's recording has
  // little diagnostic value and was not worth the bytes.
  it('defaults to true, preserving the failure-only behaviour', () => {
    expect(resolveConfig({}, NOOP_DEPS).videoOnFailureOnly).toBe(true);
  });

  it('can be turned off so an all-passing spec keeps its video', () => {
    expect(resolveConfig({ videoOnFailureOnly: false }, NOOP_DEPS).videoOnFailureOnly).toBe(false);
  });

  it('honours QUALFLARE_VIDEO_ON_FAILURE_ONLY', () => {
    const prev = process.env['QUALFLARE_VIDEO_ON_FAILURE_ONLY'];
    process.env['QUALFLARE_VIDEO_ON_FAILURE_ONLY'] = 'false';
    try {
      expect(resolveConfig({}, NOOP_DEPS).videoOnFailureOnly).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['QUALFLARE_VIDEO_ON_FAILURE_ONLY'];
      else process.env['QUALFLARE_VIDEO_ON_FAILURE_ONLY'] = prev;
    }
  });

  // An explicit option must outrank the env var, matching every other option.
  it('lets an explicit option win over the env var', () => {
    const prev = process.env['QUALFLARE_VIDEO_ON_FAILURE_ONLY'];
    process.env['QUALFLARE_VIDEO_ON_FAILURE_ONLY'] = 'false';
    try {
      expect(resolveConfig({ videoOnFailureOnly: true }, NOOP_DEPS).videoOnFailureOnly).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['QUALFLARE_VIDEO_ON_FAILURE_ONLY'];
      else process.env['QUALFLARE_VIDEO_ON_FAILURE_ONLY'] = prev;
    }
  });
});
