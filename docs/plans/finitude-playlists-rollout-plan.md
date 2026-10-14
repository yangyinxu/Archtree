# Finitude Playlists Rollout Plan

The shared Playlist implementation is complete in Archtree/Web and iOS. The
Android client now includes authenticated owner fencing, UI, shared playback,
actual-start activity and completed local-Audio resolution. This plan tracks
the native delivery and rollout boundary; canonical Playlist behavior remains in `docs/business-rules.md`.

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
- Android resolves validated completed device Audio in the ordinary shared
  queue, while Video and Room sources retain their separate boundaries. Native
  implementation and publication do not establish production enablement.

## Stage 2 — Publish the native client candidates

Status: Complete

- Native account and download candidates were verified and published to each
  repository's `develop` branch on 2026-10-13: Android `6706258` and iOS
  `c9cb492`. Unrelated local changes were preserved.
- Android passed 512 JVM tests, lint with zero errors, APK builds and 66
  independent isolated-emulator tests. iOS passed the final 393-unit suite,
  the full 29-UI suite, quality checks and a Simulator build.
- These candidates remain distinct from staging/production enablement and
  physical-device acceptance below.

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

- The last recorded production acceptance reported `playlists: false`;
  implementation presence is not production availability.
- Enable only the exact staging-tested artifact after the Stage 3 evidence is
  complete, then monitor health, error rate, latency, receipt cleanup, and
  client compatibility through the agreed observation window.
- Disable the capability first for a Playlist-specific stop condition; retain
  all Playlist and receipt data. Use application rollback for broader release
  failures and never remove additive Playlist collections during rollback.
- Remove this plan after production enablement, observation, and rollback
  evidence are complete or explicitly retired.
