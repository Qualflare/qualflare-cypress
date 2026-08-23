import { describe, expect, it, vi } from 'vitest';

import { detectGit, type ExecGit } from '../../src/plugin/git-detect.js';

describe('detectGit', () => {
  it('resolves branch/commit from CI env vars without ever shelling out', () => {
    const exec: ExecGit = vi.fn(() => {
      throw new Error('should not be called — env vars already resolved both fields');
    });
    const result = detectGit(
      { GIT_BRANCH: 'main', GIT_COMMIT: 'abc123' },
      '/repo',
      exec,
    );
    expect(result).toEqual({ branch: 'main', commit: 'abc123' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('follows the documented CI env-var precedence for branch: GIT_BRANCH > GITHUB_REF_NAME > CI_COMMIT_REF_NAME > BITBUCKET_BRANCH', () => {
    const exec: ExecGit = vi.fn(() => '');
    expect(
      detectGit(
        { GITHUB_REF_NAME: 'feature/x', CI_COMMIT_REF_NAME: 'other', BITBUCKET_BRANCH: 'yet-another' },
        '/repo',
        exec,
      ).branch,
    ).toBe('feature/x');
    expect(
      detectGit({ CI_COMMIT_REF_NAME: 'gitlab-branch', BITBUCKET_BRANCH: 'bb-branch' }, '/repo', exec).branch,
    ).toBe('gitlab-branch');
    expect(detectGit({ BITBUCKET_BRANCH: 'bb-branch' }, '/repo', exec).branch).toBe('bb-branch');
  });

  it('follows the documented CI env-var precedence for commit: GIT_COMMIT > GITHUB_SHA > CI_COMMIT_SHA > BITBUCKET_COMMIT', () => {
    const exec: ExecGit = vi.fn(() => '');
    expect(
      detectGit({ GITHUB_SHA: 'sha1', CI_COMMIT_SHA: 'sha2', BITBUCKET_COMMIT: 'sha3' }, '/repo', exec).commit,
    ).toBe('sha1');
  });

  it('falls back to a git subprocess only for the field CI env vars did not resolve', () => {
    const calls: string[][] = [];
    const exec: ExecGit = (args) => {
      calls.push(args);
      if (args[0] === 'symbolic-ref') return 'local-branch\n';
      return '';
    };
    const result = detectGit({ GIT_COMMIT: 'from-env' }, '/repo', exec);
    expect(result).toEqual({ branch: 'local-branch', commit: 'from-env' });
    // Only the branch subprocess ran — commit was already resolved from env.
    expect(calls).toEqual([['symbolic-ref', '--short', '-q', 'HEAD']]);
  });

  it('resolves both from git subprocess when no CI env vars are set', () => {
    const exec: ExecGit = (args) => {
      if (args[0] === 'symbolic-ref') return 'main\n';
      if (args[0] === 'rev-parse') return 'deadbeef\n';
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    };
    expect(detectGit({}, '/repo', exec)).toEqual({ branch: 'main', commit: 'deadbeef' });
  });

  it('treats a detached HEAD (git error) as unavailable rather than throwing', () => {
    const exec: ExecGit = (args) => {
      if (args[0] === 'symbolic-ref') {
        throw new Error('fatal: ref HEAD is not a symbolic ref');
      }
      return 'deadbeef\n';
    };
    const result = detectGit({}, '/repo', exec);
    expect(result.branch).toBeUndefined();
    expect(result.commit).toBe('deadbeef');
  });

  it('treats a non-git directory (both subprocess calls error) as fully unavailable, never throwing', () => {
    const exec: ExecGit = () => {
      throw new Error('fatal: not a git repository');
    };
    expect(() => detectGit({}, '/not-a-repo', exec)).not.toThrow();
    expect(detectGit({}, '/not-a-repo', exec)).toEqual({});
  });

  it('treats an empty (whitespace-only) subprocess output the same as an error', () => {
    const exec: ExecGit = () => '   \n';
    expect(detectGit({}, '/repo', exec)).toEqual({});
  });
});
