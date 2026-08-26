# Explainable Discovery and Artist Follows Plan

## Status

The product and data-contract spike is **Complete** as of 2026-08-25. All
production implementation stages are **Not started**. This plan is ready for
serial contract review, but none of its recommended defaults are approved
product behavior until the coordinator promotes them into
`../business-rules.md`.

This spike intentionally does not change `../business-rules.md` or
`../product-opportunities.md`. It does not implement, enable, or deploy either
feature.

## Objective

Define the smallest complete releases for two independent listener loops:

1. an explainable, deterministic Home discovery source derived only from
   owner-scoped save/play activity and the ready public Catalog graph; and
2. private Artist Follow/Unfollow state with a ready **New from artists you
   follow** Home source.

The two loops share safe listener Catalog projections and Home composition but
do not share private state, ranking signals, feature flags, reset behavior, or
rollout authority. Following an Artist is not a discovery signal in v1.

## Scope guardrails

- Reuse the configured Carousel order on Home. Do not inject an unconfigured
  section or let a client independently choose placement.
- Keep Web streaming-only. No Web downloads or offline media lifecycle is
  added.
- Use one deterministic rules engine. Do not add machine learning, embeddings,
  opaque similarity services, popularity data, or data from other listeners.
- Keep Follow state private and owner-only. Do not expose public profiles,
  follower/following counts, email, push notifications, or public activity.
- Keep email and push out of both first releases.
- Do not add Radio, **Play similar content**, autoplay recommendations, Smart
  Shuffle, or recommendation insertion into an active queue in v1.
- Do not make Follow state a Saved Library item, Playlist member, download
  manifest, or public Artist field.
- Do not persist generated recommendation lists, impression history, read or
  unread new-release state, or per-listener analytics.

## Canonical-rule compatibility

No requested behavior requires weakening the current ready/public Catalog,
owner authorization, account-transition, Web streaming, playback, localization,
or database/S3 lifecycle rules.

The implementation does require a serial canonical-rule update before Stage 2:

- **Personalized Carousels** currently allows only `recentlySaved` and
  `recentlyPlayed`; it must add `deterministicDiscovery` and
  `followedArtistReleases`, including empty/signed-out behavior and contextual
  explanations.
- **Authentication and Resolution** must identify discovery preferences and
  Artist Follows as private owner state, define reset/account-transition
  behavior, and add both collections to listener deletion.
- **Catalog Visibility and Administration** must define Follow cleanup during
  Artist deletion and suppression cleanup during Album/MediaTrack deletion.
- **Listener telemetry** must continue to prohibit identity, content IDs,
  titles, reason source titles, and persistent visitor identifiers.

Adding an unconfigured private section would conflict with the existing rule
that Web renders administrator-configured Home sections in persisted order.
This plan avoids that conflict by extending the existing personalized Carousel
source enum. The remaining changes are contract additions, not contradictions.

## Current-state evidence

The spike was grounded at Archtree `99bf741bca67309a6060bbd54a17437ebc9a15ac`,
Finitude iOS `6d5da89d119ce61b778797d6e3e4001bcd9f0467`,
and Finitude Android `381dc0e712a91527e8ddea196db89982782932cf`.

### Archtree backend and Web

- `src/models/userLibrary.ts` stores complete saves in `userSaves` and two
  deduplicated, newest-last 20-entry arrays in `userActivity`. Save and play
  writes already use ready-content and active-account fences.
- `src/models/catalogCredit.ts` defines ordered Artist/Organization Credits,
  role allowlists, legacy migration roles, and deterministic Artist section
  precedence.
- `src/models/carousel.ts` supports `manual`, `artist`, and `personalized`
  modes. Personalized sources currently resolve only Recently Saved/Played and
  preserve mixed Album/MediaTrack order.
- `GET /api/listener/v1/home` returns flattened, allowlisted Home sections for
  Web. `GET /content/pages/home/expanded` returns page/carousel references plus
  included Catalog DTOs for native clients. Both optionally authenticate and
  already resolve viewer-specific Carousels.
- `src/services/listenerContentService.ts` and
  `src/services/publicCatalogService.ts` contain the ready/public projections
  that the new resolvers must reuse. They must not return raw MongoDB rows.
- `src/services/accountDeletionService.ts` transactionally removes named
  private collections behind the active-account fence. New collections must
  be added to that exact transaction.
- `src/services/listenerTelemetryService.ts` accepts only strict, bounded
  anonymous performance/failure events. Web sends them without cookies,
  persistence, retries, or a visitor ID.
- `src/infrastructure/database.ts` already has unique activity/save indexes and
  Credit subject/role indexes on Albums and MediaTracks. It logs and continues
  after index-creation failure, so deployment must verify new indexes rather
  than treating startup as evidence.
- Web Home uses the listener-v1 projection and account-scoped TanStack Query
  keys. Its strict capability schema means new capability fields cannot be
  appended safely for already-open old bundles.

### Finitude iOS

- iOS Home consumes `GET /content/pages/home/expanded`, not listener-v1 Home,
  and resolves mixed personalized items from `CarouselItem` references and the
  included Catalog DTOs.
- `HomePageViewModel` performs an authenticated Home load when signed in,
  treats public catalog/feed requests as optional enrichment, cancels stale
  generations, and preserves rendered Home after refresh failure.
- `LibraryAPI` already uses authenticated `/content/me/*` save/activity routes
  and publishes a personalization-change notification after Save mutations.
- Artist details exist and can host a Follow control. The shared player and
  device-local download resolver can reuse canonical IDs without making a
  recommendation or Follow state downloadable.
- Runtime localization uses the generated native `en-US` fallback and shared
  manifest contract.

### Finitude Android

- Android Home also consumes `GET /content/pages/home/expanded`, maps mixed
  personalized Carousels, starts a fresh Home load, protects against stale
  requests, and preserves rendered content after refresh failure.
- Android currently has public Home/Search/Album foundations but no complete
  authenticated owner-data layer and no Artist-details navigation destination.
  Those are explicit adoption dependencies, not backend-contract reasons to
  fork behavior.
- Localization packages the same generated `en-US` fallback/manifest contract.

### Existing tests and plans

- `test/listenerContent.integration.ts` covers both Home projections,
  personalized resolution, optional authentication, readiness, and public DTO
  allowlists.
- `test/userLibrary.integration.ts` covers mixed activity, bounded history,
  deterministic Library ordering, and pagination.
- `test/catalogCredit*.ts` covers Credit validation, role semantics, migration,
  public projection, and deletion fences.
- `test/accountLifecycle.integration.ts` covers transactional private-data
  deletion and races with other owner writes.
- `test/listenerTelemetry.test.ts` rejects identity, raw diagnostics, unknown
  fields, and unlisted operations.
- Web schema, Home, account-isolation, localization, telemetry, and three-engine
  E2E suites provide the client boundaries to extend.
- iOS `HomePageViewModelTests`, localization tests, networking tests, and UI
  scenarios cover stale loads, optional enrichment, decoding, and account
  behavior. Android `HomeMapperTest`, `HomeViewModelTest`, network model tests,
  localization tests, and device tests cover the corresponding native seams.
- Existing Playlist/download/listener plans establish the owner fence,
  private-cache, immutable queue, offline, fixture, and rollout conventions to
  reuse. They are not reopened by this work.

## Smallest complete releases

### Discovery v1

An administrator may configure one Home Carousel with personalized source
`deterministicDiscovery` and a limit from 1 through 20 (recommended 12). A
signed-in listener with eligible post-reset activity receives a mixed,
ready-only, deterministically ordered list. Every item has one concise reason.
The item menu provides **Not interested**, and Account/Privacy provides
**Reset discovery**.

If the feature is disabled, the viewer is signed out, no eligible signal exists,
or every candidate is filtered, this generated Carousel contributes no Home
item and is omitted from both Home projections. Other administrator-configured
sections remain the cold-start and signed-out experience in their original
relative order. Rollout must prove that Home has at least one ready manual or
artist source before this source is enabled.

Discovery v1 does not add a route, tab, infinite feed, Radio queue, similarity
action, or background precomputation.

### Artist Follow/new releases v1

Ready Artist details expose private Follow/Unfollow state. An administrator may
configure a separate Home Carousel with source `followedArtistReleases` and a
limit from 1 through 20 (recommended 12). It projects recent, ready Albums and
qualifying MediaTracks from canonical Credits and explains each item with one
followed Artist.

The first release has no followed-Artists index/destination, read/unread badge,
notification inbox, email, push, public profile, or follower count. A listener
can Unfollow from the Artist page reached from a release reason or normal
Catalog navigation.

## Discovery signal allowlist

Only the following owner data may affect discovery v1:

| Signal | Source | Bound | Base weight, newest position `i` | Reset behavior |
| --- | --- | ---: | ---: | --- |
| Recently Saved | `userActivity.recentlySaved` | 20 | `100 - 3i` | Ignore entries at or before `inputResetAt` |
| Recently Played | `userActivity.recentlyPlayed` | 20 | `60 - 2i` | Ignore entries at or before `inputResetAt` |

When one canonical target appears in both histories, combine its base weights
into one seed and retain both source actions for deterministic explanation
selection. The engine loads only ready seeds; deleted, malformed, pending,
failed, deleting, detached, or otherwise unavailable seeds contribute nothing.

Explicitly excluded signals are Follow state, other listeners' saves or plays,
aggregate popularity, Playlists, search queries/history, downloads, device
state, location, network address, time spent, skips, completion, queue
navigation, Feed activity, profile/account fields, email, demographics,
telemetry, and any inferred sensitive category.

## Deterministic candidate graph and ranking

### Candidate eligibility

- Candidate types are Album and MediaTrack only.
- A MediaTrack must pass the existing ready public media predicate and have its
  allowlisted listener projection.
- An Album must pass the ready Album predicate and resolve at least one ready
  canonical MediaTrack. Empty or non-playable Albums are not useful discovery
  candidates in v1.
- Candidate relationship subjects must themselves be ready/public Artists or
  Organizations. A missing subject removes that edge rather than manufacturing
  a label.
- The exact seed target, every candidate already in `userSaves`, every active
  Not-interested target, and every post-reset Recently Played target are
  excluded.
- Content deletion or an unavailable transition between ranking and projection
  causes omission. Clients never fill the hole from unvalidated local data.

### Relationship weights

For each seed/candidate pair, use only the greatest qualifying relationship
weight. Multiple shared Credits must not inflate one pair.

| Relationship | Weight |
| --- | ---: |
| Same canonical Album family | 10 |
| Shared Artist, weaker role is `primary` | 9 |
| Shared Artist, weaker role is `featured` | 7 |
| Shared Artist, weaker role is `performer` | 6 |
| Shared Artist, weaker role is `composer`, `producer`, or `remixer` | 3 |
| Shared Artist, weaker role is `legacyUnspecified` | 2 |
| Shared Organization, weaker role is `label`, `distributor`, or `presenter` | 3 |
| Shared Organization, weaker role is `publisher` | 2 |
| Shared Organization, weaker role is `legacyUnspecified` | 1 |

For role pairing, map each side to the table and use the lower role value. An
Album family is its own ID for the Album and the ready linked Album ID for a
MediaTrack. An unlinked MediaTrack uses its own ID as a singleton family.

### Score and tie-breaking

For one candidate:

1. multiply each distinct seed's combined base weight by the pair's greatest
   relationship weight;
2. sort contributions by value descending, then explanation preference below;
3. sum only the three greatest distinct-seed contributions; and
4. sort candidates by total score descending, complete release date descending
   (`year * 10000 + month * 100 + day`, missing components sort as zero), Album
   before MediaTrack, then lowercase canonical content ID ascending.

The final ID tie-breaker is normative. Do not use database natural order,
request order, localized title collation, random numbers, or current wall-clock
time in discovery ranking.

The implementation may evaluate at most 2,000 related ready Albums and 2,000
related ready MediaTracks per request. If either graph exceeds that safety
bound, preselect within each relationship-weight bucket by complete release
date descending, content ID ascending, emit only an anonymous truncation
counter, and apply the same scoring. Load testing must justify a different
bound before changing it.

### Diversity and repetition

After ranking, fill the configured limit in two passes:

1. permit at most one item per Album family, at most two items per highest-
   scoring relationship subject/family, and at most `ceil(limit * 2 / 3)` items
   of one content type;
2. if capacity remains, relax only the content-type cap. Keep family and
   relationship-key caps.

Do not backfill with unrelated content. With identical Catalog, activity,
preferences, and readiness state, repeated requests return identical items,
order, and reasons. Finitude records no impression solely to rotate results.
Saving, playing, suppressing, resetting, or a Catalog/readiness change is what
changes the result.

## Concise explanation contract

The greatest single seed contribution determines the reason. Ties use base
weight descending, Recently Saved before Recently Played, Album before
MediaTrack, then seed ID ascending.

```ts
type PersonalizationReasonV1 =
  | {
      code: 'becauseRecentlySaved' | 'becauseRecentlyPlayed';
      source: {
        contentType: 'album' | 'audioTrack';
        contentId: string;
        title: string;
      };
    }
  | {
      code: 'followedArtist';
      artist: {
        id: string;
        name: string;
      };
    };
```

The server sends structured reason data, not English sentences. Clients render
localized complete messages such as **Because you saved {title}**. If the
allowlisted source title is empty, the client uses its localized Album or
MediaTrack fallback name. Raw score, weights, alternate seeds, ownership data,
and internal lifecycle fields are never returned.

## Discovery preferences, Not interested, and reset

### `userDiscoveryPreferences` collection

```ts
interface UserDiscoveryPreferencesDocument {
  _id: ObjectId;
  userId: string;
  inputResetAt: Date | null;
  suppressions: Array<{
    contentType: 'album' | 'audioTrack';
    contentId: string;
    suppressedAt: Date;
    expiresAt: Date;
  }>;
  revision: number;
  updatedAt: Date;
}
```

Required index: unique `{ userId: 1 }`.

- **Not interested** is an idempotent exact-target preference. It does not
  infer dislike of an Album family, Artist, Organization, role, genre, or other
  listener. A repeated request preserves the first active suppression's
  expiry.
- Active suppressions last 180 days. Expired entries are pruned on every read
  and write. One account retains at most 500 active entries; adding the 501st
  removes the oldest `suppressedAt`, then content ID, deterministically.
- **Reset discovery** clears suppressions and sets `inputResetAt` to the
  server-owned current time. It does not unsave content, clear visible
  Recently Saved/Played histories, unfollow Artists, mutate Playlists, delete
  downloads, or alter the active queue. Pre-reset activity remains in its
  existing product history but is no longer a discovery input.
- Reset requires an `Idempotency-Key` and reuses the existing 24-hour
  account-mutation receipt pattern so a lost response cannot create a later
  unintended reset timestamp.
- Preference writes transact with the active-account fence. Account deletion
  removes preferences and reset receipts in the same listener-deletion
  transaction.
- Album/MediaTrack final deletion removes exact suppression references
  idempotently before final metadata removal. Reads also omit dangling targets
  defensively.

## Artist Follow persistence and mutations

### `artistFollows` collection

```ts
interface ArtistFollowDocument {
  _id: ObjectId;
  userId: string;
  artistId: string;
  followedAt: Date;
  updatedAt: Date;
}
```

Required indexes:

```ts
{ userId: 1, artistId: 1 } // unique
{ userId: 1, followedAt: -1, _id: -1 }
{ artistId: 1, userId: 1 }
```

- Follow validates and conditionally touches a still-ready Artist in the same
  transaction that touches the active account and upserts the relationship.
- Repeated Follow preserves the original `followedAt`; repeated Unfollow
  returns the same confirmed false state. No Idempotency-Key is required for
  these naturally idempotent PUT/DELETE operations.
- Concurrent opposite mutations are ordered by database commit. Clients apply
  only the newest local request generation and then trust/refetch the
  server-confirmed state; a late response cannot overwrite a newer local
  action.
- Unfollow remains possible by canonical ID while an Artist is unavailable.
  Follow of an unavailable/deleting Artist returns owner-safe `404`.
- Artist deletion blocks new Follow writes, removes every Follow relationship
  before final Artist metadata deletion, and retains lifecycle evidence on
  partial failure. Artist artwork/S3 lifecycle remains independent.
- Account deletion removes all Follow rows transactionally. Follow ownership
  never triggers the shared-Catalog provenance deletion block.

## Ready followed-Artist releases

The resolver uses Follow rows only; it never reads saves, play activity,
discovery preferences, or other listeners.

- A release needs a complete valid `releaseDate` (`year`, `month`, and `day`).
  Interpret it as a UTC calendar date for eligibility, not as an upload or
  publication timestamp.
- Include dates from today through 89 calendar days before today. Future and
  partial dates are excluded until representable by this contract.
- An Album qualifies when it is ready, has at least one ready canonical
  MediaTrack, and has a canonical Artist Credit for a followed Artist with role
  `primary` or `featured`.
- A MediaTrack qualifies when it is ready and its own canonical Artist Credit
  for a followed Artist has role `primary`, `featured`, or `performer`.
  `legacyUnspecified`, composer, producer, and remixer Credits do not create a
  new-release entry in v1.
- When a qualifying ready Album exists for a qualifying linked MediaTrack, the
  Album represents that family and the linked MediaTrack is omitted. If the
  Album does not independently qualify, the qualifying MediaTrack remains.
- Sort by complete release date descending, Album before MediaTrack, then
  lowercase canonical ID ascending. Do not sort by follow time, popularity,
  upload time, or database order.
- If multiple followed Artists qualify one returned item, select the reason by
  role precedence `primary > featured > performer`, then Credit order, then
  Artist ID. Return only a ready/public Artist ID and name.
- Following an Artist immediately makes all qualifying releases in the 90-day
  window eligible. There is no follow-time cutoff, read/unread state, or
  persisted release feed.

## Home composition and DTO changes

Extend `PersonalizedCarouselConfig.source` to:

```ts
type PersonalizedCarouselSource =
  | 'recentlySaved'
  | 'recentlyPlayed'
  | 'deterministicDiscovery'
  | 'followedArtistReleases';
```

Keep the existing configured name and 1–20 limit. Do not add manual items,
client-controlled sorting, or a fallback Carousel reference.

For the legacy expanded Home response, add optional
`PersonalizationReasonV1` to each resolved `page.items[].carousel.items[]`
reference. Included Albums/MediaTracks remain the existing allowlisted DTOs.

For listener-v1 Home, add the same optional reason to each contextual item in
`sections[].items[]`. A content summary outside Home does not gain a reason.
Both projections must resolve the same ordered IDs and reason objects from one
service call and shared fixture.

Generated sources with zero items are omitted from both Home projections;
remaining configured sections preserve their relative persisted order. Existing
Recently Saved/Played behavior is unchanged.

Both existing Home DTOs are consumed by released strict clients. A client that
supports this contract sends `X-Finitude-Personalization-Version: 1` on its Home
request. Missing, malformed, or unsupported versions resolve the two new
sources as empty/omitted while leaving existing Home sources unchanged. This
header selects a response shape only; it is not authentication or authorization.
It prevents an old Web bundle from rejecting an unknown strict field and keeps
old native clients from showing recommendations without explanations or
controls. Each client can therefore adopt independently without forking the
configured Home page.

Add a separate backward-compatible capability endpoint rather than appending
unknown fields to the current strict capability response:

```http
GET /api/listener/v1/personalization-capabilities

200 {
  "contractVersion": 1,
  "deterministicDiscovery": false,
  "artistFollows": false
}
```

It is public, `no-store`, contains no account state, and reflects two
independent production-default-off flags:
`FINITUDE_DETERMINISTIC_DISCOVERY_ENABLED` and
`FINITUDE_ARTIST_FOLLOWS_ENABLED`.

## Private HTTP API

Every route below requires authentication and the existing current-account
viewer guard. Cookie Web requests send `X-Finitude-Account-Viewer`; native
Bearer requests remain token-bound. Responses are `Cache-Control: private,
no-store`, `Pragma: no-cache`, and vary by Cookie and Authorization.

| Method and path | Purpose | Success contract |
| --- | --- | --- |
| `PUT /content/me/discovery/not-interested/:contentType/:contentId` | Suppress one exact recommended Album/MediaTrack | `200` target, `notInterested: true`, expiry, revision |
| `POST /content/me/discovery/reset` | Reset discovery inputs and suppressions | `200` server `resetAt`, revision; requires `Idempotency-Key` |
| `POST /content/me/artist-follows/status` | Read at most 100 Artist states in request order | `200` strict `{ items: ArtistFollowStatusV1[] }` |
| `PUT /content/me/artist-follows/:artistId` | Follow one ready Artist | `200` confirmed status |
| `DELETE /content/me/artist-follows/:artistId` | Unfollow idempotently | `200` confirmed status |

```ts
interface ArtistFollowStatusV1 {
  artistId: string;
  following: boolean;
  followedAt: string | null;
}
```

Malformed IDs/types return `400`; Follow of a missing/unavailable Artist
returns `404`; missing/mismatched identity returns the current `401`/fail-closed
viewer response; disabled mutations return stable `503` codes without deleting
stored state. No route returns `userId`, email, counts, or another account's
relationship.

Home remains the only release/discovery read API in v1. Do not add redundant
private feed endpoints until a destination or pagination contract is approved.

## Client behavior and account transitions

- Show Follow with disabled styling while signed out. Activation reports that
  sign-in is required and does not automatically open login, matching Save.
- Follow/Unfollow and Not interested remain pending until the server confirms.
  Failure preserves the last confirmed UI state and offers retry.
- On successful Follow/Unfollow, Not interested, Reset, Save/Unsave, or
  Recently Played mutation, invalidate the current account's Home projection.
  Do not invalidate another account's cache.
- Logout, logout-all, account deletion, identity mismatch, and account switch
  immediately hide and clear the prior account's Follow statuses, reasons,
  generated sections, pending controls, and private query cache. A late response
  is rejected by account epoch/generation.
- Signed-out Home never displays a generated private source or a prior
  account's reason. Already-playing public content continues under existing
  rules.
- Not interested belongs only in `deterministicDiscovery` cards' accessible
  contextual menu. It is not shown on followed-release cards because that loop's
  control is Unfollow. Reset discovery belongs in Account/Privacy with
  plain-language scope and a server-confirmed success announcement.
- A new-release reason links to the referenced ready Artist. A discovery reason
  is explanatory text, not a public deep link to private activity.

## Offline behavior

- Web persists no private discovery, Follow, or new-release snapshot in
  `localStorage`, IndexedDB, or a service worker. Already-rendered in-memory
  Home may remain during a refresh failure; a cold offline load shows the
  existing recoverable Home state.
- iOS and Android v1 do not create a durable private recommendation or Follow
  cache. They preserve already-rendered in-process Home on refresh failure and
  show the last confirmed in-process Follow state as unavailable for mutation.
- Follow/Unfollow, Not interested, and Reset never queue offline. The listener
  retries explicitly after connectivity/authentication returns.
- If an already-rendered MediaTrack has a valid completed native Audio download,
  the existing playback resolver may use it by canonical ID. This does not make
  the discovery section, Follow state, Video, or Web content offline-capable.
- Account exit clears all in-process private state. Device-owned completed
  downloads remain governed by the existing independent offline contract.

## Retention and deletion

| Data | Retention | Explicit control | Account/content deletion |
| --- | --- | --- | --- |
| Generated recommendations | Not persisted | Recompute | Nothing to delete |
| Existing Recent histories | Existing 20-entry bounds | Existing clear listening history plus discovery reset cutoff | Existing account/content cleanup |
| Discovery reset cutoff | Account lifetime | Reset replaces with newer cutoff | Delete with account |
| Not-interested entries | 180 days, max 500 | Reset all | Delete with account; pull exact deleted content |
| Artist Follows | Until Unfollow | Follow/Unfollow | Delete with account or final Artist cleanup |
| New-release projection/read state | Not persisted | Follow/Unfollow changes projection | Nothing beyond Follow rows |
| Anonymous operational counters | Aggregate service retention only | Not user-addressable | No identity or content key exists |

No S3 object is owned by preferences or Follows. Their create/update/delete
lifecycle is MongoDB-only but still must be fenced, retry-safe, and fully
covered for partial transaction outcomes.

## Privacy-safe metrics and logging

Keep existing listener telemetry strict. Extend only its fixed `api_error`
operation enum for discovery preference, Follow status/mutation, and Home
personalization failures. Do not add a general event name, arbitrary context,
or interaction payload.

Server-owned aggregate counters may contain only:

- feature (`discovery` or `artist_follows`);
- operation from a fixed allowlist;
- outcome (`success`, `disabled`, `cold_start`, `empty_after_filter`,
  `validation`, `conflict`, `unavailable`, `failure`);
- latency bucket;
- candidate-count or returned-item-count bucket; and
- candidate-pool-truncated boolean.

They must not contain user/session/account ID, content/Artist ID, title, reason
source, Credit subject, release date, IP/network address, User-Agent,
fingerprint, search term, URL/query string, exception text/stack, or persistent
visitor ID. Do not emit per-item impression/open/play events in v1. Endpoint
request bodies and paths containing IDs must not be copied into logs.

## Localization and accessibility

- Add semantic source keys only in `localization/catalog.json` and canonical
  `localization/locales/*.json`, then generate and sync native outputs.
- Include complete messages for Because Saved/Played, Follow/Following,
  sign-in required, new releases, Not interested, reset scope/pending/success/
  failure, unavailable/retry, and accessibility announcements. Do not
  concatenate reason fragments.
- Catalog titles and Artist names remain catalog metadata and are inserted as
  named variables; they are not translated by runtime UI localization.
- Every Follow control exposes its state and pending state to assistive
  technology. Not interested has an accessible target name. Removing a card
  and resetting discovery announce the confirmed result without moving focus
  unpredictably.
- Verify Dynamic Type/font scaling, VoiceOver/TalkBack, keyboard focus,
  reduced motion, contrast, and right-to-left message layout.

## Cross-platform fixture contract

Stage 1 creates synthetic canonical fixtures under
`test/fixtures/personalization/v1/` and byte-identical checked-in copies for
iOS tests under `Finitude_iOSTests/Fixtures/Personalization/v1/` and Android
tests under `app/src/test/resources/personalization/v1/`. A manifest records
SHA-256 for every JSON file; a small sync/check script is added with the fixture
implementation rather than being claimed as an existing command.

Required fixtures:

1. `discovery-ranking.json`: ready/unavailable Catalog graph, both activity
   sources, reset cutoff, saves, suppressions, equal scores, partial dates,
   broad-subject truncation input, expected scores, IDs, order, diversity, and
   reason selection.
2. `listener-home.json`: listener-v1 sections with strict contextual reasons,
   cold start, disabled sources, and no internal fields.
3. `expanded-home.json`: the identical IDs/reasons in native expanded-page
   shape with included content.
4. `artist-follow-status.json`: followed/unfollowed/missing state, strict field
   rejection, and response ordering.
5. `followed-artist-releases.json`: date boundary, future/partial date,
   qualifying/nonqualifying Credit roles, Album-family deduplication,
   unavailable content, multi-Artist reason choice, and deterministic ties.

Web Zod, Swift Codable, and Kotlin/Gson tests must decode the same semantic
contract. Ranking implementations must compare exact expected IDs/reasons, not
only item counts.

## Staged implementation plan

### Stage 0 — Product/data-contract spike

**Status: Complete**

- Read repository guidance and the complete canonical business rules.
- Inventory Catalog/Credits, saves/activity, Home projections, deletion,
  telemetry, localization, all three clients, tests, commands, and plans.
- Define independent v1 scopes, exact ranking/defaults, private persistence,
  lifecycle, DTOs, APIs, fixtures, rollout, and skipped decisions.
- Leave production behavior and shared contract documents unchanged.

### Stage 1 — Serial contract promotion and frozen fixtures

**Status: Not started**

**Dependencies:** coordinator review of every Skipped decision.

- Promote approved behavior into `business-rules.md`; update the candidate
  disposition in `product-opportunities.md` only if the coordinator wants the
  backlog to reflect approval.
- Freeze source enums, reason DTO, weights, tie-breakers, dates, retention,
  API responses/errors, account/offline behavior, and feature flags.
- Add the canonical fixture corpus, client copies, manifest, and sync/check
  script.
- Update API/localization/testing documentation for approved contracts.

**Exit gate:** canonical rules and all fixture copies agree before persistence
or client UI work begins.

### Stage 2 — Backend private-state and lifecycle foundation

**Status: Not started**

**Dependencies:** Stage 1; Mongo replica-set transactions; Catalog Credit reads
and public Organization/Artist readiness contracts.

- Add production-default-off independent feature services and the separate
  personalization-capabilities route.
- Add `userDiscoveryPreferences` and `artistFollows` models, validated strict
  controllers, owner/current-viewer guards, indexes, and bounded inputs.
- Extend account deletion, Album/MediaTrack cleanup, Artist deletion, active-
  account/ready-Artist races, and reconciliation reporting.
- Add reset idempotency receipts without logging request data.
- Dark-deploy indexes and verify exact production index definitions before any
  feature flag is enabled.

**Exit gate:** private rows cannot leak, outlive an account, block account
deletion, survive final target deletion, or race into dangling state.

### Stage 3 — Deterministic discovery resolver and Home projection

**Status: Not started**

**Dependencies:** Stage 2 and approved discovery fixture.

- Extend the personalized source enum/parser/Content Manager UI with
  `deterministicDiscovery` and the existing 1–20 limit.
- Implement one pure ranking core plus bounded Mongo loaders and safe listener
  projection; keep weights and ordering fixture-visible.
- Resolve identical IDs/reasons through listener-v1 and expanded Home, omit an
  empty generated source, and preserve remaining configured order.
- Add Not interested and reset invalidation behavior.
- Add aggregate bounded diagnostics and truncation/load evidence.

**Exit gate:** all deterministic, readiness, diversity, cold-start, control,
projection, lifecycle, and fixture tests pass with the feature disabled by
default.

### Stage 4 — Artist Follow and ready new-release resolver

**Status: Not started**

**Dependencies:** Stage 2, canonical Credit reads, and approved release-date
fixture. Independent of Stage 3 implementation.

- Implement Follow status/PUT/DELETE, server-confirmed multi-client behavior,
  and Home invalidation.
- Extend the personalized source parser/Content Manager UI with
  `followedArtistReleases`.
- Implement exact release-date, Credit-role, readiness, family deduplication,
  reason, and tie-break rules in one shared resolver.
- Project the same ordered output through both Home contracts.

**Exit gate:** Follow privacy/mutation/deletion and new-release fixtures pass;
no discovery state influences the result.

### Stage 5 — Finitude Web adoption

**Status: Not started**

**Dependencies:** stable disabled Stage 3 and/or Stage 4 server contract. Either
feature may ship independently.

- Extend strict Home schemas with contextual reasons and add strict private
  mutation/status clients with account-scoped keys and abort handling.
- Send personalization response version 1 on Home; prove a request without the
  header still decodes under the previous strict schema.
- Add explained card copy/menu, server-confirmed Not interested, Account/
  Privacy reset, and Artist Follow UI.
- Fence every request to the displayed account, clear old private cache before
  transition resolution, and reject stale responses.
- Extend only fixed API-error telemetry operations; do not persist private
  Home data offline.
- Add component, schema, account-isolation, accessibility, responsive, and
  three-engine E2E coverage.

**Exit gate:** Web can use either flag without private-cache, configured-order,
fixed-player, accessibility, or localization regressions.

### Stage 6 — Finitude iOS adoption

**Status: Not started**

**Dependencies:** stable server fixtures and iOS authenticated account state.

- Add reason/follow DTOs and fixture tests under Networking; retain the legacy
  expanded Home endpoint until a separately approved migration.
- Send personalization response version 1 only after the client can render the
  explanations and complete controls.
- Preserve Home stale-request and optional-enrichment behavior while rendering
  explanations and pending controls.
- Add Follow to Artist details and Reset to Account/Privacy.
- Reuse `AudioManager`, activity policy, and canonical-ID local Audio resolver;
  create no second player or recommendation queue.
- Clear account-scoped in-process state on logout/switch/deletion and reject
  stale authenticated responses.

**Exit gate:** unit/UI/VoiceOver/Dynamic Type/background playback and physical-
device account-transition checks pass.

### Stage 7 — Finitude Android parity

**Status: Not started**

**Dependencies:** stable server/iOS contract plus Android authenticated owner-
data foundation and Artist-details navigation.

- Add authenticated current-account transport, reason/follow DTOs, fixture
  tests, and account-epoch cancellation.
- Send personalization response version 1 only after the complete Home
  explanation/control contract is present.
- Add an Artist-details destination before exposing Follow; do not put an
  unactionable Follow state only on Search rows.
- Render the same Home reasons/controls, reset behavior, readiness, and offline
  limitations as iOS.
- Reuse the app-owned Media3 queue and valid local Audio resolver.

**Exit gate:** Kotlin unit, lint/build, Compose device, TalkBack/font scaling,
account-transition, and cross-platform fixture gates pass.

### Stage 8 — Staged rollout, observation, and rollback proof

**Status: Not started**

**Dependencies:** relevant client stage and all lifecycle/index gates.

- Deploy backend/index/cleanup support with both flags off. Verify exact
  artifact identity, indexes, health, account deletion, Artist/content cleanup,
  and reconciliation.
- Configure synthetic/staging Home sources and prove a non-personalized curated
  fallback exists.
- Verify versionless Home requests omit the two new sources before testing a
  version-1 Web or native request.
- Enable deterministic discovery in staging, then approved production; observe
  bounded outcome/latency/count buckets and stop on privacy, readiness,
  truncation, or deterministic-fixture drift.
- Promote Artist Follows separately after its mutation/deletion matrix passes.
  Do not make one flag or rollout cohort depend on the other.
- Rehearse rollback by disabling resolution/UI while retaining private rows,
  cleanup, account deletion, and safe disabled mutations.

**Exit gate:** both loops have independent enable/disable proof, retained data
is still deletable while hidden, and production behavior matches the exact
tested artifact.

## Test matrix

| Boundary | Required coverage |
| --- | --- |
| Ranking unit | Every weight, merged seed, top-three cap, exact tie, ID order, family/type/subject diversity, repetition, candidate bound |
| Discovery persistence | Unique account row, idempotent suppression, expiry/prune, 500 cap, reset receipt replay/conflict, input cutoff |
| Follow persistence | Unique pair, idempotent Follow/Unfollow, opposite races, original `followedAt`, unavailable Artist |
| Release resolver | UTC 90-day boundary, leap date, future/partial dates, roles, family dedupe, multi-Artist reason, stable ties |
| Readiness | Pending/failed/deleting/missing Album, MediaTrack, Artist, Organization and a transition between rank/projection |
| Authorization/API | Bearer/Cookie, current viewer, another account, malformed/bounded bodies, strict DTOs, private caching, disabled flags |
| Lifecycle integration | Account/reset/follow races, account deletion, Album/MediaTrack suppression cleanup, Artist Follow cleanup, partial retry/reconciliation |
| Home projections | Same IDs/reasons in version-1 listener-v1 and expanded Home, versionless compatibility, configured relative order, empty omission, signed-out/cold start |
| Web | Strict Zod, query isolation, stale response, controls, localization, keyboard/axe, responsive UI, fixed player, three engines |
| iOS | Codable fixture, request/auth errors, generations/cancellation, offline state, VoiceOver/Dynamic Type, shared player/local Audio |
| Android | Gson fixture, authenticated transport, generations, HomeMapper, Artist route, TalkBack/font scaling, Media3/local Audio |
| Privacy | Reject unknown/identity/content/title fields in telemetry; assert logs/counters contain only bounded dimensions |
| Performance | 40 seeds, 4,000-candidate safety bound, 20-item projection, index explain plans, timeout/fallback behavior |
| Rollout | Flags off/on independently, stored-state retention, cleanup while hidden, index verification, rollback artifact |

## Verified current commands

These commands exist in the current repositories. Proposed fixture commands do
not count as available until Stage 1 adds them.

### Archtree

```sh
npm run localization:check
npm run localization:generate
npm run localization:sync-native
npm test
npm run build
npm run test:integration
npm run test:e2e
npm run test:e2e:chromium
git diff --check
```

### Finitude iOS

```sh
./scripts/check-quality.sh
./scripts/test-ios.sh
```

### Finitude Android

```sh
./gradlew testDebugUnitTest lintDebug assembleDebug
./gradlew connectedDebugAndroidTest
```

Run native commands from their repository roots. The iOS test runner selects
an available iPhone simulator. Android device tests require a connected
emulator/device; use the repository-supported JBR 21 when the default JDK is
incompatible with Gradle 8.13.

## Dependencies and sequencing constraints

- The coordinator must approve and serialize canonical-rule changes before
  production code.
- Catalog Credit reads and ready Artist/Organization projections are the only
  relationship source; do not build on legacy flattened names.
- Mongo replica-set transactions and explicit production index verification
  are required for account/target race safety.
- Both Home projections must remain live until iOS and Android intentionally
  migrate to one contract.
- Every new listener string must pass canonical localization generation and
  native sync before client release.
- Android Follow UI depends on authenticated owner APIs and Artist-details
  navigation that are not currently complete.
- P0/release work tracked elsewhere remains independent; this plan does not
  authorize deploying an unclosed integrated candidate.

## Skipped decisions requiring product acceptance

The spike records recommended defaults and deliberately did not ask the user
to accept them. Each row is **Skipped** until the coordinator approves or
replaces it during Stage 1.

| Status | Decision | Recommended default | Why |
| --- | --- | --- | --- |
| Skipped | Discovery first-release surface | One configured Home Carousel; no Radio/route | Smallest useful loop using existing composition |
| Skipped | Discovery weights and caps | Exact tables above; top three seeds; 12 recommended items | Deterministic, bounded, fixture-testable |
| Skipped | Not-interested scope | Exact item only | Avoid inferring dislike of Artist/family |
| Skipped | Suppression retention | 180 days, max 500 | Bounded control without permanent inferred preference |
| Skipped | Reset meaning | Ignore earlier discovery inputs and clear suppressions; preserve product histories | Gives a real reset without unsaving/deleting history |
| Skipped | Generated empty source | Omit it; retain configured curated sections | Safe cold start and signed-out behavior |
| Skipped | New-release window | Inclusive 90 UTC calendar days | Useful bounded recency with existing date model |
| Skipped | Partial/future dates | Exclude until a complete eligible date | Avoid inventing release time |
| Skipped | Qualifying Follow roles | Album primary/featured; MediaTrack primary/featured/performer | Release-bearing roles without ambiguous legacy inference |
| Skipped | Follow retroactivity | Show the whole current 90-day window after Follow | No read-state/follow-time persistence needed |
| Skipped | Native durable cache | None in v1; preserve in-process rendered state only | Minimizes private offline/account-transition risk |
| Skipped | Promotion order | Discovery backend/Web, then iOS, then Android; Follow separately after its backend/Web loop | Respects current client readiness and keeps rollback independent |

## Recommended promotion order

1. Approve shared rules, DTOs, fixtures, retention, and privacy boundaries.
2. Dark-deploy both private-state/lifecycle foundations and verify indexes with
   both flags off.
3. Promote deterministic discovery resolver plus Web UI first; validate
   deterministic fixtures, cold starts, controls, and privacy in staging.
4. Adopt the same frozen discovery contract on iOS, then Android after its
   authenticated foundation is ready. Versionless clients continue to omit the
   generated source.
5. Promote Follow/status and followed-release resolver as a separate backend
   loop; add Web Artist Follow and staging Home source.
6. Adopt Follow on iOS; adopt Android only with its Artist-details destination
   and authenticated account-transition safeguards.
7. Expand either production flag independently after its observation window.

Stages 3 and 4 may be implemented in parallel after Stage 2, but their shared
contract edits, Home DTO fixture changes, localization generation, and final
promotion must be integrated serially.

## Definition of done

Discovery v1 is complete only when the same ready Catalog/activity fixture
produces the exact same mixed IDs, order, reasons, diversity, controls, and
cold-start behavior across Archtree, Web, iOS, and Android; Not interested and
Reset are server-confirmed, private, retained/deleted as documented; and the
feature can be hidden without losing cleanup or account deletion.

Artist Follow/new releases v1 is complete only when Follow/Unfollow is private,
idempotent, race-safe, and account/Artist-deletion-safe; only qualifying ready
Credits and complete dates appear; Web/iOS/Android decode the same ordered
fixture; no public profile/count/email/push state exists; and its independent
flag can roll back without deleting Follow rows or weakening cleanup.

After every approved implementation stage and its required verification are
complete, update statuses. Delete this dedicated plan only after both loops,
all client adoptions selected for the approved release, and rollout/rollback
evidence are complete.
