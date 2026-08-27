# Finitude Playlists Rollout Plan

The shared Playlist implementation is complete in Archtree/Web and iOS. The
Android local candidate now includes authenticated owner fencing, UI, shared
playback, and actual-start activity; local-Audio resolution remains incomplete.
This plan tracks only that final integration and the rollout boundary;
canonical Playlist behavior remains in `docs/business-rules.md`.

## Stage 1 — Reconcile implementation candidates

Status: Complete

- Archtree and Finitude Web implement the owner-only Playlist contract,
  revision and idempotency fencing, ordered membership, ready-only playback,
  reference cleanup, account deletion, and fail-closed capability flag.
- Finitude iOS implements the same server-backed contract and automated
  simulator coverage, including account fencing, accessibility, Dynamic Type,
  unavailable members, and three-digit positions.
- Finitude Android implements the owner-fenced API, validation, mutation
  recovery, state, Compose UI, localization, secure session restoration, and a
  real Bearer-authenticated shared-queue path. Its shared actual-start
  coordinator records the exact initial Playlist MediaTrack once without
  counting Previous, Next, automatic advancement, restored playback, or failed
  starts.
- Android still lacks completed local-Audio resolution. That boundary, the
  disabled Archtree production capability, and unpublished native commits
  prevent a deployed-feature claim.

## Stage 2 — Publish the native client candidates

Status: Blocked

- The verified iOS and Android commits currently exist only on their local
  `develop` branches and have not been pushed.
- Publish them through each repository's normal integration path without
  combining unrelated work or claiming skipped physical-device evidence.
- This stage remains blocked until repository publication is explicitly in
  scope; local implementation work can continue independently.

## Stage 3 — Verify staging readiness

Status: Blocked

- Record the staging target, release owner, rollback owner, stop conditions,
  observation window, candidate artifacts, and previous known-good artifacts.
- Verify the Playlist owner-order and idempotency-receipt indexes before
  enabling traffic.
- Deploy with `FINITUDE_PLAYLISTS_ENABLED=false`, then enable only in staging
  and run the complete owner-isolation, lost-response, stale-revision,
  unavailable-member, playback, account-deletion, and cleanup smoke flow.
- This stage needs a safe staging target and test accounts; per the user's
  coordination instruction it is skipped while those inputs are unavailable.

## Stage 4 — Enable production and observe

Status: Blocked

- Production currently reports `playlists: false`; implementation presence is
  not production availability.
- Enable only the exact staging-tested artifact after the Stage 3 evidence is
  complete, then monitor health, error rate, latency, receipt cleanup, and
  client compatibility through the agreed observation window.
- Disable the capability first for a Playlist-specific stop condition; retain
  all Playlist and receipt data. Use application rollback for broader release
  failures and never remove additive Playlist collections during rollback.
- Remove this plan after production enablement, observation, and rollback
  evidence are complete or explicitly retired.
