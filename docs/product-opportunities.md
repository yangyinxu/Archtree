# Archtree and Finitude Product Opportunities

Status: Candidate backlog. These ideas are not approved product behavior and
do not replace the canonical rules in [`business-rules.md`](business-rules.md).

Last reviewed: 2026-08-26

## Purpose

This document preserves promising product directions without prematurely
turning them into implementation commitments. An opportunity moves into a
dedicated file under `docs/plans/` only after its scope and product behavior are
approved. A bounded discovery spike may have a dedicated plan while its product
decisions remain explicitly `Skipped`; that does not approve implementation.
Any approved behavior that changes the shared Archtree/Finitude contract must
also be added to `business-rules.md` during implementation.

## Decision Principles

- Finish release, production, and physical-device evidence for already-built
  capabilities before opening several large feature tracks.
- Prefer work that reuses the existing catalog, Playlist, Credits, player,
  localization, authentication, and lifecycle contracts.
- Keep Web streaming-only unless a separate product decision explicitly
  changes that rule.
- Add recommendation signals and social visibility only with explicit privacy,
  ownership, deletion, and account-transition behavior.
- Ship the smallest complete user loop before adding automation, real-time
  collaboration, AI, or additional infrastructure.

## Opportunity Ranking

| Priority | Opportunity | Current disposition | Expected value | Relative effort |
| --- | --- | --- | --- | --- |
| P0 | Close the current integrated release | Automated release baseline complete; remaining user/device gates Skipped | Very high | Medium |
| P1 | Adopt server-backed Playlists on iOS | Implemented; automated contract/simulator verification complete | High | Medium |
| P1 | Adopt server-backed Playlists on Android | Secure authentication implemented; activity, local-Audio, and rollout remain | High | Medium |
| P1 | Explainable personalized discovery | Contract spike complete; implementation not started | Very high | Medium |
| P2 | Content Manager validation, preview, drafts, and atomic publishing | Contract/lifecycle spike complete; implementation not started | High | Medium–high |
| P2 | Follow Artists and show new releases | Contract spike complete; implementation not started | High | Medium |
| P3 | Cross-device playback checkpoints | Deferred | Medium–high | Medium–high |
| P3 | Read-only Playlist sharing, then collaboration | Deferred | Medium–high | High |

## Parallel Execution Update

- Archtree now exposes stable Page-item identities and strict, signed,
  snapshot-bound pagination for attached manual Grid/List definitions. The
  implementation preserves ready-only public DTOs, private Library viewer
  fencing, and the Web streaming-only boundary.
- Finitude iOS now has a versioned and recoverable download manifest, bounded
  Album concurrency, strict resume validation, account-transition fencing,
  shared-asset ownership, and explicit incompatible-manifest protection.
  System-restored background `URLSession` work and an indexed offline catalog
  remain in its dedicated plan.
- Finitude Android now has secure password authentication, encrypted rotating
  credentials, authoritative viewer recovery, account-epoch fencing, and a
  real Bearer-authenticated path to the existing Playlist client. Recently
  Played writes, completed local-Audio resolution, broader account flows, and
  release enablement remain separate work.

## P0 — Close the Current Integrated Release

The integrated baseline was merged and verified through the normal release
workflow with exact artifact and rollback evidence. Automated production,
browser, and contract evidence is complete for that release. User-observation,
assistive-technology, authenticated-account, and physical-device gates that
could not be run safely remain recorded as `Skipped`, not passed.

Relevant tracking documents include:

- [`plans/finitude-integrated-release-execution-plan.md`](plans/finitude-integrated-release-execution-plan.md)
- [`plans/finitude-playlists-rollout-plan.md`](plans/finitude-playlists-rollout-plan.md)
- [`testing/finitude-web-release-matrix.md`](testing/finitude-web-release-matrix.md)
- [`deployment-todos.md`](deployment-todos.md)

Current disposition: the release prerequisite no longer blocks independent
planning or automated implementation work. Skipped device/account evidence
remains a separately owned verification boundary.

## P1 — Native Server-Backed Playlists

### User opportunity

Listeners should find the same private, ordered Playlists on Web, iOS, and
Android instead of losing access when they change platforms.

### Why this is attractive

Archtree and Web already implement the core Playlist persistence, ownership,
revision, idempotency, ordering, unavailable-member, deletion, and playback
contracts. Native adoption can reuse those decisions and the shared player
rather than designing another backend feature.

### Smallest complete slice

- Start with iOS using the existing server DTO and revision contract.
- Support list, create, rename, delete, add, remove, accessible reorder, and
  ready-only playback through the existing shared queue.
- Let existing local MediaTrack resolution prefer a valid downloaded Audio
  asset without presenting the Playlist itself as downloaded.
- Adopt the same behavior on Android after the iOS contract and fixtures pass.
- Keep Downloaded Playlists out of scope until a separate offline lifecycle is
  approved.

Current disposition:

- iOS server-backed Playlists are implemented. The full local suite passes 198
  unit and 19 UI tests, including account-transition fencing, automated
  accessibility audit, maximum Dynamic Type, unavailable-member order, and
  three-digit positions. Shared authenticated Web/iOS and physical-device
  playback/VoiceOver gates are `Skipped` because safe credentials/signing were
  unavailable.
- Android now has the owner-fenced API, validation, idempotency, state, Compose,
  localization, secure password authentication, encrypted rotating
  credentials, authoritative viewer recovery, and a real Bearer-authenticated
  ready-only shared-queue path. Real Recently Played writes, completed
  local-Audio resolution, broader account flows, production capability
  enablement, and physical-device evidence remain separate milestones; the
  local implementation does not prove that the feature is deployed.

## P1 — Explainable Personalized Discovery

### User opportunity

Recently Saved and Recently Played help listeners return to known content but
do not help them discover something new. Finitude can use its existing catalog
relationships to create a useful discovery loop without introducing an opaque
AI system.

### Spike conclusion

- Add one administrator-configured Home Carousel source rather than a new Radio
  route or playback authority.
- Rank ready candidates with deterministic, fixture-visible signals from
  canonical Credits, Album relationships, Saves, and recent activity.
- Show a concise reason for each recommendation.
- Provide **Not interested** and a way to clear or reset recommendation input.
- Omit an empty generated source and preserve existing administrator-curated
  Home order for signed-out listeners and cold starts.
- Keep Artist Follow state out of discovery scoring in v1 so the two rollouts
  remain independently testable and reversible.

### Required discovery

- Define diversity, repetition, readiness, and unavailable-content rules.
- Decide which account signals are retained and how listeners control them.
- Keep recommendation computation separate from privacy-bounded anonymous Web
  performance telemetry.
- Establish offline behavior and cross-platform deterministic fixtures.

The complete proposal, fixture contract, lifecycle, retention, compatibility,
rollout, and rollback stages are recorded in
[`plans/explainable-discovery-and-artist-follows-plan.md`](plans/explainable-discovery-and-artist-follows-plan.md).
Its product choices remain `Skipped`; production implementation and canonical
rule changes are not started.

## P2 — Content Manager Validation, Preview, Drafts, and Atomic Publishing

### Operator opportunity

Administrators should be able to prepare and validate related catalog and Home
changes without exposing a partially edited public state.

### Spike conclusion and first safe slice

- Start with an administrator-only, ephemeral Page Layout preflight for title,
  attach, detach, and reorder intent.
- Apply the proposed intent in memory, validate the complete Page composition
  and referenced storage, and render the same allowlisted public projection.
- Persist no draft, operation, database, S3, or public state in this first slice.
- Treat immutable drafts, atomic publication, audited forward rollback, asset
  staging, and scheduling as later stages after the shared contract is approved.

The lifecycle map, first-slice DTO, authorization, evidence, concurrency, tests,
future changeset model, rollout, and rollback are recorded in
[`plans/content-manager-prepublish-validation-preview-spike.md`](plans/content-manager-prepublish-validation-preview-spike.md).
Implementation and canonical rule changes are not started.

## P2 — Follow Artists and New Releases

### User opportunity

Listeners should be able to express durable interest in an Artist and quickly
see new ready releases from followed Artists.

### Proposed first release

- Add owner-scoped Follow and Unfollow actions.
- Add an in-app **New from Artists you follow** section or destination.
- Derive release membership from canonical Album and MediaTrack Credits.
- Keep email, push notifications, public follower counts, and public profiles
  out of the first release.
- Keep Follow state out of personalized discovery scoring in v1.

The independent Follow/new-release contract is recorded alongside discovery in
[`plans/explainable-discovery-and-artist-follows-plan.md`](plans/explainable-discovery-and-artist-follows-plan.md).
Follow is private, owner-only, independently flagged, and not a discovery input
in v1. Its product choices remain `Skipped`; implementation is not started.

## P3 — Cross-Device Playback Checkpoints

### User opportunity

Listeners using Video or longer Audio MediaTracks should be able to continue
from a useful position after changing devices or relaunching.

### Proposed first release

- Apply checkpoints only to eligible long-form content rather than every song.
- Write bounded, low-frequency, revision-aware progress updates.
- Ignore positions near the beginning or end and never overwrite a newer
  checkpoint with a late update.
- Add **Continue playing** without changing the existing Recently Played limit
  or queue activity rules.
- Provide account-level checkpoint clearing and remove checkpoints during
  account deletion.

Promotion condition: define eligibility, write frequency, conflict resolution,
offline reconciliation, completion, privacy, and clearing behavior.

## P3 — Playlist Sharing and Collaboration

### User opportunity

Listeners should eventually be able to share a sequence with other people and,
after the read-only model is safe, invite trusted collaborators.

### Safe sequencing

1. Add revocable, unlisted, read-only share links that expose only allowlisted
   ready content and no private owner metadata.
2. Add authenticated invitations and explicit member roles.
3. Add concurrent add, remove, and reorder behavior with conflict recovery.
4. Consider reactions or synchronous shared queues only after asynchronous
   collaboration is reliable.

Promotion condition: define link entropy and expiry, visibility, moderation,
revocation, ownership transfer, member removal, account deletion, audit,
abuse-rate limits, and concurrent mutation behavior.

## Ideas Intentionally Not Prioritized

- **Web offline downloads:** conflicts with the current Web streaming-only
  contract and requires a separate product decision.
- **AI DJ or prompt-generated Playlists:** premature before Finitude has a
  reviewed recommendation model, listener controls, and success evidence.
- **Real-time group listening:** substantially expands presence, queue
  authority, abuse, and reconnect behavior; read-only sharing should come
  first.
- **Lyrics:** requires a licensed, attributable source and correction policy,
  not only a presentation surface.
- **Voice Search:** lower expected value than completing Native Playlists and
  improving discovery with the existing catalog graph.

## Recommended Next Decision

The completed automated native Playlist work can move through its normal local
review/merge path, while unavailable user/device gates remain `Skipped`.
Android authentication plus authenticated activity recording is the next
dependency if Android Playlists are to become reachable. Discovery/Follow and
Content Manager now have implementation-ready spikes, but their canonical-rule
promotion and production stages remain `Not started` because the required
product choices were deliberately skipped rather than silently approved.
