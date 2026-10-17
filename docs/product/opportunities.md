# Archtree and Finitude Product Opportunities

Status: Candidate backlog. These ideas are not approved product behavior and
do not replace the canonical rules in [`business-rules.md`](../business-rules.md).

Last reviewed: 2026-10-13

<!-- @catalog -->
**Contents**

- [Purpose](#purpose)
- [Decision Principles](#decision-principles)
- [Opportunity Ranking](#opportunity-ranking)
- [Parallel Execution Update](#parallel-execution-update)
- [P0 — Close the Current Integrated Release](#p0--close-the-current-integrated-release)
- [P1 — Native Server-Backed Playlists](#p1--native-server-backed-playlists)
  - [User opportunity](#user-opportunity)
  - [Why this is attractive](#why-this-is-attractive)
  - [Smallest complete slice](#smallest-complete-slice)
- [P1 — Explainable Personalized Discovery](#p1--explainable-personalized-discovery)
  - [User opportunity](#user-opportunity-1)
  - [Spike conclusion](#spike-conclusion)
  - [Required discovery](#required-discovery)
- [P2 — Content Manager Validation, Preview, Drafts, and Atomic Publishing](#p2--content-manager-validation-preview-drafts-and-atomic-publishing)
  - [Operator opportunity](#operator-opportunity)
  - [Spike conclusion and first safe slice](#spike-conclusion-and-first-safe-slice)
- [Selected — AI-Assisted Album Import and Finitude Administration](#selected--ai-assisted-album-import-and-finitude-administration)
- [P2 — Follow Artists and New Releases](#p2--follow-artists-and-new-releases)
  - [User opportunity](#user-opportunity-2)
  - [Selected first release](#selected-first-release)
- [P3 — Cross-Device Playback Checkpoints](#p3--cross-device-playback-checkpoints)
  - [User opportunity](#user-opportunity-3)
  - [Proposed first release](#proposed-first-release)
- [P3 — Playlist Sharing and Collaboration](#p3--playlist-sharing-and-collaboration)
  - [User opportunity](#user-opportunity-4)
  - [Safe sequencing](#safe-sequencing)
- [Ideas Intentionally Not Prioritized](#ideas-intentionally-not-prioritized)
- [Recommended Next Decision](#recommended-next-decision)
<!-- @end-catalog -->

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
| P1 | Adopt server-backed Playlists on Android | Implementation complete with local Audio resolution; production/device rollout remains | High | Medium |
| P1 | Explainable personalized discovery | Contract spike complete; implementation not started | Very high | Medium |
| P2 | Content Manager validation, preview, drafts, and atomic publishing | Contract/lifecycle spike complete; implementation not started | High | Medium–high |
| P2 | Follow Artists and show new releases | Implemented and locally verified; production rollout remains | High | Medium |
| P3 | Cross-device playback checkpoints | Deferred | Medium–high | Medium–high |
| P3 | Read-only Playlist sharing, then collaboration | Deferred | Medium–high | High |

## Parallel Execution Update

- Archtree now exposes stable Page-item identities and strict, signed,
  snapshot-bound pagination for attached manual Grid/List definitions. The
  implementation preserves ready-only public DTOs, private Library viewer
  fencing, and the Web streaming-only boundary. Web, iOS, and Android Home now
  consume the page-scoped endpoint while preserving Carousel compatibility.
- Finitude iOS now has a versioned and recoverable download manifest, bounded
  Album concurrency, strict resume validation, account-transition fencing,
  shared-asset ownership, explicit incompatible-manifest protection, and a
  SQLite-backed offline catalog used for bounded Library and device-local Home
  pagination. Stable background `URLSession` restoration, task/generation
  reconciliation and app-delegate event delivery are now implemented and
  locally tested; physical suspend/termination acceptance remains in its plan.
- Finitude Android now has secure password authentication, encrypted rotating
  credentials, authoritative viewer recovery, account-epoch fencing, and a
  real Bearer-authenticated path to the existing Playlist client. Its Home
  supports strict, independently paged Grid/List sections, and one shared
  actual-start coordinator records the correct Album or MediaTrack from Home,
  Search, Album details, and Playlists without navigation or retry duplicates.
  Device Song/complete-Album downloads share assets and merge with saved rows;
  user-started dataSync transfers continue in the background and restore paused
  work after interruption. Expanded-player Save, password recovery/change,
  private avatars, devices, history clearing, logout-all and eligible account
  deletion use owner/generation fences. Optional provider configuration,
  production enablement and physical-device acceptance remain separate gates.

## P0 — Close the Current Integrated Release

The integrated baseline was merged and verified through the normal release
workflow with exact artifact and rollback evidence. Automated production,
browser, and contract evidence is complete for that release. User-observation,
assistive-technology, authenticated-account, and physical-device gates that
could not be run safely remain recorded as `Skipped`, not passed.

Relevant tracking documents include:

- [`plans/finitude-integrated-release-execution-plan.md`](../plans/finitude-integrated-release-execution-plan.md)
- [`plans/finitude-playlists-rollout-plan.md`](../plans/finitude-playlists-rollout-plan.md)
- [`testing/finitude-web-release-matrix.md`](../testing/finitude-web-release-matrix.md)
- [`deployment-todos.md`](../deployment/todos.md)

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

- iOS server-backed Playlists are implemented. The current integrated local
  suite passes 236 unit and 22 UI tests, including account-transition fencing,
  automated accessibility audit, maximum Dynamic Type, unavailable-member
  order, and three-digit positions. Shared authenticated Web/iOS and
  physical-device playback/VoiceOver gates are `Skipped` because safe
  credentials/signing were unavailable.
- Android now has the owner-fenced API, validation, idempotency, state, Compose,
  localization, secure password authentication, encrypted rotating
  credentials, authoritative viewer recovery, and a real Bearer-authenticated
  ready-only shared-queue path. Playlist playback records Recently Played only
  after the exact initial MediaTrack actually starts, through the same
  coordinator now used by Home, Search, and Album playback. Ordinary Audio
  queues resolve validated device files first. Broader account and Song/Album
  download code is implemented; production capability enablement and
  physical-device evidence remain separate milestones;
  the local implementation does not prove that the feature is deployed.

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
[`plans/explainable-discovery-and-artist-follows-plan.md`](../plans/explainable-discovery-and-artist-follows-plan.md).
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
[`plans/content-manager-prepublish-validation-preview-spike.md`](../plans/content-manager-prepublish-validation-preview-spike.md).
Implementation and canonical rule changes are in progress. Production enablement follows the storage and delivery acceptance gates.

## Selected — AI-Assisted Album Import and Finitude Administration

Prepare new Albums from uploaded music, filenames, relative folder names, and
embedded tags. GPT-6 Luna proposes missing metadata with sources and conflicts;
administrators review private drafts and publish from Finitude. Shared admin
editing also supports corrections to existing Artist, Album, and track metadata.
Administrators switch between Admin and User views using a separate upper-right
current-view control; User view hides administrative features while preserving
the same account and listening state.
Admin controls also set public/hidden visibility for each Page item placement,
Artist, Organization, Album, and MediaTrack. The same read restriction covers
hidden Feed Posts. Hidden content is readable
only through authenticated administrator management/preview routes; ordinary
details, discovery, media, artwork, and relationship projections enforce the
restriction. Existing offline copies require a separately defined boundary.
Import review also checks existing files, Artists, and Album editions, offering
explicit reuse, skip, append-missing, or distinct-entry decisions. Matching names
or AI suggestions never automatically merge records or move tracks between Albums.
Accepted Luna analysis runs as durable server work; closing or switching the
originating page does not cancel it. Reopening reads retained status/results and
drafts without restarting paid analysis or automatically publishing content.
A fixed administrator workbench lists analyzing, awaiting-review, needs-attention,
and completed projects, with independent upload/AI/review/publication states and
protected server counts. Administrators can resume saved work across devices.
Review provides a field/group diff with current values, sourced suggestions, and
conflicts. Administrators adopt selected changes only into the private draft;
publication uses the reviewed result and requires separate confirmation.

The first implementation is available in Web, iOS, and Android behind independently
disabled admission flags. Configuration and routes are documented in the
[administrator workbench documentation](../features/admin-workbench.md);
shared behavior is defined in [business rules](../business-rules.md#administrator-album-imports).
The provider uses supplied names, folders and bounded embedded tags; embedded or
manually uploaded artwork is explicitly selected. Source-verified external release
and cover lookup, acoustic fingerprinting, and background file transfer remain
separate future contracts. Production enablement follows real storage/delivery
checks, representative provider cost/quality measurements, and physical-device
acceptance. No production enablement is implied by local automated tests.

## P2 — Follow Artists and New Releases

### User opportunity

Listeners should be able to express durable interest in an Artist and quickly
see new ready releases from followed Artists.

### Selected first release

- Add owner-scoped Follow and Unfollow actions.
- Add a configured **New from Artists you follow** Home Carousel.
- Derive release membership from canonical Album and MediaTrack Credits.
- Keep email, push notifications, public follower counts, and public profiles
  out of the first release.
- Keep Follow state out of personalized discovery scoring in v1.

The independent Follow/new-release contract is recorded alongside discovery in
[`plans/explainable-discovery-and-artist-follows-plan.md`](../plans/explainable-discovery-and-artist-follows-plan.md).
Follow is private, owner-only, independently flagged, and not a discovery input
in v1. The Follow defaults were selected on 2026-10-13 and promoted into
`business-rules.md`. Backend/Web, iOS and Android implementation and local
automated verification are complete; production and physical-device acceptance
remain external rollout gates. Discovery remains a separate unapproved candidate.

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
- **Further native and Video group listening:** Web Audio Rooms already has
  an implemented authority/reconnect contract. Native production adapters and
  shared Video remain separate work; controlled production rollout is still
  gated in [`deployment-todos.md`](../deployment/todos.md).
- **Lyrics:** requires a licensed, attributable source and correction policy,
  not only a presentation surface.
- **Voice Search:** lower expected value than completing Native Playlists and
  improving discovery with the existing catalog graph.

## Recommended Next Decision

The completed automated native Playlist work can move through its normal local
review/merge path, while unavailable user/device gates remain `Skipped`.
Android password authentication, authenticated activity and local Audio
resolution now make its Playlist client reachable. The next rollout step is
controlled staging/production and physical-device acceptance. Artist Follow
and new releases were selected for implementation on 2026-10-13. Discovery and
Content Manager remain implementation-ready candidates; their product choices
and canonical-rule promotion are separate from the selected Follow work.
