import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/plugin/resolve-config.js';

/**
 * Covers Milestone 5's wiring: config-option overrides beat auto-detection,
 * auto-detection beats absence, full absence resolves to the documented
 * defaults/null — for branch/commit (git-detect) and the four ci* fields
 * (ci-detect). `resolveConfig`'s real detectors are replaced via its `deps`
 * injection point so these tests never shell out to `git` or read this
 * process's real env/ci-info state.
 */
describe('resolveConfig — git/CI auto-detection wiring', () => {
  const baseOptions = { token: 'tok' };

  beforeEach(() => {
    vi.stubEnv('QUALFLARE_BRANCH', '');
    vi.stubEnv('QF_BRANCH', '');
    vi.stubEnv('QUALFLARE_COMMIT', '');
    vi.stubEnv('QF_COMMIT', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('an explicit branch/commit option wins over auto-detection, and detectGit is never even called', () => {
    const detectGit = vi.fn(() => ({ branch: 'auto-branch', commit: 'auto-commit' }));
    const resolved = resolveConfig(
      { ...baseOptions, branch: 'manual-branch', commit: 'manual-commit' },
      { detectGit },
    );
    expect(resolved.branch).toBe('manual-branch');
    expect(resolved.commit).toBe('manual-commit');
    expect(detectGit).not.toHaveBeenCalled();
  });

  it('an explicit `branch: null` option is respected as "no branch" — both fields already resolved (one to null, one manually), so detectGit is never called', () => {
    const detectGit = vi.fn(() => ({ branch: 'auto-branch', commit: 'auto-commit' }));
    const resolved = resolveConfig({ ...baseOptions, branch: null, commit: 'manual-commit' }, { detectGit });
    expect(resolved.branch).toBeNull();
    expect(resolved.commit).toBe('manual-commit');
    expect(detectGit).not.toHaveBeenCalled();
  });

  it('an explicit `branch: null` option combined with an UNRESOLVED commit still triggers detection (for commit only — branch stays null)', () => {
    const detectGit = vi.fn(() => ({ branch: 'auto-branch', commit: 'auto-commit' }));
    const resolved = resolveConfig({ ...baseOptions, branch: null }, { detectGit });
    expect(resolved.branch).toBeNull();
    expect(resolved.commit).toBe('auto-commit');
    expect(detectGit).toHaveBeenCalledTimes(1);
  });

  it('auto-detection fills in branch/commit when neither option nor env resolves them', () => {
    const detectGit = vi.fn(() => ({ branch: 'auto-branch', commit: 'auto-commit' }));
    const resolved = resolveConfig(baseOptions, { detectGit });
    expect(resolved.branch).toBe('auto-branch');
    expect(resolved.commit).toBe('auto-commit');
  });

  it('resolves to null when neither option, env, nor auto-detection finds anything', () => {
    const detectGit = vi.fn(() => ({}));
    const resolved = resolveConfig(baseOptions, { detectGit });
    expect(resolved.branch).toBeNull();
    expect(resolved.commit).toBeNull();
  });

  it('skips calling detectGit entirely when both branch and commit are already resolved from options', () => {
    const detectGit = vi.fn(() => ({ branch: 'should-not-be-used', commit: 'should-not-be-used' }));
    resolveConfig({ ...baseOptions, branch: 'b', commit: 'c' }, { detectGit });
    expect(detectGit).not.toHaveBeenCalled();
  });

  it('an explicit ci* option wins over auto-detection', () => {
    const detectCi = vi.fn(() => ({
      ciProvider: 'auto-provider',
      ciBuildNumber: 'auto-build',
      ciRunUrl: 'https://auto.example/run',
      ciPrNumber: 999,
    }));
    const resolved = resolveConfig(
      { ...baseOptions, ciProvider: 'manual-provider', ciBuildNumber: 'manual-build' },
      { detectCi },
    );
    expect(resolved.ciProvider).toBe('manual-provider');
    expect(resolved.ciBuildNumber).toBe('manual-build');
    // ciRunUrl/ciPrNumber were not overridden — auto-detection still fills them in.
    expect(resolved.ciRunUrl).toBe('https://auto.example/run');
    expect(resolved.ciPrNumber).toBe(999);
  });

  it('auto-detection fills in all four ci* fields when no options are given', () => {
    const detectCi = vi.fn(() => ({
      ciProvider: 'GitHub Actions',
      ciBuildNumber: '1',
      ciRunUrl: 'https://github.com/org/repo/actions/runs/1',
      ciPrNumber: 2,
    }));
    const resolved = resolveConfig(baseOptions, { detectCi });
    expect(resolved).toMatchObject({
      ciProvider: 'GitHub Actions',
      ciBuildNumber: '1',
      ciRunUrl: 'https://github.com/org/repo/actions/runs/1',
      ciPrNumber: 2,
    });
  });

  it('ci* fields are all undefined when not in CI and nothing is configured', () => {
    const detectCi = vi.fn(() => ({}));
    const resolved = resolveConfig(baseOptions, { detectCi });
    expect(resolved.ciProvider).toBeUndefined();
    expect(resolved.ciBuildNumber).toBeUndefined();
    expect(resolved.ciRunUrl).toBeUndefined();
    expect(resolved.ciPrNumber).toBeUndefined();
  });

  it('detectCi is always called (cheap, no subprocess) even when every ci* option is already set', () => {
    const detectCi = vi.fn(() => ({}));
    resolveConfig(
      { ...baseOptions, ciProvider: 'p', ciBuildNumber: 'b', ciRunUrl: 'https://x', ciPrNumber: 1 },
      { detectCi },
    );
    expect(detectCi).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression tests for a real bug found via deep adversarial self-review:
 * `environment`/`language`/`framework` used to resolve via `??`, which only
 * falls back on `null`/`undefined` — so an explicit `options.environment: ''`
 * won outright over the `'development'` default instead of being treated as
 * "not set." An empty required field 400s the whole launch server-side, and
 * (since `failOnUploadError` defaults `false`) that failure was previously
 * silent. Fixed to use the same truthy-check pattern `collect-builder.ts`'s
 * `resolveOs`/`resolveBrowser` already correctly use for `os`/`browser`.
 */
describe('resolveConfig — empty-string options fall through to defaults, not treated as a deliberate value', () => {
  const baseOptions = { token: 'tok' };

  beforeEach(() => {
    vi.stubEnv('QUALFLARE_ENVIRONMENT', '');
    vi.stubEnv('QF_ENVIRONMENT', '');
    vi.stubEnv('QUALFLARE_LANGUAGE', '');
    vi.stubEnv('QF_LANGUAGE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('an empty-string environment option falls through to the "development" default, not ""', () => {
    const resolved = resolveConfig({ ...baseOptions, environment: '' });
    expect(resolved.environment).toBe('development');
  });

  it('an empty-string language option falls through to the "en-US" default, not ""', () => {
    const resolved = resolveConfig({ ...baseOptions, language: '' });
    expect(resolved.language).toBe('en-US');
  });

  it('an empty-string framework option falls through to the "cypress" default, not ""', () => {
    const resolved = resolveConfig({ ...baseOptions, framework: '' });
    expect(resolved.framework).toBe('cypress');
  });

  it('a non-empty environment/language/framework option is still respected exactly as given', () => {
    const resolved = resolveConfig({ ...baseOptions, environment: 'staging', language: 'fr-FR', framework: 'my-fork' });
    expect(resolved.environment).toBe('staging');
    expect(resolved.language).toBe('fr-FR');
    expect(resolved.framework).toBe('my-fork');
  });
});
