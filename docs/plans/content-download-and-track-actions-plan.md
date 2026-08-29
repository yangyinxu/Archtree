# Content Downloads, Track Actions, and Collection Page Items Plan

## Status

In progress. This document is implementation guidance, not the canonical product
contract. Keep its agreed behavior synchronized with `../business-rules.md` in
the same change whenever implementation feedback changes product behavior.

Implemented in the first slice:

- authenticated validator-aware `HEAD`/`GET` soundtrack download endpoints;
- reusable manual/dynamic Grid and List definitions, page attachment, manual
  mutation rules, and expanded-page decoding alongside Carousel;
- a device-owned iOS manifest with app-owned resumable partial files, startup
  reconciliation, logout pausing, Settings management, and local playback;
- unified Saved + Downloaded Library rendering and download progress/warning
  overlays.

Implemented in the server-pagination slice:

- persisted, order-independent identities for newly written Page items, with a
  definition-ID compatibility identity for unique legacy references;
- `GET /api/listener/v1/pages/:slug/items/:itemId` for bounded manual Grid/List
  traversal with ready-only allowlisted DTOs and deterministic ordering;
- opaque cursors bound to the viewer for Library plus Page, Page-item, and
  collection snapshots, including explicit malformed, cross-scope, and stale
  failures;
- explicit rejection of device-local Downloaded sources on the server surface.

Implemented in the Web-adoption slice:

- strict client decoding and cursor traversal for attached manual Grid/List
  items, with Home viewer scoping and authenticated Library request support;
- explicit first-page, next-page, and stale-cursor recovery states without
  adding any Web download or offline behavior.

Implemented in the native-adoption and reliability slices:

- iOS and Android Home consume independently paged server Grid/List items with
  strict metadata, viewer/account, cursor, overlap, and request-ownership
  fencing while preserving Carousel compatibility;
- iOS track-row actions, bounded Album orchestration, shared-asset ownership,
  offline playback, unified Saved + Downloaded Library, Settings management,
  and a versioned manifest are implemented;
- iOS device-local queries use a rebuildable SQLite index with keyset
  pagination, content-addressed metadata snapshots, revision fencing, explicit
  retry, and future-schema fail-closed behavior.

System-restored background `URLSession` execution, physical-device lifecycle
evidence, complete Content Manager preview/draft/publish workflows, and safe
destructive collection-member editing remain. Compatibility parent responses
continue to retain their existing manual collection payloads for older clients.

## Objective

Restore download functionality on the iOS content-details page and replace the
per-track Save control with an extensible ellipsis menu. Support downloading a
single soundtrack and downloading an entire album when the complete album
track list has been loaded. Expand page composition from Carousel-only items to
explicit Carousel, Grid, and List page-item types for online and local
collections.

This plan applies to the Finitude iOS client and the Archtree audio delivery
API. It does not add a live, user-editable playback queue.

## Current state

- `ContentDetails` loads the canonical Album track list, preserves the shared
  player queue, exposes track actions, and coordinates bounded Album downloads.
- The iOS download store persists device-owned intent and shared Audio assets,
  validates resumable Range responses, reconciles startup state, and serves
  bounded Library/Home pages from its SQLite projection.
- Archtree exposes authenticated validator-aware Audio downloads separately
  from the existing streaming response.
- There are no implemented “Play next,” “Add to queue,” Up Next, or queue
  editing actions; those remain intentionally out of scope.

## Agreed product behavior

The following agreed rules are also recorded in
`../business-rules.md`:

1. Starting or resuming a download requires authentication. Signed-out users
   may browse and play available streams, but Download prompts for sign-in.
2. Completed downloads, metadata, and incomplete transfer state belong to the
   device, not an account. They remain visible and manageable after logout or
   account switching, and valid completed downloads remain playable offline.
3. A track is downloadable only when its stream is available and the download
   has not already completed.
4. Every manifest retains a canonical content ID. Album manifests retain the
   album ID and each component soundtrack ID. An entry missing a required ID is
   corrupted and non-playable because it cannot be reconciled or retried safely.
5. Missing non-identity metadata does not block playback when the local audio
   file and required IDs are valid. Render all available fields, use fallback
   text for missing titles or durations, and show an incomplete-metadata warning.
6. Packshot artwork is non-critical. Use cached soundtrack artwork, inherited
   album artwork, or the packaged placeholder; missing artwork never blocks
   playback.
7. Selecting an entry with a missing required ID explains the corruption and
   offers confirmed deletion. Entries with a valid ID may offer authenticated
   Retry to repair their audio, metadata, or artwork.
8. In-progress downloads remain recoverable and visible. Each affected item in
   a Carousel, Grid, or List shows progress on its packshot image and is not
   presented as completed.
9. Logout durably pauses active transfers by ending authenticated tasks while
   preserving validated partial files, validators, and resume state. Late
   callbacks cannot complete paused entries. Resuming creates a newly
   authenticated request.
10. The Library has additive Albums and Songs content filters plus a Downloads
    availability filter. The Library remains one vertically scrolling dynamic
    list; it does not expose unavailable Artists or Playlists filters.
11. “Download album” is available only when the complete album track list has
    loaded and all required tracks are known. Partial album data must not be
    presented as a complete album download.
12. Album downloads report per-track progress and retain recoverable state when
    one or more tracks fail. Retrying failed tracks must not redownload tracks
    that already completed.
13. Downloading an album creates one album entry in Downloaded. Its component
    soundtracks are not also shown as standalone List entries unless the user
    downloaded those soundtracks independently.
14. Removing a local download does not unsave the track or album, and unsaving
    content does not delete its local download.
15. A local audio asset may be owned by more than one device-local download
    entry. Removing an album download must not delete a soundtrack file still
    owned by a standalone soundtrack download or another local collection.
16. Server-backed Grid and List page items use cursor pagination and
    deterministic server ordering. Device-local Downloaded sources paginate
    over the local store and never contact the server for another local page.
17. Settings provides a Downloads page to cancel paused downloads, delete
    individual items, and clear all downloads from the device regardless of
    authentication state. Future management may add album- and artist-scoped
    filters and bulk deletion.

The first release should offer only Save to Library and Download in the track
actions menu. Share can be added if its product behavior is already defined.
Play next, Add to queue, and other YouTube Music-style queue actions remain
out of scope until a live queue feature is designed and implemented.

## Proposed user experience

### Album details

- Keep the existing prominent Play button.
- Add an album-level Download action near Play or in the album toolbar.
- Show the action only after the complete album list has loaded. While loading,
  show progress or a disabled state; if the album is incomplete, do not imply
  that all tracks will be downloaded.
- Present album progress with completed, active, and failed track counts.
- When all tracks are downloaded, show a completed state on the primary action
  and place the destructive “Remove downloads” action in the album menu.

### Track rows

- Remove the always-visible Save button from each track row.
- Add a trailing ellipsis button with an accessibility label such as “More
  actions for <track title>”.
- Present a bottom sheet/action sheet titled “Track actions”. Initial actions:
  - Save to Library or Remove from Library, reflecting current saved state.
  - Download, Downloading, Downloaded, or Remove download, reflecting local
    state.
- Preserve the existing signed-out Save behavior: the action remains visible,
  but tapping it reports that sign-in is required and does not silently mutate
  state.
- Keep track playback as the primary row action; opening the menu must not
  start playback or record Recently Played activity.

### Offline Library and downloaded content

- Library always includes device-local downloads in its unified Saved +
  Downloaded union, including while signed out or when the server is
  unreachable. Show a compact local empty state when the device has no saved
  or downloaded content.
- Local entries use the same cached server-shaped album and soundtrack objects
  as the online UI. Preserve the original versioned JSON response snapshots
  and maintain a small local index for content type, content ID, status,
  ordering, metadata validity, and transfer progress. Do not reconstruct
  display records from filenames.
- Downloaded audio files and cached metadata use one device-local store. A
  manifest missing its required content ID is corrupted and cannot play or
  retry; render its remaining data with a warning and offer confirmed deletion.
- Add additive Albums and Songs filters plus a Downloads availability filter.
  Applying any combination keeps the same Library list presentation. Local
  pagination fetches the next page from the indexed store as the user scrolls,
  without making a server request for already-downloaded content.
- Show per-item download progress on the packshot image for every in-progress
  track or album download in a Carousel, Grid, or List. Completed items replace
  the progress state with their completed action state; failed items retain a
  retryable warning state.
- The local store should order by `downloadedAt` and a stable unique ID, newest
  first, and use a keyset cursor. Offset pagination can skip or duplicate rows
  when downloads are added or removed during scrolling.
- When online, normal server Library content may refresh independently;
  device-local rows must remain available if that refresh fails.
- If the device has no downloaded content, show an intentional local
  empty state without suppressing saved server content.

### List presentation

- Render List items as a lazy, single-column vertical collection. Each row has
  a leading square packshot and a text stack containing the primary title and
  one secondary metadata line.
- Format secondary metadata as localized content type plus available creator or
  artist attribution. Omit missing components and separators cleanly.
- Keep long visible titles to one line at standard text sizes with tail
  truncation, while preserving the complete title in accessibility. Allow the
  row to grow for larger Dynamic Type sizes rather than clipping text.
- Make the full row the primary content action: soundtrack rows start shared
  playback and album rows open album details. Keep auxiliary actions separate
  from the row’s primary hit target.
- Show the active sort control above the rows. Device-local Downloaded defaults
  to newest `downloadedAt` first with stable ID as the tie-breaker. Changing the
  sort resets the cursor and loaded rows before requesting the first page.
- Overlay download progress, failure, or metadata-warning state on the packshot
  without shifting row alignment or displacing text.
- Do not add the reference app’s layout-toggle, search, create, pin, or playlist
  behavior unless those features are separately specified for Finitude.

## Implementation phases

### Phase 1: Define the page-item, pagination, and download contracts

**Status: In progress**

The server pagination contract and Web, iOS, and Android Home adoption are
complete for attached manual Grid/List definitions. The iOS Library remains
the canonical unified Saved + Downloaded list, so an administrator-configured
Library parent descriptor is not a remaining dependency. Content Manager item
removal/update remains blocked until collection members also have stable
identities and an optimistic collection revision; adding an index-only
destructive mutation now would be ambiguous during duplicate or concurrent
edits. Compatibility parent payload removal also waits for legacy-client
retirement. Device-local dynamic definitions remain client-owned, while any
future server dynamic source needs its own source/filter/sort contract.

#### Reusable page-item presentations

- Change the page-item contract from a Carousel-only record to a discriminated
  union with stable item IDs and exactly three presentation types:
  - `carousel`, retaining its existing carousel reference;
  - `grid`, containing a title, source definition, supported content types,
    sort definition, and bounded page size;
  - `list`, containing the same source and pagination contract as Grid while
    requiring a vertical-list presentation.
- Give Grid and List definitions a source-mode discriminator:
  - `manual`, containing ordered content references curated in Content Manager;
  - `dynamic`, containing source, supported content types, filters, sort, and
    bounded page size without mutable item references.
- Make the first server-backed Grid a manual album Grid. Authorized Content
  Manager creators can add, remove, and reorder album references explicitly.
- Support both manual and dynamic Lists. Manual Lists preserve explicit item
  order and supported content types; dynamic Lists derive membership and order
  from their declared source.
- Model optional device-local Home sections as a Downloaded Albums dynamic
  album-only Grid and a Downloaded Songs dynamic soundtrack-only List. These
  sources are synthesized by the client and are not editable in Content Manager;
  they do not replace the unified Library list.
- Preserve backward decoding for existing carousel page records that do not
  yet contain a stable page-item ID.
- Keep Grid and List configuration in the page response, but do not embed their
  complete collections in the expanded-page payload.
- Add a paginated endpoint scoped to each Grid or List page item. Requests
  accept an opaque cursor and bounded limit; responses return ordered content
  references, included server-shaped album/soundtrack objects, and `nextCursor`.
- Include the display attribution needed by List rows in each page response,
  such as resolved artist or creator names. The iOS renderer must not issue an
  additional request per visible row to turn artist IDs into display text.
- Use keyset pagination with a deterministic tie-breaker such as `_id`. Treat
  cursors as opaque, validate that a cursor belongs to the requested page item,
  and reject malformed or stale cursors safely.
- Apply the parent page’s authentication semantics to each source. A
  personalized Library item must not become public through its pagination
  endpoint.
- Extend Content Manager create, attach, reorder, update, and remove workflows
  for Grid and List definitions while preserving existing Carousel behavior.
  Manual workflows manage item membership and order; dynamic workflows expose
  source configuration only and reject item-level mutations.
- Add API tests for mixed page-item ordering, legacy carousel records, cursor
  traversal, invalid cursors, end-of-list behavior, deletion between pages,
  authorization, and bounded page sizes.
- Add API and model tests proving manual membership/order mutations work only
  for manual definitions, dynamic item mutations are rejected, and Downloaded
  dynamic sources cannot resolve non-downloaded content.
- Add renderer contract tests for List row ordering, content-type metadata,
  missing-field separator cleanup, title truncation/accessibility, sort resets,
  and packshot progress overlays.
- Extend iOS response models with the bounded display attribution and optional
  duration fields required by List rows and offline metadata snapshots, while
  preserving backward decoding when older responses omit them.

#### Audio download transport

- Add a dedicated authenticated download route that shares safe S3 retrieval
  helpers with the stream route while keeping playback response semantics
  unchanged.
- Resolve the audio-track database record and require a ready lifecycle state
  before reading S3. Do not make an orphaned object downloadable merely because
  its key can be guessed.
- Preserve Range support for playback and add standards-compliant Range and
  validator handling to downloads so interrupted URLSession tasks can resume
  without changing existing AVPlayer behavior.
- Return stable metadata needed by the client: content type, byte length,
  ETag, and a safe filename derived from track metadata or the track ID.
- Define canonical metadata repair requests keyed by content ID. A soundtrack
  retry refreshes its server-shaped track metadata and inherited artwork
  references before resuming audio transfer; an album retry refreshes the album
  metadata and canonical ordered soundtrack IDs. Missing local IDs cannot be
  repaired through the network and must not trigger a guessed S3 request.
- Route download requests through the authenticated client. If the initial
  request returns `401`, allow one refresh-and-retry before recording a failed
  download; never put access or refresh tokens in persisted download metadata.
- Add backend tests for successful downloads, missing tracks/S3 objects,
  invalid IDs, auth failures, content headers, and partial/range behavior if
  the routes share implementation.
- Update API documentation with the final endpoint shape and error contract.

### Phase 2: Build local download infrastructure in iOS

**Status: In progress**

The foreground/relaunch engine, recoverable manifest, shared ownership,
strict resume validation, SQLite catalog, offline resolution, and storage
protection below are implemented. System-restored background `URLSession`
task mapping and physical suspend/termination proof remain blocked on the
target lifecycle environment.

- Add a small download domain model containing content ID, local URL, status,
  byte progress, total bytes, and last error.
- Add a download store/manager responsible for:
  - Stable application-support storage locations.
  - Atomic temporary-file-to-final-file moves.
  - Persisted status so app restarts do not lose completed or in-progress
    state.
  - Deduplication when the same track is requested more than once.
  - Cancellation, retry, removal, and reconciliation of missing local files.
- On logout, atomically mark active entries pausing, cancel their authenticated
  URLSession tasks, retain app-owned validated partial files, persist validators
  and byte progress, then mark them paused. Do not persist opaque system resume
  data that may contain the previous authenticated request. Ignore late
  completion callbacks whose task generation no longer matches the entry.
  Viewing, playback, cancel, and deletion remain available while signed out;
  resuming requires a newly authenticated request.
- Validate the local file and metadata independently. Treat canonical content
  IDs as the only critical metadata: missing IDs make entries corrupted and
  non-playable, while missing titles, durations, or artwork use fallbacks and
  warnings without blocking otherwise valid local playback.
- Persist the original server-shaped JSON snapshots alongside each download.
  Store an envelope version and API schema version so future model changes can
  migrate or invalidate stale snapshots safely while preserving the original
  payload shape.
- Model device-local download entries separately from physical audio assets.
  Entries represent album or standalone-soundtrack user intent; asset records
  track the local file and all owning entries so shared files are deleted only
  when their final owner is removed.
- Treat album manifest creation as recoverable: persist the album snapshot,
  ordered soundtrack snapshots, intended asset IDs, and per-item states before
  starting transfers.
- Add device-local queries for downloaded albums and soundtracks with stable
  ordering, keyset pagination, and count/empty-state checks. Do not partition
  manifests or assets by account and do not purge them on logout, account
  switching, or server-confirmed account deletion.
- Use an appropriate URLSession download mechanism for large audio files and
  background progress updates. Use a stable background-session identifier and
  persist the mapping from URLSession task identifiers to download entries so
  delegate callbacks can be restored after relaunch. Do not load entire tracks
  into memory.
- Define resumable transfer handling explicitly: append only a validated `206`
  response matching the stored strong ETag and `Content-Range`; replace the
  partial file on a validator mismatch or a `200` response; treat `416` as
  complete only when the local byte count matches the server length, otherwise
  restart from zero. A refreshed authenticated request may be retried once,
  but no token or signed URL is persisted in task metadata.
- Store user-requested downloads in Application Support, exclude them from
  device backups, apply an appropriate iOS file-protection class, and check
  available capacity before starting an album batch. Do not use an evictable
  URL cache as the source of truth.
- Use an indexed local database for manifests and pagination; do not scan all
  JSON snapshot files to render each Grid or List page.
- Ensure downloaded audio can be selected by the player without a session when
  the local file and required IDs are valid, while authenticated streaming
  remains the fallback when no valid local file exists.
- Make local-file availability take precedence over network availability checks
  in ContentDetails and offline Library playback. A valid local file must not
  be disabled because its remote stream cannot be reached.
- Keep logging privacy-safe; do not log auth tokens, signed URLs, or raw local
  user data.

### Phase 3: Add track actions to ContentDetails

**Status: Complete**

- Replace the per-track `saveButton` with the ellipsis control.
- Extract the action sheet into a reusable SwiftUI component so the audio
  player and future content surfaces can use the same actions.
- Feed the sheet from the existing `savedKeys` state and the new download
  manager state.
- Route Save actions through the existing `SavedContentPolicy` and
  `LibraryAPI` workflow, including in-flight protection and error handling.
- Route Download and Remove download actions through the download manager.
- Add accessibility identifiers, VoiceOver labels, Dynamic Type coverage, and
  sufficient tap targets for the ellipsis and action rows.
- Ensure menu presentation does not interfere with navigation links, track
  availability, or playback activity recording.

### Phase 4: Add unified offline Library and device-local collection pages

**Status: Complete**

- The iOS Home `PageItem` representation decodes Carousel, Grid, and List
  items. Manual server collections use page-scoped requests, while configured
  Downloaded Album/Song sources use the device-local SQLite catalog and never
  request a server child page.
- The Library remains one dynamic, vertically scrolling Saved + Downloaded
  union per the canonical business rule. Albums, Songs, and Downloaded are
  composable filters rather than administrator-configured Library page items.
- Reuse the existing album and soundtrack cards, but resolve playback URLs to
  local files when available and retain server URLs as online fallbacks.
- The Library view model composes local records with server content:
  - Load local downloaded content immediately.
  - Attempt the server request normally and treat offline transport failure as
    recoverable; do not gate requests solely on reachability hints.
  - Preserve the local collection when authentication refresh or server loading
    fails.
  - Keep local content visible after logout, account switching, authentication
    failure, or server-confirmed account deletion.
- Add local artwork caching or a packaged-artwork fallback so the collection
  remains useful offline. A remote artwork URL alone is not sufficient cached
  data.
- Add a Settings “Downloads” entry that opens a download-management page. The
  page supports canceling paused downloads, deleting individual completed or
  incomplete downloads, and clearing all local downloads. Keep album- and
  artist-scoped filters and bulk deletion as a documented follow-up rather
  than implementing them in this release.

### Phase 5: Add album download orchestration

**Status: Complete**

- Resolve the album through a dedicated album-track API or fetch every required
  page until all canonical track IDs are accounted for. The current first page
  of the global soundtrack endpoint is not evidence that the album is complete.
- Define a complete-album predicate based on the canonical ordered track IDs,
  resolved metadata, and availability of every required audio object.
- Add an album download control that queues each eligible track in album
  order.
- Limit concurrent downloads to a small bounded number and expose aggregate
  plus per-track progress.
- Persist each track result as it completes so interruption or failure is
  recoverable.
- Define behavior for unavailable tracks, duplicate track IDs, cancellation,
  retry, and an album whose metadata changes while downloading.
- Present an album as fully downloaded only when every required track reaches
  a terminal completed state. Preserve the manifest and per-track failures for
  partial completion, retry, and removal.
- Do not use the playback queue for download orchestration; the two systems
  have different lifecycle and persistence requirements.

### Phase 6: Test and document

**Status: In progress**

Completed for the Web pagination slice: strict response-schema tests, viewer
and request-shape tests, first/next/stale-cursor component tests, a production-
bundle Chromium traversal test, and the existing Listener smoke,
accessibility, and cross-account isolation gates.

Completed for native adoption: iOS passes 236 unit and 22 UI tests, including
indexed local second-page traversal, server continuation/restart behavior,
account/request fencing, offline playback, and shared-player launch. Android
passes 127 JVM and 22 API 31 device tests, including strict Home pagination and
actual-start Recently Played fencing. Physical-device, authenticated deployed
environment, and system-restored background-session checks remain unrun.

- Add unit tests for download state transitions, deduplication, retries,
  cancellation, atomic file finalization, missing-file reconciliation, and
  album aggregation.
- Add local-store tests for device ownership, metadata schema migration, asset
  ownership, stable ordering, local cursor pagination, concurrent
  insertion/removal, and missing-file reconciliation.
- Add deterministic networking tests using injected transports; avoid a live
  Archtree or S3 dependency.
- Add download-route tests proving non-ready database records and orphaned S3
  keys cannot be downloaded, while resumable ranges retain correct validators.
- Add UI tests for:
  - Track ellipsis opens the action sheet.
  - Save state and signed-out Save behavior remain correct.
  - Track download states change after successful and failed requests.
  - In-progress album and track downloads show progress on each affected
    Carousel, Grid, or List item’s packshot.
  - Entries missing required IDs cannot be played and expose confirmed Delete
    download; entries with valid IDs can retry metadata or file recovery.
  - Albums, Songs, and Downloads filters compose without changing the unified
    Library list presentation.
  - List rows show square packshots, title and content attribution, preserve full
    accessible titles, and keep progress/warnings on the packshot.
  - Changing List sort resets pagination and returns deterministic ordering.
  - Album Download appears only after a complete album is loaded.
  - Partial album downloads preserve completed tracks and expose failures.
  - Downloaded content appears in the Library without network
    access.
  - Grid and List items load additional local pages as the user scrolls and
    make no server request for local pagination.
  - Configured server Grid and List items load subsequent cursor pages without
    duplicates or missing items.
  - Online Library refresh failures, logout, account switching, and account
    deletion do not hide or remove device-local downloads.
  - Logout durably pauses active downloads without accepting stale completion
    callbacks, and the Downloads page remains available to cancel, delete, or
    clear all local items.
- Add physical-device checks for background download behavior, interrupted
  transfers, offline playback, storage pressure, and app relaunch.
- Update `docs/business-rules.md`, the Archtree API docs, iOS architecture/test
  docs, and release notes with the final behavior and known rollout limits.

## Acceptance criteria

- A signed-in user can open a track’s ellipsis menu and save/unsave or
  download/remove that track.
- A signed-out user sees the track actions but receives the existing
  sign-in-required behavior for Save and Download.
- A complete loaded album can be downloaded with visible aggregate progress.
- Each affected Carousel, Grid, or List item shows track or album download
  progress on its packshot while the transfer is incomplete.
- Albums, Songs, and Downloads filters compose over the unified Library list.
- Content Manager creators can curate and reorder albums in a manual Grid.
  Dynamic Grids reject manual item mutations.
- Manual Lists preserve curated membership and order; dynamic Lists derive both
  from their configured source.
- The Albums + Downloads result contains only downloaded Album entries, and
  Songs + Downloads contains only independently downloaded soundtrack entries.
- Failed album tracks can be retried without duplicating completed downloads.
- Items missing required content IDs are corrupted and not playable; they offer
  confirmed deletion. Missing non-identity metadata uses fallbacks and warnings.
- Valid downloaded tracks play offline with or without a session, and streaming
  playback continues to work for tracks that are not downloaded.
- App restart preserves completed downloads and recoverable in-progress state.
- The Library always displays device-owned downloaded content using cached
  server-shaped metadata, including while offline or signed out.
- Settings provides a Downloads page where users can cancel paused downloads,
  delete individual items, or clear all downloads; resuming requires
  authentication.
- Local Grid/List pagination does not depend on server pagination or network
  availability.
- Server Grid and List items paginate independently without bloating the parent
  page response.
- Removing one download entry never removes an audio asset still owned by
  another entry.
- No live queue behavior is implied or exposed by this release.
