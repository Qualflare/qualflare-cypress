import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectCi } from '../../src/plugin/ci-detect.js';

describe('detectCi — explicit per-provider extraction table', () => {
  it('extracts GitHub Actions build number, run URL, and PR number from a PR ref', () => {
    const env = {
      GITHUB_ACTIONS: 'true',
      GITHUB_RUN_NUMBER: '42',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'Qualflare/qualflare-cypress',
      GITHUB_RUN_ID: '123456',
      GITHUB_REF: 'refs/pull/17/merge',
    };
    expect(detectCi(env)).toEqual({
      ciProvider: 'GitHub Actions',
      ciRunId: '123456',
      ciBuildNumber: '42',
      ciRunUrl: 'https://github.com/Qualflare/qualflare-cypress/actions/runs/123456',
      ciPrNumber: 17,
    });
  });

  it('omits ciPrNumber for a GitHub Actions push event (no PR ref)', () => {
    const env = {
      GITHUB_ACTIONS: 'true',
      GITHUB_RUN_NUMBER: '42',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'Qualflare/qualflare-cypress',
      GITHUB_RUN_ID: '123456',
      GITHUB_REF: 'refs/heads/main',
    };
    const result = detectCi(env);
    expect(result.ciProvider).toBe('GitHub Actions');
    expect(result.ciPrNumber).toBeUndefined();
  });

  it('extracts GitLab CI fields', () => {
    const env = {
      GITLAB_CI: 'true',
      CI_PIPELINE_IID: '99',
      CI_PIPELINE_URL: 'https://gitlab.com/org/repo/-/pipelines/99',
      CI_MERGE_REQUEST_IID: '5',
    };
    expect(detectCi(env)).toEqual({
      ciProvider: 'GitLab CI',
      ciBuildNumber: '99',
      ciRunUrl: 'https://gitlab.com/org/repo/-/pipelines/99',
      ciPrNumber: 5,
    });
  });

  it('extracts CircleCI fields', () => {
    const env = {
      CIRCLECI: 'true',
      CIRCLE_BUILD_NUM: '7',
      CIRCLE_BUILD_URL: 'https://circleci.com/gh/org/repo/7',
      CIRCLE_PR_NUMBER: '3',
    };
    expect(detectCi(env)).toEqual({
      ciProvider: 'CircleCI',
      ciRunId: '7',
      ciBuildNumber: '7',
      ciRunUrl: 'https://circleci.com/gh/org/repo/7',
      ciPrNumber: 3,
    });
  });

  it('extracts Buildkite fields and parses a real PR number', () => {
    const env = {
      BUILDKITE: 'true',
      BUILDKITE_BUILD_NUMBER: '55',
      BUILDKITE_BUILD_URL: 'https://buildkite.com/org/pipeline/builds/55',
      BUILDKITE_PULL_REQUEST: '9',
    };
    expect(detectCi(env)).toEqual({
      ciProvider: 'Buildkite',
      ciBuildNumber: '55',
      ciRunUrl: 'https://buildkite.com/org/pipeline/builds/55',
      ciPrNumber: 9,
    });
  });

  it('omits ciPrNumber for a Buildkite non-PR build (BUILDKITE_PULL_REQUEST="false")', () => {
    const env = {
      BUILDKITE: 'true',
      BUILDKITE_BUILD_NUMBER: '55',
      BUILDKITE_BUILD_URL: 'https://buildkite.com/org/pipeline/builds/55',
      BUILDKITE_PULL_REQUEST: 'false',
    };
    const result = detectCi(env);
    expect(result.ciProvider).toBe('Buildkite');
    expect(result.ciPrNumber).toBeUndefined();
  });

  it('extracts Jenkins fields (no PR number — no standardized env var)', () => {
    const env = {
      JENKINS_URL: 'https://jenkins.example.com/',
      BUILD_NUMBER: '212',
      BUILD_URL: 'https://jenkins.example.com/job/foo/212/',
    };
    expect(detectCi(env)).toEqual({
      ciProvider: 'Jenkins',
      ciRunId: '212',
      ciBuildNumber: '212',
      ciRunUrl: 'https://jenkins.example.com/job/foo/212/',
    });
  });

  it('extracts Azure Pipelines fields and builds a run URL from collection/project/build id', () => {
    const env = {
      TF_BUILD: 'True',
      BUILD_BUILDID: '888',
      SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: 'https://dev.azure.com/org/',
      SYSTEM_TEAMPROJECT: 'My Project',
      SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '21',
    };
    expect(detectCi(env)).toEqual({
      ciProvider: 'Azure Pipelines',
      ciRunId: '888',
      ciBuildNumber: '888',
      ciRunUrl: 'https://dev.azure.com/org/My%20Project/_build/results?buildId=888',
      ciPrNumber: 21,
    });
  });

  it('extracts Bitbucket Pipelines fields', () => {
    const env = {
      BITBUCKET_BUILD_NUMBER: '33',
      BITBUCKET_GIT_HTTP_ORIGIN: 'https://bitbucket.org/org/repo',
      BITBUCKET_PIPELINE_UUID: '{abc-123}',
      BITBUCKET_PR_ID: '4',
    };
    expect(detectCi(env)).toEqual({
      ciProvider: 'Bitbucket Pipelines',
      ciRunId: '33',
      ciBuildNumber: '33',
      ciRunUrl: 'https://bitbucket.org/org/repo/addon/pipelines/home#!/results/{abc-123}',
      ciPrNumber: 4,
    });
  });

  it('never sends a non-numeric or <1 PR number — omits the field instead', () => {
    const env = {
      GITLAB_CI: 'true',
      CI_MERGE_REQUEST_IID: 'not-a-number',
    };
    expect(detectCi(env).ciPrNumber).toBeUndefined();

    const envZero = { GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '0' };
    expect(detectCi(envZero).ciPrNumber).toBeUndefined();
  });

  it('checks providers in table order — the first match wins when multiple env vars are (implausibly) set', () => {
    const env = { GITHUB_ACTIONS: 'true', GITLAB_CI: 'true' };
    expect(detectCi(env).ciProvider).toBe('GitHub Actions');
  });
});

describe('detectCi — ci-info fallback', () => {
  // ci-info computes its exports once, against the REAL process.env, at
  // module-import time — it does not honor detectCi's `env` parameter (see
  // the doc comment on detectCi), and env-var stubbing + vi.resetModules()
  // does not reliably force a CJS dependency under node_modules to
  // re-evaluate under Vitest's module graph. vi.doMock + vi.resetModules +
  // a dynamic re-import of the module UNDER TEST is the reliable,
  // Vitest-native way to substitute what `ci-detect.ts` sees when it
  // imports 'ci-info', regardless of that package's own internals.
  afterEach(() => {
    vi.doUnmock('ci-info');
    vi.resetModules();
  });

  it("falls back to ci-info's free-text provider name for a provider outside the explicit table", async () => {
    vi.doMock('ci-info', () => ({ name: 'Travis CI', isCI: true }));
    vi.resetModules();
    const { detectCi: freshDetectCi } = await import('../../src/plugin/ci-detect.js');
    // No env var here matches any entry in our own PROVIDERS table, so this
    // must fall all the way through to the mocked ci-info.name.
    const result = freshDetectCi({});
    expect(result).toEqual({ ciProvider: 'Travis CI' });
  });

  it('returns an empty object when ci-info reports no provider (not running in CI)', async () => {
    vi.doMock('ci-info', () => ({ name: null, isCI: false }));
    vi.resetModules();
    const { detectCi: freshDetectCi } = await import('../../src/plugin/ci-detect.js');
    expect(freshDetectCi({})).toEqual({});
  });
});
