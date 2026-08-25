# Archtree and Finitude Product Opportunities

Status: Candidate backlog. These ideas are not approved product behavior and
do not replace the canonical rules in [`business-rules.md`](business-rules.md).

Last reviewed: 2026-08-24

## Purpose

This document preserves promising product directions without prematurely
turning them into implementation commitments. An opportunity moves into a
dedicated file under `docs/plans/` only after its scope and product behavior are
approved. Any approved behavior that changes the shared Archtree/Finitude
contract must also be added to `business-rules.md` during implementation.

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
| P0 | Close the current integrated release | Required prerequisite | Very high | Medium |
| P1 | Adopt server-backed Playlists on iOS | Ready for planning after P0 | High | Medium |
| P1 | Adopt server-backed Playlists on Android | Follow iOS contract | High | Medium |
| P1 | Explainable personalized discovery and Radio | Discovery needed | Very high | Medium |
| P2 | Content Manager drafts, preview, and atomic publishing | Discovery needed | High | Medium–high |
| P2 | Follow Artists and show new releases | Discovery needed | High | Medium |
| P3 | Cross-device playback checkpoints | Deferred | Medium–high | Medium–high |
| P3 | Read-only Playlist sharing, then collaboration | Deferred | Medium–high | High |

## P0 — Close the Current Integrated Release

Before starting another major feature, complete the remaining release,
staging, production, browser, assistive-technology, and physical-device gates
already tracked in the repository. Reconcile `develop` with the release branch
through the normal release workflow and preserve reproducible evidence.

Relevant tracking documents include:

- [`plans/finitude-integrated-release-execution-plan.md`](plans/finitude-integrated-release-execution-plan.md)
- [`plans/finitude-web-listener-plan.md`](plans/finitude-web-listener-plan.md)
- [`plans/finitude-user-playlists-plan.md`](plans/finitude-user-playlists-plan.md)
- [`deployment-todos.md`](deployment-todos.md)

Completion condition: existing release-blocking work has an explicit pass,
accepted exception, or separately owned follow-up before feature development
changes the candidate again.

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

Promotion condition: after P0, create a dedicated iOS implementation plan from
the existing P6 design in `plans/finitude-user-playlists-plan.md`; then create
the Android parity plan from the verified shared contract.

## P1 — Explainable Personalized Discovery and Radio

### User opportunity

Recently Saved and Recently Played help listeners return to known content but
do not help them discover something new. Finitude can use its existing catalog
relationships to create a useful discovery loop without introducing an opaque
AI system.

### Proposed first release

- Add **Play similar content** to ready Artist, Album, and MediaTrack surfaces.
- Add Home sections such as **Because you saved…**, **More from these
  collaborators**, and **Continue exploring this Artist**.
- Rank candidates with reviewed deterministic signals such as shared Credits,
  Album relationships, Organization releases, Saves, and recent activity.
- Show a concise reason for each recommendation.
- Provide **Not interested** and a way to clear or reset recommendation input.
- Fall back to administrator-curated content for signed-out listeners and cold
  starts.

### Required discovery

- Define diversity, repetition, readiness, and unavailable-content rules.
- Decide which account signals are retained and how listeners control them.
- Keep recommendation computation separate from privacy-bounded anonymous Web
  performance telemetry.
- Establish offline behavior and cross-platform deterministic fixtures.

Promotion condition: approve the signal, privacy, explanation, deletion, and
activity contracts before creating an implementation plan or changing Home.

## P2 — Content Manager Drafts and Atomic Publishing

### Operator opportunity

Administrators should be able to prepare and validate related catalog and Home
changes without exposing a partially edited public state.

### Proposed first release

- Store an immutable draft revision or changeset separately from the current
  public projection.
- Provide an administrator-only preview that never weakens public readiness or
  authorization rules.
- Validate missing artwork, unavailable MediaTracks, incomplete uploads,
  dangling references, and unsupported Page items before publish.
- Publish one approved changeset atomically where supported, with explicit
  partial-failure evidence where a single transaction is not possible.
- Retain a bounded revision history and an audited rollback action.
- Add scheduling only after manual draft and publish behavior is proven.

Promotion condition: map create, replace, publish, failure, retry, rollback,
reconciliation, and S3 ownership lifecycles before approving persistence or UI
changes.

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
- Allow Follow state to become an input to personalized discovery only after
  the recommendation contract is approved.

Promotion condition: define canonical Artist identity, release time, deletion,
account cleanup, signed-out behavior, and multi-client mutation semantics.

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

Complete P0, then approve or reject iOS Playlist adoption as the next formal
implementation track. In parallel, a bounded product and data-contract spike
may define the deterministic recommendation signals without writing production
behavior.
