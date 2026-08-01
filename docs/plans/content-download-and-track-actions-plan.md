# Content Downloads, Track Actions, and Grid Page Items Plan

## Status

Draft. This document is implementation guidance, not the canonical product
contract. Promote agreed behavior to `../business-rules.md` in the same change
as implementation.

## Objective

Restore download functionality on the iOS content-details page and replace the
per-track Save control with an extensible ellipsis menu. Support downloading a
single soundtrack and downloading an entire album when the complete album
track list has been loaded. Add `contentGrid` as a reusable page-item type for
paginated online collections and use the same presentation for the local,
offline Downloaded collection.

This plan applies to the Finitude iOS client and the Archtree audio delivery
API. It does not add a live, user-editable playback queue.

## Current state

- `ContentDetails` already loads an album’s linked soundtracks and checks each
  stream with `HEAD` before enabling playback.
- Album playback builds an in-memory queue for Play, Previous, Next, and
  automatic advancement.
- The iOS client has Save-to-Library state and authentication handling, but no
  local download manager or offline audio storage.
- Archtree exposes an audio stream endpoint backed by S3 with HTTP Range
  support. Its current response is optimized for playback and uses inline
  content disposition.
- There are no implemented “Play next,” “Add to queue,” Up Next, or queue
  editing actions.

## Product behavior to establish

Before implementation, confirm and record these rules in
`../business-rules.md`:

1. Downloads require authentication. Signed-out users may browse and play
   available streams, but Download prompts for sign-in using the existing
   authentication flow behavior.
2. A track is downloadable only when its stream is available and the download
   has not already completed.
3. A completed download is stored locally and can be played without network
   access. It is not uploaded back to Archtree or treated as saved Library
   content.
4. “Download album” is available only when the complete album track list has
   loaded and all required tracks are known. Partial album data must not be
   presented as a complete album download.
5. Album downloads report per-track progress and retain recoverable state when
   one or more tracks fail. Retrying failed tracks must not redownload tracks
   that already completed.
6. Removing a local download does not unsave the track or album, and unsaving
   content does not delete its local download.
7. Downloads and cached metadata are account-scoped. Sign-out hides and locks
   them without deleting them; signing back into the same account restores
   access.
8. Offline mode is a network condition, not a replacement server account. The
   app may show the active account’s local downloaded-content page without a
   network connection, but it must not merge another account’s downloads into
   the current account.
9. Downloading an album creates one album entry in Downloaded. Its component
   soundtracks are not also shown as standalone grid entries unless the user
   downloaded those soundtracks independently.
10. A local audio asset may be owned by more than one download entry. Removing
    an album download must not delete a soundtrack file that is still owned by
    a standalone soundtrack download or another local collection.
11. Server-backed content grids use cursor pagination and deterministic server
    ordering. The offline Downloaded grid uses cursor pagination over the local
    store and never contacts the server to load another local page.
12. Account switching does not expose the previous account’s downloads.
    Account deletion purges that account’s local download manifests, metadata,
    artwork, and audio files from the device.

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

- Library should always include a “Downloaded” content grid page item for the
  active account, including when the server is unreachable. Show a compact
  local empty state when that account has no downloads.
- The grid uses the same cached server-shaped album and soundtrack objects as
  the online UI. Preserve the original versioned JSON response snapshots and
  maintain a small local index for account, content type, content ID, status,
  and ordering. Do not reconstruct display records from filenames.
- Downloaded audio files and cached metadata are stored together under an
  account-scoped local store. A downloaded file without valid metadata is
  treated as incomplete and is reconciled or removed.
- The downloaded grid is a synthetic local `contentGrid` page item, not a
  server-managed carousel or personalized carousel. Inject it first in the
  Library page model so it is available in both online and offline states.
- Use a grid layout with lazy loading. Lazy loading means local pagination:
  fetch the next page from the local store as the user scrolls, without making
  a server request for already-downloaded content.
- The local store should order by `downloadedAt` and a stable unique ID, newest
  first, and use a keyset cursor. Offset pagination can skip or duplicate rows
  when downloads are added or removed during scrolling.
- When online, the normal server Library content may refresh independently;
  the Downloaded grid must remain available if that refresh fails.
- If the active account has no downloaded content, show an intentional local
  empty state without suppressing configured online Library page items.

## Implementation phases

### Phase 1: Define the page-item, pagination, and download contracts

#### Reusable content-grid page items

- Change the page-item contract from a carousel-only record to a discriminated
  union with stable item IDs:
  - `carousel`, retaining its existing carousel reference;
  - `contentGrid`, containing a title, source definition, supported content
    types, sort definition, and bounded page size.
- Preserve backward decoding for existing carousel page records that do not
  yet contain a stable page-item ID.
- Keep grid configuration in the page response, but do not embed the entire
  grid collection in the expanded-page payload.
- Add a paginated endpoint scoped to the page item. Requests accept an opaque
  cursor and bounded limit; responses return ordered content references,
  included server-shaped album/soundtrack objects, and `nextCursor`.
- Use keyset pagination with a deterministic tie-breaker such as `_id`. Treat
  cursors as opaque, validate that a cursor belongs to the requested page item,
  and reject malformed or stale cursors safely.
- Apply the parent page’s authentication semantics to each grid source. A
  personalized Library grid must not become public through its pagination
  endpoint.
- Resolve the first server-backed grid source and sort as an explicit product
  decision before implementation; the pagination and rendering contracts must
  not hard-code one future source into the generic page-item type.
- Extend Content Manager create, attach, reorder, update, and remove workflows
  for content-grid page items while preserving existing carousel behavior.
- Add API tests for mixed page-item ordering, legacy carousel records, cursor
  traversal, invalid cursors, end-of-list behavior, deletion between pages,
  authorization, and bounded page sizes.

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
- Route download requests through the authenticated client. If the initial
  request returns `401`, allow one refresh-and-retry before recording a failed
  download; never put access or refresh tokens in persisted download metadata.
- Add backend tests for successful downloads, missing tracks/S3 objects,
  invalid IDs, auth failures, content headers, and partial/range behavior if
  the routes share implementation.
- Update API documentation with the final endpoint shape and error contract.

### Phase 2: Build local download infrastructure in iOS

- Add a small download domain model containing track ID, local URL, status,
  byte progress, total bytes, and last error.
- Add a download store/manager responsible for:
  - Stable application-support storage locations.
  - Atomic temporary-file-to-final-file moves.
  - Persisted status so app restarts do not lose completed or in-progress
    state.
  - Deduplication when the same track is requested more than once.
  - Cancellation, retry, removal, and reconciliation of missing local files.
- Persist the original server-shaped JSON snapshots alongside each download.
  Store an envelope version and API schema version so future model changes can
  migrate or invalidate stale snapshots safely while preserving the original
  payload shape.
- Model download entries separately from physical audio assets. Entries
  represent album or standalone-soundtrack user intent; asset records track
  the local file and all owning entries so shared files are deleted only when
  their final owner is removed.
- Treat album manifest creation as recoverable: persist the album snapshot,
  ordered soundtrack snapshots, intended asset IDs, and per-item states before
  starting transfers.
- Add local queries for downloaded albums and soundtracks with stable ordering,
  keyset pagination, filtering by active account, and count/empty-state
  checks.
- Define the account boundary for local metadata and files. Sign-out must
  lock the store for the previous account before another account can use the
  app.
- Purge the active account’s local store after server-confirmed account
  deletion. If cleanup is interrupted, retain a cleanup marker and reconcile
  it on the next launch.
- Use an appropriate URLSession download mechanism for large audio files and
  background progress updates. Do not load entire tracks into memory.
- Store user-requested downloads in Application Support, exclude them from
  device backups, apply an appropriate iOS file-protection class, and check
  available capacity before starting an album batch. Do not use an evictable
  URL cache as the source of truth.
- Use an indexed local database for manifests and pagination; do not scan all
  JSON snapshot files to render each grid page.
- Ensure downloaded audio can be selected by the player when the local file is
  present, while streaming remains the fallback when it is not.
- Keep logging privacy-safe; do not log auth tokens, signed URLs, or raw local
  user data.

### Phase 3: Add track actions to ContentDetails

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

### Phase 4: Add offline Library content grid

- Refactor the iOS `PageItem` representation into a type-safe discriminated
  model that decodes server carousel and content-grid items and can also host
  the synthetic local Downloaded grid.
- Add one reusable lazy content-grid renderer with injected paginated data
  sources: an authenticated server source for configured online grids and a
  local-store source for Downloaded. Keep pagination out of the SwiftUI view.
- Reuse the existing album and soundtrack cards, but resolve playback URLs to
  local files when available and retain server URLs as online fallbacks.
- Make the Library view model compose the local grid with server sections:
  - Load local downloaded content immediately.
  - Attempt the server request normally and treat offline transport failure as
    recoverable; do not gate requests solely on reachability hints.
  - Preserve the local grid when authentication refresh or server loading
    fails.
  - Show local content during an offline active-account session, but hide it
    after explicit sign-out or account switching.
- Add local artwork caching or a packaged-artwork fallback so the grid remains
  useful offline. A remote artwork URL alone is not sufficient cached data.
- Add an account-switch/sign-out transition that locks and hides the previous
  account’s grid without deleting it. Server-confirmed account deletion uses
  the separate purge lifecycle defined above.

### Phase 5: Add album download orchestration

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

- Add unit tests for download state transitions, deduplication, retries,
  cancellation, atomic file finalization, missing-file reconciliation, and
  album aggregation.
- Add local-store tests for account isolation, metadata schema migration,
  asset ownership, stable ordering, local cursor pagination, concurrent
  insertion/removal, and missing-file reconciliation.
- Add deterministic networking tests using injected transports; avoid a live
  Archtree or S3 dependency.
- Add download-route tests proving non-ready database records and orphaned S3
  keys cannot be downloaded, while resumable ranges retain correct validators.
- Add UI tests for:
  - Track ellipsis opens the action sheet.
  - Save state and signed-out Save behavior remain correct.
  - Track download states change after successful and failed requests.
  - Album Download appears only after a complete album is loaded.
  - Partial album downloads preserve completed tracks and expose failures.
  - Downloaded content appears in the Library content grid without network
    access.
  - The grid loads additional local pages as the user scrolls and makes no
    server request for local pagination.
  - A configured server content grid loads subsequent cursor pages without
    duplicates or missing items.
  - Online Library refresh failures do not remove the downloaded grid.
  - Explicit sign-out hides the prior account’s downloads, account switching
    does not leak them, and account deletion removes them locally.
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
- Failed album tracks can be retried without duplicating completed downloads.
- Downloaded tracks play offline and streaming playback continues to work
  unchanged for tracks that are not downloaded.
- App restart preserves completed downloads and recoverable in-progress state.
- The Library displays account-scoped downloaded content offline using cached
  server-shaped metadata and a lazy local content grid.
- Local grid pagination does not depend on server pagination or network
  availability.
- Server content grids paginate independently without bloating the parent page
  response.
- Removing one download entry never removes an audio asset still owned by
  another entry.
- No live queue behavior is implied or exposed by this release.
