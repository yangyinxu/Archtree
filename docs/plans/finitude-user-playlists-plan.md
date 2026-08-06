# Finitude User Playlists Plan

## Status

Web v1 implementation and local automated gates are complete as of 2026-08-05.
The current integrated candidate passes 222 server, 204 Web, 126 Mongo-backed
integration, and 191 three-engine browser checks with 10 documented skips, but
it remains uncommitted and has no current CI or deployment artifact. P5 remains
in progress for production index verification, staging/manual evidence, and
controlled rollout; P6 iOS adoption remains a separate future stage and does
not block the first Web release.

This is an independent product track with stages **P0–P6**. It does not
renumber or reopen the existing Finitude Web listener phases. Web is the first
client, while Archtree owns one shared contract that a later iOS implementation
will consume.

This document is implementation guidance. The canonical product behavior is
in `../business-rules.md`; agreed behavior must stay synchronized there as the
plan is implemented or changed.

## Objective

Add listener-owned Playlists that let an authenticated user:

- create a Playlist;
- rename, populate, remove from, and reorder it;
- delete it without changing Saved Library or Catalog content;
- find it from the Finitude Web left sidebar;
- open it through a stable route and play its ordered Soundtracks through the
  existing persistent player; and
- use the same server data and mutation rules from a future iOS client.

The reference screenshot establishes information hierarchy only: primary
navigation, a distinct New Playlist action, then the user's Playlist list. The
implementation keeps Finitude's own typography, colors, spacing, icons, and
interaction language instead of copying third-party music-service components.

## Agreed scope

The following requirements come directly from the requested feature and are
already reflected in the shared business rules:

1. Users can create, edit, and delete their own Playlists.
2. Desktop Web places the create action and Playlist list in the left sidebar.
3. The backend contract is shared and platform-neutral so iOS can adopt it
   later without a migration or Web-shaped API.
4. Web Playlist playback remains streaming-only. This feature does not add
   browser downloads or implement native Downloaded Playlists.

## Confirmed P0 product baseline

The user confirmed these defaults on 2026-08-04. They are canonical product
behavior and are reflected in `business-rules.md`.

| Area | Confirmed first-release behavior |
| --- | --- |
| Visibility | Private and owner-only; no public pages, sharing, or collaboration |
| Member type | Ordered Soundtracks (`audioTrack`) only |
| Duplicate membership | Not allowed; repeated Add returns the existing membership state |
| Metadata | Required name only; 1–100 Unicode characters; duplicate names allowed |
| Size | At most 500 Soundtracks per Playlist |
| Artwork | Non-persisted `artworkUrl` from the first persisted-order ready member with usable track or inherited Album artwork; `""` selects the Finitude placeholder; no custom upload |
| List ordering | Newest `updatedAt`, then `_id`, first; no manual sidebar ordering |
| Playback activity | Record the selected starting Soundtrack once; queue navigation is inert |
| Signed-out Create | Keep the action visible and report that sign-in is required without an automatic redirect |
| Library relationship | Library may own the navigation entry, but Playlists do not join the Saved/Downloaded union, filters, or sorting |
| Offline behavior | None on Web; native Downloaded Playlists remain a separate future feature |

The account-level quota is 100 Playlists per account, enforced server-side with
a clear limit response.

The architecture and stage detail below use these confirmed defaults. Any later
change to visibility, member types, duplicate semantics, or limits must revise
the affected business rules, schema, API, lifecycle, and tests together.

## Confirmed P0 non-goals for the first Web release

These exclusions are confirmed for the first release.

- Public, unlisted, or shared Playlists.
- Collaborative editing, followers, likes, comments, or social discovery.
- Folders, pinned Playlists, manual sidebar ordering, or smart/automatic
  Playlists.
- Album membership. A future Add Album action must define whether it snapshots
  the current canonical Album order or remains linked to later Album edits.
- Duplicate Soundtracks, custom artwork uploads, or Playlist-owned S3 objects.
- Editable live Up Next, Play Next, or Add to Queue. A Playlist is persisted
  source data; the active player queue remains an independent snapshot.
- Downloading a whole Playlist on iOS. Local file reuse may be added later, but
  server Playlist membership is not a download manifest.
- Migrating creator `contentCollections` into user Playlists.

## Current-state assessment

### Backend

Archtree already has reusable authentication, safe Soundtrack projection,
Library pagination, revision-aware avatar mutations, content cleanup, account
deletion transactions, and reconciliation reports. The new feature can reuse
those patterns but not their records.

`contentCollections` must not be reused. They are creator-owned Grid/List page
definitions, allow different content semantics and privileged administration,
use unconditional read-modify-write ordering, and intentionally block creator
account deletion. User Playlists instead need owner-scoped writes, the
P0-selected read visibility, optimistic concurrency, listener-account deletion,
and Soundtrack readiness checks.

The existing content-deletion path currently cleans Library, Carousel, Album,
and Artist references. P2 must extend it to Playlists before the new write API
is enabled; otherwise a deleted Soundtrack could leave permanent dangling
membership.

### Web

The persistent shell already has one desktop sidebar, one scrollable main
region, responsive three-item mobile navigation, and one fixed player. The
Playlist work should extend those boundaries rather than create another shell
or player.

The sidebar currently has no internal scroll region. The Playlist area needs
its own `min-height: 0; overflow-y: auto` container so a long list cannot push
the fixed player or application shell. Tablet hides sidebar labels, and mobile
hides the sidebar entirely, so those sizes need a Library-owned Playlist index
instead of compressed Playlist names.

The Web player currently exposes Album-queue and standalone launch operations.
P4 should introduce a neutral queue-launch contract with a source type rather
than pretending a Playlist is an Album. The store already copies queue input,
which gives the required snapshot behavior when a Playlist is later edited or
deleted.

Web has no shared action-menu component and has several separate dialog focus
implementations. Playlist work should consolidate the reusable menu/dialog
boundary before adding create, edit, member, and delete surfaces.

### iOS

Finitude iOS already uses authenticated `/content/me/*` endpoints, a retained
Library navigation stack, one `AudioManager` queue, and explicit playback
activity policy. A future client can add a Playlists destination beneath
Library without adding a fifth app tab.

The current iOS Downloaded filter intentionally displays Playlists as an
unavailable future option. Server Playlist support does not change that local
download rule. A Playlist destination beneath Library remains separate from
the existing Saved/Downloaded Album and Soundtrack union, filters, and sorting.
P6 must keep server DTOs in Networking/ViewModels, use the existing queue
launcher, and preserve local-download ownership boundaries.

## Information architecture

### Routes

| Route | Purpose | Signed-out behavior |
| --- | --- | --- |
| `/finitude/playlists` | Complete Playlist index for tablet/mobile and a desktop fallback | Sign-in-required state |
| `/finitude/playlists/:playlistId` | Owner-only Playlist detail and ordered members | Sign-in-required state; another owner's ID is never disclosed |

Create and rename use modal forms over the current route. Delete uses a
confirmation dialog. A successful desktop create may navigate directly to the
new detail page; mobile returns to the index with the new item focused.

### Desktop, 1024 px and wider

- Keep Home, Search, and Library as primary navigation.
- Add a divider followed by a full-width `+ New playlist` action.
- Add a `Your playlists` label and a separately scrollable summary list.
- Each summary is one line with full accessible text, visual truncation, active
  route state, and a contextual menu for Rename and Delete.
- Fetch summary records only. Do not hydrate member Soundtracks in the shell.
- Keep a `View all` destination when the first sidebar page is exhausted.
- Preserve the bottom player row and the current fixed-shell scroll boundary.

### Tablet, 768–1023 px

- Keep the compact icon rail.
- Expose a labeled/tooled Create Playlist icon; do not render unreadable
  individual Playlist names in the narrow rail.
- Put the complete Playlist list under Library and keep Library selected for
  `/playlists/**` routes.

### Mobile, below 768 px

- Keep the existing Home, Search, and Library bottom tabs.
- Add Saved and Playlists sections or an equivalent secondary destination at
  the top of Library; do not create a fourth tab.
- Put New Playlist in the Playlist index header.
- Keep the compact/expanded player above navigation and retain one queue.

### Playlist detail

The detail surface contains:

- derived/placeholder artwork, name, Soundtrack count, and total playable
  duration when known;
- Play, Rename, Add soundtracks, and More/Delete actions;
- an intentional empty state with Add soundtracks as the primary action;
- ordered rows with separate primary playback and overflow controls;
- Unavailable state for a temporarily non-ready member;
- Remove, Move up, and Move down actions; and
- optional pointer drag-and-drop only as a later enhancement to the keyboard
  and touch-accessible move actions.

Selecting Play starts at the first ready member. Selecting a row starts the
same complete ready queue at that row's position. An unavailable row cannot
start playback and does not shift persisted order.

## Shared persistence design

### `playlists` collection

The recommended first schema is one bounded document per Playlist:

```ts
interface PlaylistDocument {
  _id: ObjectId;
  ownerUserId: string;
  name: string;
  items: Array<{
    itemId: string;
    audioTrackId: string;
    addedAt: Date;
  }>;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}
```

Array order is the canonical member order. Stable `itemId` values allow exact
remove and reorder operations without using mutable array indexes. The 500
member limit keeps versioned atomic updates comfortably below MongoDB's
document limit and permits one complete detail/queue response.

Required index:

```ts
{ ownerUserId: 1, updatedAt: -1, _id: -1 }
```

P1 must verify the production index after deployment. The current index setup
logs and continues after a create-index error, which is not a sufficient
release signal for an owner-scoped private collection.

### Mutation receipts

Generalize the avatar mutation pattern into an account-scoped idempotency
boundary, such as `accountMutations`, keyed by a hash of user ID and
`Idempotency-Key`. A receipt stores operation, target, request fingerprint,
state, a compact replay response, and expiry.

- The minimum replay window is 24 hours. A retry inside that window returns the
  original success status and rehydrates the current owner detail. If the
  Playlist was subsequently deleted, a non-delete replay returns the same
  owner-safe `404`; a Delete receipt continues to replay `204`.
- Once that advertised window has elapsed, clients use a new key and must not
  assume an old Create key still prevents a second intentional creation.
- Reusing the key for different input returns `409`.
- The receipt reservation, Playlist write, revision increment, active-owner
  fence, and completed receipt commit in one MongoDB transaction. A crash or
  aborted transaction exposes neither the business write nor a stuck receipt.
- Concurrent use of the same key is serialized by a unique index; the loser
  replays the committed response or receives a bounded retry response while
  the winning transaction is still resolving.
- Receipts are removed with listener account deletion.
- Receipts contain no Playlist names or Soundtrack titles in logs or telemetry.

Do not repurpose avatar-specific mutation records for Playlist operations.

## Shared DTO contract

### Summary

```ts
interface PlaylistSummaryV1 {
  id: string;
  name: string;
  itemCount: number;
  artworkUrl: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

Sidebar and index reads use summaries only. `artworkUrl` is derived at read
time from the first persisted-order member that satisfies the existing ready
audio predicate (`uploadStatus: 'ready'` plus a nonblank `s3Key`) and provides
safe track-specific or inherited Album artwork. The bounded page projection
uses shared Soundtrack and Album reads rather than one lookup per Playlist;
an empty string preserves the client-owned Finitude placeholder fallback.

### Detail

```ts
interface PlaylistDetailV1 extends PlaylistSummaryV1 {
  items: Array<{
    itemId: string;
    audioTrackId: string;
    addedAt: string;
    availability: 'ready' | 'unavailable';
    audioTrack: ListenerAudioTrackSummaryV1 | null;
  }>;
}
```

Detail hydration performs one bounded batch lookup and restores persisted
order with a map. It reuses the safe listener Soundtrack DTO and never exposes
S3 keys, upload errors, creator-internal fields, email, or owner identifiers.
Unavailable records remain identifiable by canonical content ID but contain no
unsafe database projection.

All Playlist reads return `Cache-Control: private, no-store`, vary by Cookie
and Authorization, and use owner-scoped queries. A missing ID and another
user's ID both return `404`.

## Shared HTTP API

The canonical endpoints live under `/content/me/playlists`, which is already
compatible with native Bearer authentication and Web HttpOnly cookie sessions.

| Method and path | Purpose | Main success |
| --- | --- | --- |
| `GET /content/me/playlists?limit=&cursor=` | Stable updated-time summary page | `200` page + opaque cursor |
| `POST /content/me/playlists` | Create an empty Playlist | `201` detail, revision 1 |
| `GET /content/me/playlists/:playlistId` | Read owner detail | `200` detail |
| `PATCH /content/me/playlists/:playlistId` | Rename | `200` updated detail |
| `DELETE /content/me/playlists/:playlistId` | Delete Playlist only | `204` |
| `POST /content/me/playlists/:playlistId/items` | Add one ready Soundtrack, optionally at a position | `200` updated detail/member state |
| `DELETE /content/me/playlists/:playlistId/items/:itemId` | Remove exact member | `200` updated detail |
| `PUT /content/me/playlists/:playlistId/items/order` | Replace order with the exact current item-ID permutation | `200` updated detail |

Every mutation requires `Idempotency-Key`. Mutations of an existing Playlist
also require `If-Match` with the last confirmed revision:

- missing `If-Match` returns `428`;
- a stale revision returns `409` with the current revision and safe summary;
- success increments revision atomically and returns `ETag: "<revision>"`;
- the MongoDB mutation filter includes `_id`, `ownerUserId`, and `revision`;
- zero matched records are resolved into owner-safe `404` or revision `409`;
- create uses idempotency but has no pre-existing revision to match.

The API documentation states the confirmed idempotency replay window. A
mutation's compact receipt response contains enough ID/revision information for
the client to refetch current detail rather than storing a 500-member response
in every receipt. A later deletion never resurrects the Playlist solely to
serve an older receipt.

The recommended write fences are monotonically increasing, implementation-only
generations: every Playlist mutation increments an active User's
`listenerMutationRevision` in its transaction, and Add also conditionally
increments the ready Soundtrack's `playlistReferenceRevision`. Account deletion
and the ready-to-deleting transition write those same respective documents, so
MongoDB write conflicts force a safe serialization without treating the
generations as user-visible counters.

Add, remove, and reorder must not use an unguarded read-modify-write. Reorder
accepts the complete current `itemIds` set in its desired order; missing,
unknown, or repeated IDs reject the whole request without mutation.

Every cookie-authenticated Web Playlist request sends
`X-Finitude-Account-Viewer` with the viewer ID that owns its cache. Reads and
mutations require that value to match the authenticated user, including Create,
so a stale browser tab cannot display or change a newly switched account's
private data. Native Bearer requests remain bound to their authenticated
account without a Web-only header.

Every Playlist mutation transaction also conditionally touches an active owner
record. Account deletion updates/deletes that same owner record in its deletion
transaction. The shared write fence serializes the operations: if a Playlist
mutation wins, account deletion removes its result; if deletion wins, the
mutation cannot commit an orphaned Playlist or receipt. A failed account-delete
transaction restores the active state rather than leaving a permanently
blocked account.

## Lifecycle and failure contract

| Operation | Successful state | Failure, retry, and reconciliation behavior |
| --- | --- | --- |
| Create | Empty document, revision 1, one replayable receipt | A lost response replays by idempotency key; no S3 or member rollback exists |
| Rename | Name and `updatedAt` change; revision increments | Stale revision returns `409`; validation or write failure leaves the old name intact |
| Add member | Ready Soundtrack appended/inserted once; revision increments | In one MongoDB transaction, conditionally touch a still-ready Soundtrack and update the Playlist/receipt; a concurrent transition to deleting conflicts, and a repeat Add returns existing state |
| Remove member | Exact `itemId` removed; revision increments | Retry replays success; no Saved, Catalog, S3, or download mutation occurs |
| Reorder | Exact full permutation replaces array order; revision increments | Any incomplete/stale permutation rejects atomically; refetch after `409` before retry |
| Delete Playlist | Playlist and its memberships disappear | A receipt replays deletion inside the advertised window; referenced Soundtracks and current queue snapshot remain |
| Start playback | Ready members are copied in persisted order to the shared queue | Unavailable members are skipped; a later edit/delete does not mutate the active queue |
| Soundtrack starts deleting | The Soundtrack first transitions from ready to deleting and blocks new member writes; existing members become Unavailable | A simultaneous Add either commits first and is found by cleanup, or loses the shared Soundtrack write conflict; user may still remove the member |
| Soundtrack deletion succeeds | After S3 deletion, every matching Playlist item is pulled and affected revisions increment before final metadata removal | Bounded cleanup progress remains on the deleting Soundtrack; failure retains evidence for idempotent retry, and finalization proves no Playlist references remain |
| Account deletion | The active-owner fence, Playlists, and mutation receipts are removed in the listener deletion transaction | Concurrent Playlist writes serialize on the owner record; Playlist ownership never triggers the creator-content `409` guard |
| Reconciliation | Read-only report includes dangling items, missing owners, invalid receipt owner/targets, and stalled deletion-cleanup state | Audit does not auto-delete unknown data; repair is a separately confirmed operation |

The Add/delete race is closed by a shared database write boundary rather than
an after-the-fact best-effort check. Add conditionally touches the ready
Soundtrack in the same transaction as its Playlist mutation. Deletion first
changes that Soundtrack to deleting. Both cannot commit in the unsafe order: if
Add commits first, later deletion cleanup sees the member; if deletion commits
first, Add fails its ready condition.

After S3 removal, reference cleanup may run in bounded, resumable batches when
one Soundtrack appears in too many Playlists for one transaction. The deleting
Soundtrack retains cleanup state/cursor as database evidence, blocks new adds,
and is not finally removed until an authoritative no-reference check succeeds.
Each batch pulls matching items and increments affected Playlist revisions. A
stale user reorder then receives `409` and cannot restore the old member set.

Because Playlists own no S3 objects, Playlist create, rename, reorder, and
delete have no storage lifecycle. Catalog Soundtrack deletion retains the
existing rule that database evidence is not removed until owned S3 cleanup and
reference cleanup have succeeded.

## Web client design

### API and cache boundary

Create a lazy-loaded Playlist API/schema module rather than expanding the
initial listener bundle. Query keys include viewer identity:

```ts
['listener', 'playlists', viewerId, listOptions]
['listener', 'playlist', viewerId, playlistId]
['listener', 'playlist-memberships', viewerId, sortedAudioTrackIds]
```

Required cache behavior:

- Create inserts the returned summary/detail, navigates, then revalidates the
  summary list.
- Rename updates exact detail and every current viewer summary page, then
  revalidates.
- Delete cancels exact queries, removes detail and summary entries, then
  navigates to the index.
- Add/remove/reorder update only the exact detail optimistically; summary pages
  update when count or `updatedAt` changes.
- A `409` rolls back optimistic state, refetches detail, and explains that the
  Playlist changed on another device.
- Every query passes the cache layer's `AbortSignal` to fetch.
- Every key contains viewer ID even though account transitions also clear the
  query client.

### Reusable interaction primitives

Before feature dialogs proliferate, extract shared `ModalDialog`, modal-focus,
and `ActionMenu` behavior from the existing account/avatar/player variants.

- Create/Rename initially focuses the name field.
- Delete initially focuses Cancel.
- Escape closes only a non-pending dialog and restores trigger focus.
- Menus support Arrow Up/Down, Home/End, Escape, and focus restoration.
- Errors use an announced alert with a reachable recovery action.
- Move Up/Down announces the new position through `aria-live`.
- A trailing menu never nests inside or triggers a row's playback button/link.
- Visible truncation never truncates the accessible Playlist name.

### Add-to-Playlist surfaces

P4 adds a consistent action to Soundtrack-capable surfaces:

- Album track rows;
- Library Soundtrack rows;
- Search Soundtrack rows;
- Home/Artist Soundtrack lists where an independent trailing action can be
  added without nesting buttons; and
- Playlist detail's Add soundtracks flow.

The picker lists summaries, marks existing membership, permits creation of a
new Playlist, and never starts playback. Card-only surfaces may defer the
action until their component can expose a separate accessible menu target.

## Staged implementation plan

### P0 — Contract freeze and UX specification

**Status: Complete**

**Dependencies:** none.

**Work:**

- Confirm the initial product baseline and choose the per-account quota.
- Promote every accepted baseline decision and quota to `business-rules.md`.
- Freeze the advertised idempotency replay window, compact replay response,
  current-viewer header, active-owner write fence, and deletion serialization.
- Freeze request/response fixtures, error envelopes, ETag/revision semantics,
  idempotency behavior, cursor encoding, and readiness definition.
- Produce desktop, tablet, mobile, empty, unavailable, signed-out, `409`, and
  destructive-confirmation wireframes in Finitude's design language.
- Define feature flags, telemetry categories, rate limits, and rollout owners.
- Review the contract against both Web Zod decoding and iOS Codable decoding.

**Exit gate:** one approved contract fixture set and no unresolved decision
that changes persistence, endpoint shapes, ownership, or playback activity.

### P1 — Backend metadata CRUD and ownership foundation

**Status: Complete**

**Dependencies:** P0.

**Work:**

- Add the `playlists` model, validation, stable cursor, index, and quota guard.
- Generalize transactionally atomic account mutation receipts and the P0 replay
  window.
- Implement list, create, get, rename, and delete endpoints.
- Enforce owner-only `404`, the frozen current-viewer contract, no-store
  caching, `If-Match`, ETag, revision conflicts, and replay-window idempotency.
- Add Playlist and mutation-receipt cleanup to the listener account-deletion
  transaction without adding Playlist to creator ownership checks; add the
  active-owner write fence used by every concurrent Playlist mutation.
- Keep list DTOs summary-only and detail DTOs safe even before members exist.

**Verification:** model/integration tests for auth by Bearer and Cookie, owner
isolation, name bounds, duplicate names, cursor ties, quota, replay, key reuse,
missing/stale revision, concurrent same-revision writers, private cache headers,
receipt/business-write rollback, receipt expiry, and account deletion racing
with create/rename/delete before rollback/success.

**Exit gate:** two clients cannot overwrite each other silently, another user
cannot distinguish private resource IDs from missing IDs, and empty Playlist
CRUD is production-safe behind a disabled flag.

### P2 — Membership, playback projection, and deletion lifecycle

**Status: Complete**

**Dependencies:** P1.

**Work:**

- Implement replay-safe add, exact remove, and exact-permutation reorder.
- Enforce ready Soundtrack validation, duplicate prevention, and 500-member
  limit with atomic revision updates.
- Batch-hydrate safe ordered detail DTOs with Unavailable representation.
- Expose a reusable ready-only Playlist queue projection or equivalent mapping
  used consistently by Web and future iOS.
- Extend Soundtrack deletion cleanup to pull all Playlist references and
  increment affected revisions before final metadata removal, with bounded
  resumable progress when one transaction is insufficient.
- Handle the Add/delete and cleanup/reorder races without resurrecting a
  deleted reference.
- Extend reconciliation with `danglingPlaylistItems`, missing Playlist owners,
  invalid mutation-receipt owner/targets, and stalled Soundtrack reference
  cleanup; keep audit read-only.

**Verification:** tests for pending/deleting/missing tracks, duplicate Add,
exact member removal, illegal reorder permutations, order-preserving hydration,
safe projection, unavailable skipping, partial cleanup failure, retry,
process failure after each lifecycle boundary, reconciliation, and concurrent
Add/delete plus cleanup/reorder writes, including account deletion racing with
Add/reorder.

**Exit gate:** no successful Catalog deletion can leave an unreported Playlist
reference, and no Playlist operation can delete or save Catalog content.

### P3 — Web discovery, sidebar, and Playlist CRUD

**Status: Complete**

**Dependencies:** P1 for UI scaffolding; P2 before public enablement.

**Work:**

- Add lazy `/playlists` index and `/playlists/:id` detail routes plus route
  announcements and fixed telemetry categories.
- Add desktop New Playlist and scrollable summary list below primary nav.
- Add tablet Create affordance and Library-owned tablet/mobile Playlist index.
- Preserve Library active state for Playlist routes.
- Implement signed-out, loading, empty, error, `404`, and quota states.
- Implement shared Create/Rename/Delete dialogs and summary menus.
- Wire viewer-scoped query keys, mutation receipts, revision conflicts, and
  rollback-safe optimistic cache updates.
- Confirm long sidebar lists never move or cover the fixed player.

**Verification:** component tests for shell/player count, active navigation,
focus restoration, signed-out behavior, create/rename/delete, conflict rollback,
long names, 100+ summaries, 320/768/1024/1440 layouts, and deep-link refresh.

**Exit gate:** a signed-in Web user can manage empty Playlists on every layout
without any membership UI, privacy leak, focus trap, shell shift, or initial
bundle-budget regression.

### P4 — Web composition, ordering, and playback

**Status: Complete**

**Dependencies:** P2 and P3.

**Work:**

- Add Soundtrack picker/membership status and Add-to-Playlist actions.
- Add Remove, Move Up, and Move Down; add pointer drag only if keyboard and
  touch behavior remain equivalent.
- Generalize the player launch contract for a source-tagged queue.
- Start the whole ready queue from Play or the selected row. Top-level Play
  records the first ready Soundtrack once; a row start records that row once.
  Previous, Next, and automatic advancement remain inert.
- Keep current queue immutable when Playlist data changes or disappears.
- Update counts, artwork derivation, durations, unavailable labels, control
  states, cache summaries, and Media Session metadata through existing paths.
- Keep opening a menu or picker from triggering playback or Recently Played.

**Verification:** API/component/player tests plus signed-in E2E for create →
rename → add → duplicate Add → reorder → play from middle → remove → delete.
Cover queue boundaries, unavailable members, current-source deletion, keyboard
movement announcements, and another-device `409` recovery.

**Exit gate:** Web provides the complete requested create/edit/delete feature
and ordered playback without introducing a second queue or changing Downloads.

### P5 — Hardening, observability, and Web rollout

**Status: In progress**

Local implementation, security, bundle, three-engine E2E, and automated axe
gates are complete. The integrated candidate has no current GitHub SHA or CI
artifact. Production index verification, staging load evidence, branded-
browser/manual assistive-technology checks, disabled-state deployment,
cross-account isolation smoke coverage, and rollout evidence remain external
release work.

**Dependencies:** P4.

**Work:**

- Add Chromium, Firefox, and WebKit E2E plus axe coverage for index, detail,
  picker, menus, and every dialog state.
- Verify CSRF/same-origin mutation protection, owner filtering, cache headers,
  rate/concurrency limits, bounded input, and log/telemetry redaction.
- Add fixed route/operation/status telemetry dimensions only; never send
  Playlist IDs, names, Soundtrack IDs, search text, or owner identity.
- Test 500-member hydration/reorder and maximum account list performance.
- Preserve the existing initial-route JavaScript budget through lazy chunks;
  keep sidebar summary logic small.
- Dark-deploy indexes and API with the production-default-off flag, validate
  index presence, then enable staging and the approved production environment.
  Per-account cohorts require separate traffic-routing controls; the binary
  feature flag does not select individual listeners.
- Update API/runbook/test documentation and add rollback checks.

**Exit gate:** cross-browser and accessibility matrices pass, private data is
absent from telemetry, production indexes are verified, load targets pass, and
the feature can be disabled without deleting user data.

### P6 — Future iOS adoption

**Status: Not started**

**Dependencies:** stable P5 server contract. This stage is not required for the
first Web rollout.

**Work:**

- Add shared Playlist Codable DTOs and authenticated API calls under the iOS
  Networking boundary using the frozen fixtures.
- Add Playlists beneath Library while preserving the four existing tabs and
  retained Library navigation path.
- Add create, rename, delete, add/remove, accessible move controls, empty/error,
  unavailable, and `409` refresh states with native presentation.
- Launch the ready queue through `AudioManager` and the existing playback
  activity policy; do not build a second player.
- When a member has a valid completed local Soundtrack file, allow the existing
  playback resolver to prefer it without representing the Playlist itself as a
  completed download.
- Keep Downloaded → Playlists unavailable until a separate offline Playlist
  lifecycle is designed.

**Verification:** Codable fixture tests, networking/auth/error tests, view-model
race/cancellation tests, queue/activity tests, VoiceOver/Dynamic Type UI tests,
background/system-control checks, and cross-client revision-conflict tests.

**Exit gate:** Web and iOS can alternately edit the same Playlist without lost
updates and observe the same order, availability, ownership, and deletion
semantics.

## Test matrix

| Boundary | Required coverage |
| --- | --- |
| Model | Unicode validation, limits, exact ordering, cursor stability, conditional revision writes |
| API | Bearer/Cookie auth, owner `404`, `428`, `409`, ETag, replay-window idempotency, bounded bodies, private cache |
| Lifecycle | Add/delete race, S3-delete/reference-cleanup ordering, partial failure, retry, reconciliation, account deletion transaction |
| Web schema/cache | Unknown-field stripping, viewer-scoped keys, aborts, optimistic rollback, account switch, pagination deduplication |
| Web UI | Sidebar overflow, responsive IA, dialogs/menus, keyboard reorder, empty/unavailable/quota states, fixed player |
| Playback | Ready-only order, start position, one activity event, inert navigation, immutable active queue |
| E2E | Full CRUD/member/play flow, deep links, reload, three engines, 320–1440 px, axe |
| Cross-platform | One frozen JSON fixture corpus decoded by Web and iOS; alternating revision mutations |

## Rollout and rollback

1. Ship new collection/index and disabled endpoints with no existing-data
   migration. Do not repurpose or copy `contentCollections`.
2. Verify owner index, idempotency TTL index, account deletion, and content
   reconciliation in staging and production diagnostics.
3. Keep the binary feature flag disabled during deployment, then enable it in
   staging and the approved production environment only after index and health
   verification. Use separate routing controls if a per-account cohort is
   required.
4. Monitor fixed, non-identifying rates for create, mutation conflicts,
   validation failure, hydration failure, and cleanup/reconciliation findings.
5. Expand rollout only when no private cache, authorization, dangling
   reference, or fixed-shell regression is observed.

Rollback disables new create/mutation entry points and hides the sidebar/index
while retaining the collection and read compatibility. It must never drop the
collection, erase user Playlists, or alter a currently playing queue. Backend
content cleanup and account deletion support remain enabled even while the UI
is disabled so hidden records cannot become dangling or undeletable.

## Principal risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Reusing creator collections changes ownership/account deletion | Independent `playlists` collection and owner-only routes |
| Web or iOS silently overwrites another edit | Required revision, atomic filters, `409`, refetch, replay-window idempotency |
| Private Playlist leaks through ID, cache, logs, or telemetry | Owner-scoped `404`, viewer cache keys, no-store, redacted fixed dimensions |
| Soundtrack deletion leaves or resurrects a member | Cleanup before final metadata removal, revision increment, race tests, read-only reconciliation |
| Long lists move the player or inflate the shell | Independent sidebar scroll, summary-only pagination, lazy feature chunks |
| Drag-only reorder excludes keyboard/touch users | Move Up/Down is normative; drag is optional enhancement |
| Playlist becomes an accidental download manifest | Explicit separation from Web downloads and native Downloaded Playlists |
| Large documents or abusive creation | 500-item cap, P0 account quota, bounded inputs, rate limits, load tests |

## Definition of done for the Web Playlist release

The requested Web feature is complete only when:

- an authenticated user can create, rename, populate, reorder, and delete a
  Playlist;
- the desktop sidebar presents New Playlist and a stable scrollable own-list,
  while tablet/mobile reach the same data through Library;
- another account can neither read nor infer the Playlist;
- every write is replay-safe and cannot silently overwrite a newer revision;
- Playlist playback uses one ready-only immutable queue and the documented
  Recently Played behavior;
- Playlist deletion does not unsave, delete, download, or stop its members;
- Soundtrack and account deletion complete without dangling Playlist data;
- signed-out, empty, quota, unavailable, network, and conflict states are
  intentional and accessible;
- server, Web unit/integration, three-engine E2E, accessibility, performance,
  reconciliation, and rollback checks pass; and
- frozen DTO fixtures and `/content/me/playlists` remain suitable for P6 iOS
  adoption without a server-data migration.
