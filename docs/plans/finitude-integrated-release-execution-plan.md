# Finitude Integrated Release Execution Plan

## Stage 1 — Freeze the integrated candidate scope

**Status: Complete**

- Map every modified and untracked file to an active product or release plan.
- Exclude unrelated user work, ignored outputs, credentials, and local artifacts.
- Close every business-rule gap discovered by the release audit, including
  registration verification, reference cleanup, and media lifecycle safety.
- Treat the final committed tree as one immutable release candidate.

## Stage 2 — Reconcile release evidence and repository hygiene

**Status: Complete**

- Remove the prohibited third-party term from every candidate blob, path, and
  commit metadata field.
- The user confirmed that the rule applies to the resulting tree, blobs, paths,
  and commit subject while allowing historical deletion lines in `git show`.
  The staged tree and paths contain zero occurrences; Stage 4 must retain a
  neutral commit subject.
- Align plan statuses, release-matrix counts, CI evidence, and rollout docs.
- Keep Linux pixel evidence distinct from the macOS baseline, and document a
  rollback-compatible `/finitude` path before production promotion.
- Delete only dedicated plan files whose implementation and required
  verification are complete.

## Stage 3 — Run the final pre-commit release gates

**Status: Complete**

- Complete: unit/component, production build, E2E TypeScript, Mongo integration,
  strict no-update three-engine browser/accessibility/visual, and tracked-diff
  whitespace checks all pass on the current local tree.
- Complete: dependency and lockfiles are unchanged; Playwright reports/results
  remain ignored; committed browser fixtures and reviewed visual baselines are
  intentional release evidence.
- Complete: an independent path-by-path scope review found no unrelated
  candidate file beyond the user-owned `AGENTS.md`, which remains unstaged.

## Stage 4 — Publish the immutable candidate

**Status: Complete**

- PR #58 merged candidate `1ca9ec9` into exact `main` commit `f54fb4e`.
- Merged-main workflow `32852606600` passed and retained the commit-named
  artifact whose `RELEASE.json` records `github-32852606600-1`.
- The immediately previous artifact remains retained as the rollback input.
- Production health, `/finitude` routes, compatibility redirect, and the
  canonical 52-track Album response were verified independently of CI.
- Artifact availability and production health do not satisfy the still-missing
  staging, manual-device, Playlist-enable, observation, or rollback stages.

## Stage 5 — Deploy and verify staging

**Status: Blocked**

- Record the staging target, release owner, rollback owner, observation window,
  stop conditions, candidate archive, and previous known-good archive.
- Deploy with Playlists disabled, verify health and required Mongo indexes,
  then explicitly enable staging Playlists for the complete smoke matrix.
- Capture Web Vitals, real-browser/device/assistive-technology evidence, and an
  approved media-load result where authorized.
- This stage requires an authorized staging target, safe accounts, devices,
  and named release ownership. It is skipped while those inputs are absent.

## Stage 6 — Rehearse rollback and promote production

**Status: Blocked**

- Redeploy the previous exact archive, verify recovery, then restore the same
  staging-tested candidate archive.
- Verify the previous archive through its own route contract and exercise the
  prepared compatibility redirect for `/finitude` deep links.
- Promote that archive to production with Playlists initially disabled.
- Enable the feature only after health, index, isolation, and production-safe
  smoke checks pass; retain the rollback bundle through the observation window.
- The base application is already healthy in production, but Playlists remain
  fail-closed and an actual rollback rehearsal has not been performed. Neither
  condition is silently promoted to passed evidence.
