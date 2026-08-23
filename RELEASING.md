# Releasing

## Cutting a release

1. Ensure `main` is green: `.github/workflows/ci.yml` passing (unit tests + the real-Cypress
   integration suite across the full `cypress` version matrix).
2. Bump `version` in `package.json` (follow semver — this package has no compiled binary and no
   platform-specific variants, so a plain version bump is the whole change).
3. Update `CHANGELOG.md` with the new version's changes.
4. Commit: `chore: release vX.Y.Z`.
5. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z` — pushing the tag triggers
   `.github/workflows/npm-publish.yml`, which verifies the tag matches `package.json`'s version,
   re-runs the full quality gate (typecheck/lint/build/unit test), and publishes to npm with
   provenance attestation (`id-token: write`, matching `qualflare-cli`'s publish pattern).
6. Confirm the publish succeeded: `npm view @qualflare/cypress version` should show the new version,
   and the npm package page should show a "Provenance" badge.

## 1.0.0 checklist specifically

Beyond the steps above, before the first `1.0.0`:

- [ ] Milestones 1–6 all complete and independently verified (this repo's own commit history/PRs
      are the record of that).
- [ ] The real-Cypress integration suite (`npm run test:integration`) has been run successfully in
      CI across the full declared `peerDependencies.cypress` range, not just locally.
- [ ] **Manual smoke test against a live Qualflare account** — this cannot be automated in CI
      (it needs a real `QUALFLARE_TOKEN` and a real project to observe results in): run
      `examples/basic` (see its own README) against a real Qualflare project, and confirm in the
      Qualflare UI that the resulting Launch shows the expected suites/cases/steps/labels/screenshots
      correctly — this is the actual end-to-end proof that the wire-contract implementation matches
      what's live in production, not just what the mock server in `test/integration/` asserts.
- [ ] `docs/CONFIGURATION.md`, `docs/LIMITATIONS.md`, and `docs/METADATA-API.md` reviewed for
      accuracy against the actual shipped `src/plugin/resolve-config.ts`/`src/browser/metadata-api.ts`
      (not the other way around — code is the source of truth, regenerate docs from it if they've
      drifted).
- [ ] README quickstart tested by someone who hasn't worked on this package, following it verbatim
      in a fresh Cypress project.
