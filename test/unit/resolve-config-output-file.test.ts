import { describe, expect, it } from 'vitest';

import { QualflareConfigError, resolveConfig } from '../../src/plugin/resolve-config.js';

// No git/CI detection matters for these assertions — stub both to avoid a
// real `git` subprocess / process.env dependency, mirroring
// resolve-config-detection.test.ts's own fakes.
const NOOP_DEPS = { detectGit: () => ({}), detectCi: () => ({}) };

describe('resolveConfig — outputFile mode', () => {
  it('throws QualflareConfigError when enabled with no token and no outputFile (normal-mode default)', () => {
    expect(() => resolveConfig({}, NOOP_DEPS)).toThrow(QualflareConfigError);
  });

  it('does NOT throw when outputFile is set, even with no token — this process never authenticates in file mode', () => {
    const config = resolveConfig({ outputFile: '/tmp/shard-0.json' }, NOOP_DEPS);
    expect(config.outputFile).toBe('/tmp/shard-0.json');
    expect(config.token).toBe('');
  });

  it('resolves outputFile from the QUALFLARE_OUTPUT_FILE environment variable', () => {
    process.env.QUALFLARE_OUTPUT_FILE = '/tmp/from-env.json';
    try {
      const config = resolveConfig({ token: 'x' }, NOOP_DEPS);
      expect(config.outputFile).toBe('/tmp/from-env.json');
    } finally {
      delete process.env.QUALFLARE_OUTPUT_FILE;
    }
  });

  it('an explicit outputFile option wins over the environment variable', () => {
    process.env.QUALFLARE_OUTPUT_FILE = '/tmp/from-env.json';
    try {
      const config = resolveConfig({ outputFile: '/tmp/from-option.json' }, NOOP_DEPS);
      expect(config.outputFile).toBe('/tmp/from-option.json');
    } finally {
      delete process.env.QUALFLARE_OUTPUT_FILE;
    }
  });

  it('an explicit outputFile: "" falls through exactly like an unset option (still requires a token)', () => {
    expect(() => resolveConfig({ outputFile: '' }, NOOP_DEPS)).toThrow(QualflareConfigError);
  });

  // Regression test: outputFile mode originally only guarded the final
  // /collect POST — the separate video-upload HTTP path (presign + PUT)
  // had no outputFile check anywhere and fired real, token-less requests
  // even in "offline" file mode. Found via adversarial self-review,
  // empirically reproduced against a real cucumber-js run before being
  // fixed by forcing uploadVideos off here, centrally.
  it('forces uploadVideos off in outputFile mode, even when explicitly requested true', () => {
    const config = resolveConfig({ outputFile: '/tmp/shard-0.json', uploadVideos: true }, NOOP_DEPS);
    expect(config.uploadVideos).toBe(false);
  });

  it('leaves uploadVideos at its configured/default value in normal (non-outputFile) mode', () => {
    const defaultConfig = resolveConfig({ token: 'x' }, NOOP_DEPS);
    expect(defaultConfig.uploadVideos).toBe(true);

    const explicitConfig = resolveConfig({ token: 'x', uploadVideos: false }, NOOP_DEPS);
    expect(explicitConfig.uploadVideos).toBe(false);
  });
});
