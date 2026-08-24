import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/plugin/resolve-config.js';

// No git/CI detection matters for these assertions — stub both to avoid a
// real `git` subprocess / process.env dependency, mirroring
// resolve-config-detection.test.ts's own fakes.
const NOOP_DEPS = { detectGit: () => ({}), detectCi: () => ({}) };

describe('resolveConfig — outputDir', () => {
  it('defaults outputDir to ./qualflare-results', () => {
    const resolved = resolveConfig({}, NOOP_DEPS);
    expect(resolved.outputDir).toBe('./qualflare-results');
  });

  it('honors an explicit outputDir option', () => {
    const resolved = resolveConfig({ outputDir: './custom-dir' }, NOOP_DEPS);
    expect(resolved.outputDir).toBe('./custom-dir');
  });

  it('honors QUALFLARE_OUTPUT_DIR when no option is given', () => {
    process.env.QUALFLARE_OUTPUT_DIR = '/tmp/from-env';
    try {
      const resolved = resolveConfig({}, NOOP_DEPS);
      expect(resolved.outputDir).toBe('/tmp/from-env');
    } finally {
      delete process.env.QUALFLARE_OUTPUT_DIR;
    }
  });

  it('an explicit outputDir option wins over the environment variable', () => {
    process.env.QUALFLARE_OUTPUT_DIR = '/tmp/from-env';
    try {
      const resolved = resolveConfig({ outputDir: './custom-dir' }, NOOP_DEPS);
      expect(resolved.outputDir).toBe('./custom-dir');
    } finally {
      delete process.env.QUALFLARE_OUTPUT_DIR;
    }
  });

  it('never throws for a missing token — token no longer exists', () => {
    expect(() => resolveConfig({}, NOOP_DEPS)).not.toThrow();
  });

  it('passes an explicit shardIndex through unchanged', () => {
    const resolved = resolveConfig({ shardIndex: 3 }, NOOP_DEPS);
    expect(resolved.shardIndex).toBe(3);
  });

  it('omits shardIndex when nothing sets it', () => {
    const resolved = resolveConfig({}, NOOP_DEPS);
    expect(resolved.shardIndex).toBeUndefined();
  });

  it('honors QUALFLARE_SHARD_INDEX from environment variable', () => {
    process.env.QUALFLARE_SHARD_INDEX = '2';
    try {
      const resolved = resolveConfig({}, NOOP_DEPS);
      expect(resolved.shardIndex).toBe(2);
    } finally {
      delete process.env.QUALFLARE_SHARD_INDEX;
    }
  });

  it('an explicit shardIndex option wins over the environment variable', () => {
    process.env.QUALFLARE_SHARD_INDEX = '5';
    try {
      const resolved = resolveConfig({ shardIndex: 3 }, NOOP_DEPS);
      expect(resolved.shardIndex).toBe(3);
    } finally {
      delete process.env.QUALFLARE_SHARD_INDEX;
    }
  });
});
