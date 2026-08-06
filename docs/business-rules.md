# Archtree Business Rules

This document is the shared product-behavior reference for the Archtree backend
and Finitude iOS client. Update it whenever an agreed business rule changes.

## Saved Content and Library

- Users can save and unsave albums and audio tracks.
- "Soundtrack" in product language maps to the backend `audioTrack` type.
- Saved-content state is not limited to 20 items. The 20-item limits apply only
  to the recent-activity lists described below.
- Unsaving content removes it from Recently Saved immediately.
- The iOS Library tab renders one dynamic, vertically scrolling list rather
  than administrator-configured page items.
- The Library list contains the union of every saved album and soundtrack and
  every device-local album and soundtrack download. Matching saved and
  downloaded representations are one row, keyed by canonical content type and
  ID.
- Albums and Songs are additive content-type filters. Downloads is an
  availability filter that can be combined with either content type. With no
  filters selected, the complete supported Library is visible.
- The Library supports Recent Activity, Recently Saved, and Recently Played
  sorting. Recent Activity uses the newest saved, played, or downloaded event.
  Items without the selected sort event follow items that have one, using a
  deterministic fallback order.
- Completed downloaded content displays a download checkmark in its Library
  row. In-progress, paused, failed, and corrupted content displays its actual
  state rather than the completed checkmark.
- The Save control remains visible while signed out and uses disabled styling.
  Tapping it shows a sign-in-required error alert; it does not open login
  automatically.

## User Playlists

- Authenticated listeners can create, edit, and delete their own Playlists.
  Archtree provides the shared server-backed Playlist contract used by Web and
  future iOS clients.
- A Playlist is private and owner-only. The first release has no public,
  unlisted, shared, or collaborative Playlist state, and another listener
  cannot read or infer it from its ID.
- A Playlist has one required trimmed name of 1–100 Unicode characters.
  Different Playlists owned by the same listener may have the same name.
- A Playlist contains an explicitly ordered set of Soundtracks. Albums,
  Artists, duplicate Soundtracks, folders, pinned Playlists, and smart or
  automatically populated Playlists are not part of the first release.
- A listener may own at most 100 Playlists, and each Playlist may contain at
  most 500 Soundtracks. Repeating Add for an existing Soundtrack leaves its
  existing membership and order unchanged.
- Playlist artwork is a non-persisted read projection. In persisted member
  order, it uses the first ready, playable Soundtrack that provides usable
  track-specific artwork or inherited Album artwork; unavailable members and
  members without usable artwork are skipped. Summary and detail DTOs return
  that value as `artworkUrl`, or an empty string so the client uses the
  Finitude placeholder. The first release has no custom Playlist artwork
  upload or Playlist-owned storage object.
- A listener's Playlist list is ordered by most recent update first with a
  deterministic tie-breaker. Soundtrack order inside a Playlist is manual and
  can be changed with accessible move controls.
- Desktop Web displays a New Playlist control and the signed-in listener's
  Playlist list in the left sidebar below primary navigation. The reference
  layout informs hierarchy without copying another product's branding or exact
  components.
- On tablet and mobile Web, Playlists are available as a Library-owned
  destination rather than as an additional primary-navigation tab. Playlists
  remain separate from the Saved/Downloaded Album and Soundtrack union and its
  filters and sorting.
- The New Playlist control remains visible while signed out. Activating it
  reports that sign-in is required and does not automatically navigate to
  login.
- Playlist playback copies the currently ready members, in persisted order,
  into the shared player queue. Starting Play records the first ready
  Soundtrack once; starting from a row records that selected Soundtrack once.
  Previous, Next, and automatic advancement do not add activity entries.
- Unavailable members retain their position in the persisted Playlist but are
  skipped by playback. Editing or deleting a Playlist does not mutate or stop
  a queue that has already started.
- Deleting a Playlist removes only that Playlist and its memberships. It does
  not unsave, delete, download, or otherwise mutate its Soundtracks or shared
  Catalog content.
- Server-backed Playlists do not add Web downloads or implement iOS Downloaded
  Playlists. Web remains streaming-only, and native offline Playlist behavior
  requires a separate future contract.

## Catalog Visibility and Administration

- Finitude authorization has two product classes: `admin` and ordinary `user`.
  Any account whose persisted role is missing, unknown, or not exactly `admin`
  is treated as a user. `createdBy` records content provenance and does not
  grant a creator role or mutation permission.
- Public registration and federated account creation produce ordinary users.
  Administrator promotion is a controlled operational database action; there
  is no public role-promotion endpoint.
- Signed-out visitors, users, and admins can browse every database-confirmed
  ready or published Artist, Album, Soundtrack, configured public page item,
  Feed Post, stream, and public catalog artwork. Public visibility does not
  depend on the viewer role or the record's `createdBy` value.
- Pending, failed, deleting, orphaned, or otherwise non-ready lifecycle data is
  not public. Private account data, including avatars, saves, activity,
  sessions, and account metadata, is not part of the public catalog.
- A public Feed Post may retain its opaque author `userId` as content
  attribution for existing clients. That reference does not make the author's
  profile, avatar, email, account metadata, or other private state public.
- Only admins can create, update, delete, upload, link, reorder, or otherwise
  mutate shared Artists, Albums, Soundtracks, Feed Posts, assets, content
  relationships, Pages, Carousels, Grids, and Lists.
- Only admins can see or access Content Manager. Hiding its navigation is not
  an authorization boundary; direct page, form, API, and upload requests must
  enforce the same administrator role before processing a mutation.
- Admins manage the global shared catalog regardless of `createdBy`, while
  retaining that field for provenance and lifecycle auditing.
- Ordinary users continue to manage their own saves, Library state, Recently
  Played activity, profile/avatar, account, device-local downloads, and
  Playlists. These owner-scoped actions do not mutate the shared catalog.

## Personalized Carousels

- Personalized carousels have one of two sources:
  - Recently Saved
  - Recently Played
- Albums and audio tracks are mixed in both carousel sources.
- Content Manager does not offer album-only or audio-track-only filters for
  personalized carousels.
- Content Manager configures only the carousel name, source, and item limit.
- Personalized carousel items cannot be manually added, removed, reordered, or
  moved between carousels.
- Activity is stored by appending new entries to the end of its history, while
  carousels display the newest activity first.

## Recent-Activity Limits

- Each user has one Recently Saved history with at most 20 entries total across
  albums and audio tracks.
- Each user has one Recently Played history with at most 20 entries total across
  albums and audio tracks.
- Adding a 21st entry removes the oldest entry from that history.
- Repeating an activity for an existing item moves it to the newest position
  instead of creating a duplicate.
- Content that falls out of Recently Saved remains saved and can be exposed by
  a future complete Saved Library view.

## Album and Audio-Track Playback

- An album detail page has one prominent Play button above its audio-track list,
  styled consistently with the existing Play Video button.
- A populated `Album.audioTrackIds` list is the canonical album soundtrack
  order. Missing and non-ready references do not become playable queue items,
  and reverse-linked tracks are not silently appended. Legacy albums with no
  declared soundtrack IDs may fall back to ready tracks whose `albumId`
  references that album, using a deterministic order.
- Album artist attribution is derived from the ordered component soundtracks'
  explicit artist relationships. When those soundtracks provide no artist,
  Artists that explicitly reference the Album provide the display fallback.
- Tapping the album Play button starts the album queue and adds only the album
  to Recently Played.
- Explicitly tapping an individual song in an album's track list adds that
  audio track, but not the album, to Recently Played.
- Using Next or Previous and automatic queue advancement inside an album queue
  do not add audio tracks to Recently Played and do not add the album again.
- Playing an audio track outside an album queue adds that audio track to
  Recently Played.
- The album Play action consumes one entry in the shared 20-entry Recently
  Played history.
- Public soundtrack metadata and streaming expose only database-confirmed
  ready audio. Stream `HEAD` and `GET` resolve the stored object key from that
  database record; an orphaned or non-ready storage object is not public audio.

## Web Listener

- The Web listener renders administrator-configured Carousel, Grid, and List
  Home sections in persisted order. A client limitation on another platform
  does not change the configured presentation type.
- The Web Library is the complete server-backed union of saved Albums and
  Soundtracks. Web is streaming-only: it provides no Download action, Download
  filter, offline state, or browser-local Finitude media lifecycle. An ordinary
  browser file download is not represented as Finitude offline content.
- The Web listener owns one long-lived audio element, queue, and playback
  state. Starting playback keeps the current route visible, and navigation
  inside the listener does not replace or restart that player.
- Web Shuffle changes only the upcoming order of ready items already present in
  the current queue. Enabling it keeps the current soundtrack, elapsed time,
  and actual playback history in place; disabling it restores canonical queue
  order for subsequent navigation. Shuffle never inserts recommendations,
  missing items, or Smart Shuffle content.
- Web Repeat cycles through Off, All, and One. Repeat All wraps the current
  playback order, including a shuffled order; Repeat One restarts the current
  soundtrack only after natural completion, while an explicit Next or Previous
  action still navigates normally. Shuffle and Repeat mode changes do not add
  Recently Played activity.
- Web Previous restarts the current soundtrack when at least three seconds have
  elapsed. Before that threshold it navigates to the available previous item;
  at an unavailable boundary it remains a no-op. Repeat All may make the
  opposite queue boundary available.
- Hovering or dragging the Web progress control may preview a candidate time
  without changing playback. Pointer seeking commits on release, keyboard
  seeking commits with the range control, and every committed value is clamped
  to the known soundtrack duration.
- The compact Web player remains anchored to the viewport bottom. Scrolling
  page content, including a wheel gesture that begins over the player, must not
  move the player or the surrounding application shell.
- The Archtree landing page presents a visible Finitude Web entry to signed-out
  and signed-in visitors. Public browsing does not require authentication, and
  the entry does not replace content-management or account actions.
- Web logout clears account-scoped server-state caches and that account's local
  search history, but it does not stop an already-playing public stream.
- Browser Media Session controls are a progressive enhancement over the same
  in-page player state. Browser or operating-system restrictions may pause or
  stop background playback, so Web does not promise iOS-equivalent locked or
  background execution.
- On mobile Web, activating or swiping upward on the compact player opens an
  expanded presentation of that same player and queue. Closing it returns to
  the compact presentation without changing route or playback; horizontal
  compact-player swipes move only to an available adjacent queue item.
- Web playback shortcuts are inactive while focus is in an editable control.
  Unmodified single-character shortcuts are not used; the accessible player
  help lists the available non-character keys and every action remains
  available through visible controls.
- Public Web registration, verification, resend, and password-recovery writes
  use same-origin JSON contracts and never return session credentials. Generic
  registration, resend, and recovery responses do not reveal account
  existence.
- A native Apple, Google, or passkey configuration does not make that method
  visible on Web. Web advertises an optional sign-in method only after its
  complete browser-to-HttpOnly-session flow is configured.
- Listener performance and failure telemetry contains only bounded route,
  operation, status, Web Vital, and playback classifications. Its event payload
  and sink never retain identity, credentials, content IDs or titles, search
  terms, URLs or query strings, exception text or stacks, network addresses,
  device fingerprints, or a persistent visitor ID. Authentication funnel
  telemetry remains a separate bounded contract.

## Background and System Playback

- Active audio continues when the player screen is dismissed, the app enters
  the background, or the device locks, until playback is paused, stopped, or
  the queue ends.
- The in-app player, lock screen, Control Center, Bluetooth accessories, and
  other system media controls share one playback state and queue.
- System controls support play, pause, seeking, ten-second skips, and available
  previous/next queue navigation.
- Previous, Next, and automatic queue advancement from system controls follow
  the same Recently Played rules as their in-app equivalents and do not create
  additional activity entries.
- Each new playback queue records its navigation origin. Home and Library are
  the current origins; future pages that launch playback follow the same
  contract without adding source-specific playback logic.
- Ordinary foregrounding preserves the selected tab and the audio player's
  prior expanded or collapsed presentation. It does not expand a collapsed
  player merely because the queue has a current Now Playing item.
- Generic app activation is not a player-navigation intent. The client does not
  infer a Dynamic Island or lock screen media selection from activation; any
  documented routed intent must be handled explicitly.
- While a queue has a current item, the iOS app displays a compact Now Playing
  bar above the tab bar. Tapping or swiping upward expands the existing player;
  dismissing it returns to the compact bar without stopping playback.
- Starting playback from Home, Library, or album details keeps the current page
  visible and reveals the compact Now Playing bar; it does not push a separate
  full-screen player route.
- The compact and expanded presentations are two views of one shared player
  surface and one queue; playback controls must not create a second player or
  queue state.
- During an interactive compact-to-expanded transition, the expanded player's
  backdrop, header, and playback controls move as one rigid surface, with no
  element reflowing or settling independently after the gesture ends.
- During an upward drag from the compact bar, the expanded player's top edge
  stays aligned with the drag finger's vertical axis; it must not lag behind
  or accelerate ahead of the finger. The player remains collapsed until the
  drag begins, then follows the finger directly through the interactive
  transition.
- The expanded player's fixed header presents a centered pull indicator instead
  of a downward-chevron button. Pulling down collapses the player, and assistive
  technologies retain a semantic Collapse action.
- The expanded player keeps its title to one line and automatically marquees
  overflow unless Reduce Motion is enabled. Save and More actions sit beside
  the metadata, and confirmed local-download deletion belongs in More.
- Expanded playback uses a slim progress track without a persistent thumb and
  standard filled previous/play-or-pause/next transport controls, with the
  centered play-or-pause action visually dominant.
- On the compact bar, a vertical upward gesture is reserved for expansion. A
  horizontal gesture is reserved for previous/next queue navigation and must
  never expand the player, including when the gesture contains minor movement
  on the other axis.
- Horizontal queue navigation follows the finger during the gesture and settles
  to the available adjacent item on release. At a queue boundary, the bar
  returns to its original position without changing the current item.
- Horizontal swipes on the compact Now Playing bar move to the next or previous
  available queue item. They follow the same queue-boundary and Recently
  Played rules as the in-app Previous and Next controls.
- The compact and expanded players use iOS's system audio route picker for
  available Bluetooth and AirPlay outputs. Finitude does not implement custom
  device discovery or remote playback handoff to another Finitude device.
- Audio interruptions and output-route changes pause playback safely; playback
  resumes after an interruption only when iOS indicates that it should.

## Offline Downloads

- This section applies only to native clients with device-local download
  support. Finitude Web remains streaming-only and does not adopt these states,
  controls, storage rules, or offline playback guarantees.
- Starting or resuming a download requires an authenticated session. Signed-out
  listeners may browse and play available online streams, but Download prompts
  for sign-in and does not start a transfer until authentication succeeds.
- Completed downloads, cached metadata, and incomplete transfer state belong to
  the device rather than an account. They remain visible and manageable after
  logout or account switching, and completed valid downloads remain playable
  offline without a session.
- Playback always prefers a valid completed device-local audio asset for the
  requested soundtrack ID. The iOS app must not request the remote stream when
  that local file is available; it uses the server stream only when no valid
  completed local asset exists.
- The iOS Library composes device-local Downloaded content even when the
  authenticated server Library is unavailable or returns `401`. Signed-out
  state suppresses protected server sections, not device-local downloads.
- A download manifest must retain the canonical content ID. An album manifest
  must retain its album ID and the canonical ID of each component soundtrack.
  Missing or invalid required IDs make the affected entry corrupted and
  non-playable because it cannot be reconciled safely.
- Missing non-identity metadata does not make valid downloaded audio
  unplayable. The app renders every available field, uses clear fallback text
  for missing titles or durations, and shows a warning when metadata is
  incomplete. Manage Downloads treats incomplete metadata as a clearable
  download issue while preserving the separate playable/unplayable distinction.
- Packshot artwork is non-critical. A soundtrack uses its own cached artwork,
  inherited album artwork, or the packaged placeholder in that order; missing
  downloaded artwork never blocks playback.
- Selecting a corrupted entry explains that its required identity is missing
  and offers Delete download. The app deletes it only after the listener
  confirms the destructive action. An entry that retains a valid content ID
  may offer authenticated Retry to repair its file or metadata.
- In-progress soundtrack and album downloads remain recoverable and visible.
  Each affected item in a Carousel, Grid, or List displays its download
  progress on its packshot image. Incomplete items are not presented as
  completed downloads.
- Built-in device-download collections that include multiple transfer states
  use the headings Downloads — Albums and Downloads — Songs. Configured page
  items retain their configured names. Individual entries show their
  actual state, such as Download Complete, Downloading, Download Paused, or
  Download Failed; incomplete items are never labeled as completed.
- Logout durably pauses active transfers by ending authenticated network tasks
  while preserving validated partial files, validators, and resume state.
  Late callbacks cannot mark a paused entry complete after logout. Resuming
  creates a newly authenticated request and never reuses persisted credentials.
  Opaque system resume data containing the previous request is not persisted;
  resumption uses app-owned partial bytes and validator metadata.
- Downloaded content provides a filter control with Songs, Albums, Artists,
  and Playlists options. Albums use a Grid page item and Songs use a List page
  item. Artists and Playlists are visible as unavailable future options and
  have no content implementation yet.
- Settings includes a Downloads entry that opens the device-wide download
  management page. Signed-out and signed-in listeners can cancel paused
  downloads, delete individual downloads, and clear every download from the
  device. Future management may add filters and bulk deletion by album or
  artist.
- Completed downloads are local content and are not uploaded to Archtree or
  treated as Saved Library content. Removing a local download does not unsave
  its soundtrack or album, and unsaving content does not remove its download.
- A local audio asset may be owned by multiple device-local download entries.
  Removing one entry must not delete an asset still owned by another entry.

## Page Items

- Page items use a discriminated contract with three supported presentation
  types: Carousel, Grid, and List.
- Grid and List definitions each have one source mode: manual or dynamic.
  Manual definitions contain explicitly curated content references; dynamic
  definitions resolve items from a declared source and cannot be manually
  edited, reordered, or mixed with manual references.
- Content Manager administrators can add, remove, and reorder albums in a
  manual Grid. The initial manual Grid contract is album-only.
- Content Manager shows every page's configured Carousel, Grid, and List items
  in persisted order, including each item's resolved name, source mode, and ID.
  Missing or unsupported references remain visible as warnings rather than
  disappearing from the page summary.
- Manual Lists can contain explicitly curated supported content references and
  preserve their configured order. Dynamic Lists resolve their ordering from
  their source definition.
- Legacy configured Downloaded Albums and Downloaded Songs page items remain
  readable for backward compatibility, but the iOS Library no longer renders
  configured page items. It composes device-local downloads into its unified
  dynamic list.
- Dynamic Grid and List definitions expose only source configuration, filters,
  sort, and page size in Content Manager; their resolved items are read-only.
- Outside the unified iOS Library, a Grid always presents its source as a grid.
  A List always presents its source as a vertical list. One page-item type does
  not change into another layout in response to filtering.
- A List is a single-column, vertically scrolling collection. Each row has a
  leading square packshot, a primary title, and a secondary metadata line that
  identifies the content type and available creator or artist attribution.
- List metadata omits unavailable components without leaving stray separators.
  Missing titles use explicit fallback text, while accessibility exposes the
  complete available title even when visible text is truncated.
- The full List row is the primary action target. A soundtrack row starts the
  shared player and an album row opens album details; auxiliary controls must
  not create an overlapping primary tap target.
- A List exposes its active sort above the rows and defaults device-local
  Downloaded content to newest download first. Changing sort resets pagination
  and applies a deterministic tie-breaker.
- Download progress and warning state overlay the row’s packshot without
  changing row alignment or displacing title and metadata text.

## Audio-Track Artwork

- Public catalog artwork is readable only while its lifecycle record is ready
  and its Artist, Album, or Soundtrack owner still references that exact image.
  Private avatars, incomplete assets, and detached replacement assets are not
  public even when an image ID is known.
- Finitude Web may request fixed, versioned display-size variants derived from
  the canonical cover-art object. These variants are transient responses, do
  not create additional S3 objects or ownership records, and never replace the
  canonical asset used by native clients and reconciliation.
- Public catalog artwork responses require origin revalidation before cached
  bytes are reused, so detaching an image prevents subsequent public reads.
- An audio track uses its own cover art when one is explicitly assigned.
- Otherwise, a linked audio track inherits its album's cover art for display
  without copying album asset ownership into the audio-track record.
- A track with neither track-specific nor album artwork uses the client
  placeholder.
- Artist artwork is not used as an implicit track fallback because a track can
  reference multiple artists.

## Profile Identity and Avatars

- Signed-out account entry points display a neutral person placeholder and the
  Log in label. Content artwork is never used as a user-avatar fallback.
- A signed-in listener without an avatar displays deterministic initials from
  the authoritative display name, then email, with a neutral placeholder when
  neither value is available.
- A profile avatar is optional, belongs only to its authenticated account, and
  is not reused as artist, album, or soundtrack artwork.
- Avatar image bytes are private account data. Only the authenticated owner can
  read, replace, or delete them. Making avatars public requires a separate
  product decision and does not happen implicitly through a storage URL.
- Missing, malformed, offline, or failed avatar loading falls back to initials
  or the neutral placeholder without hiding or disabling the account entry.
- In Web and iOS account settings, the displayed profile avatar is the only
  photo-selection and replacement control. Activating it opens the existing
  photo workflow; a separate **Change Photo** control is not shown. The avatar
  remains operable by keyboard and assistive technologies, and avatar removal
  remains a separate explicit action.
- After selecting a photo, the listener can reposition and scale it in an
  in-app square crop editor and preview the final circular avatar before any
  upload begins. Upload requires explicit confirmation of that preview.
- Cancelling photo selection, cropping, or preview leaves the current avatar
  unchanged and creates no network request or server-side asset. The original
  photo is never modified.
- While a confirmed crop uploads, the last server-confirmed avatar remains
  visible. A failed upload preserves that avatar, discards the failed crop, and
  shows an error; the listener activates the displayed avatar to start again
  rather than using a separate retry action. The replacement appears only
  after Archtree confirms it.
- Archtree is the source of truth for avatar identity and revision. Stale
  profile or image responses from a previous account or revision must not
  replace current session state.
- Avatar upload, replacement, and deletion are idempotent and revision-checked.
  Concurrent stale mutations cannot overwrite or delete the winning avatar.
- Replacing an avatar attaches a validated replacement before deleting the old
  asset. A cleanup failure remains explicitly recoverable and must not be
  reported as completed cleanup.
- An account with an avatar requires the listener to explicitly remove that
  avatar before account deletion. Confirmed avatar deletion clears the profile
  reference and removes its owned S3 asset through the documented database/S3
  lifecycle; partial failure remains retryable and accurately reported.
- Account-scoped avatar metadata and cached bytes are cleared on logout,
  account deletion, or account change so one listener's avatar is never shown
  to another listener on the device.
- Uploaded avatars are fully decoded and normalized by Archtree. The service
  enforces bounded file and pixel sizes, removes metadata such as EXIF location,
  and controls the stored output encoding.

## Search

- Search is available to signed-out and signed-in listeners through the public content search experience.
- The Search tab appears between Home and Library.
- Before a query is entered, Search displays its default state and the current account's recent search history.
- Search history is stored only on the device, is isolated per authenticated account, and is deleted when that account signs out.
- Search history is limited to 10 entries. Repeating a query moves it to the newest position instead of creating a duplicate.
- Typing or deleting characters updates results for the normalized non-empty
  draft after a short cancellable debounce. Clearing the draft returns Search
  to its default state. Draft-driven searches, direct links, browser history
  navigation, and retries do not add or reorder search history.
- A non-empty query is added to or reordered in search history only when the
  listener explicitly submits it with the platform's supported Search action,
  or selects a suggested or historical query. Finitude Web uses the search
  input's Enter or mobile-keyboard Search action and does not display a
  separate Search button in the page search bar.
- Once a non-empty query is executed through either draft debounce or explicit
  submission, Search displays grouped Artist, Album, and Soundtrack results and
  does not display a Recent Content section.
- Artist results open Artist details, Album results open Album details, and Soundtrack results use the shared playback queue.
- On native clients with device-local download support, valid downloaded Albums
  and Soundtracks may be shown when the server search endpoint is unavailable;
  those results are visibly marked as downloaded content. Finitude Web has no
  device-local downloaded-content fallback.
- Voice search is not part of the initial Search release and requires a separate product decision.

## Authentication and Resolution

- New email registrations require a single-use verification code; existing
  accounts without an `emailVerified` migration field remain treated as verified.
- Apple and Google identities are keyed by each provider's stable subject ID,
  not by an email address that can change.
- A verified provider email matching an existing account does not silently link
  the accounts. Linking a new provider requires a valid session for the target
  account.
- Federated credentials must be signature-, issuer-, audience-, expiry-, and
  nonce-verified by Archtree before a session or account is created.
- Passkeys can be enrolled only from an authenticated account. Passkey sign-in
  uses discoverable credentials, one-time server challenges, required user
  verification, and server-maintained signature counters.
- Authentication funnel telemetry contains only a bounded stage, method,
  outcome, and timestamp; it does not contain account identifiers, email,
  credentials, tokens, or network addresses.
- Authentication entry points display only methods the connected deployment
  reports as fully configured. Password sign-in remains available as the
  compatibility fallback when optional capabilities cannot be resolved.
- Password-recovery and verification request responses do not reveal whether an
  email address belongs to an account.
- Completing a password reset revokes every active session for that account.
- Listeners can view and revoke active sessions, sign out everywhere, and
  delete their account in-app.
- Active-session UI uses familiar device and browser descriptions and never
  presents raw User-Agent or networking-version strings as device names.
- Authenticated listeners can set or change a password. Changing credentials
  preserves the current session and revokes every other active session.
- Apple or Google can be unlinked only when another password, provider, or
  passkey method remains available for account recovery.
- Listeners can clear Recently Played activity without removing saved albums
  or audio tracks.
- Listener deletion removes saved content, recent activity, Playlists,
  authentication actions, provider identities, and sessions before removing
  the user.
- Account deletion fails without changing the account while shared catalog
  records still retain that account's `createdBy` provenance. An administrator
  must first reassign that provenance or delete the affected shared records
  through their normal database/S3 lifecycle.
- Saved content and recent activity belong to the authenticated viewer.
- The same personalized carousel definition resolves differently for each user.
- A signed-out viewer receives no personalized carousel items.
- The expanded Library page requires valid authentication and returns `401`
  for missing or expired credentials so clients can refresh their sessions.
- Expanded public pages such as Home may use optional authentication.
- Cookie-authenticated Web requests for account-owned or personalized data are
  bound to the account identity currently displayed by that tab. A missing or
  stale tab identity fails closed before private data is read or changed;
  native Bearer requests remain bound to the identity in their access token.
- A browser account transition immediately hides the previous identity and
  removes its private cached data before resolving the authoritative shared
  cookie session. Tabs reconcile login, logout, logout-all, account deletion,
  and identity mismatch with one another, and a late response for the previous
  account cannot restore its data. Account exit clears only that account's
  device-local search history.
- Browser login and refresh may install or rotate HttpOnly credentials only
  while the client holds the shared origin-wide session-transition lock. A
  client without that capability cannot set credentials. A refresh from a tab
  with a resolved account is fenced to that viewer and must return the same
  authoritative identity. A first-load refresh without a resolved viewer may
  adopt only the identity returned after the server has compared every present
  signed access and refresh credential; the client treats that adoption as an
  account transition before using private data. Logout or prior-session login
  revocation failure preserves the existing cookies and reports a retryable
  failure; uncoordinated legacy logout is revoke-only so a delayed response
  cannot clear a newer account's cookies. Conflicting access and refresh
  identities do not rotate credentials, fail closed, and may be cleared only
  by the locked signed-out recovery path, which notifies every open tab.
- Backend requests validate that referenced albums and audio tracks exist and
  match the declared content type.
- Deleted content is removed from saved and recent-activity references and is
  also omitted defensively during carousel resolution.

## Database and S3 Lifecycle

- Database and S3 mutations must not silently create orphaned records, objects,
  or cross-content references.
- Every S3 object owned by Archtree must remain traceable to a database lifecycle
  record containing its owner, object key, and current status.
- Creating content with an S3 asset records a recoverable pending database state
  before upload. It becomes ready only after the upload succeeds.
- If an upload succeeds but the final database update fails, the service must
  either remove the uploaded object or preserve enough lifecycle metadata for
  reconciliation.
- Replacing an asset uploads and attaches the replacement before deleting the
  previous object. A failed cleanup remains explicitly identifiable.
- Deleting content removes its owned S3 objects before removing the final
  database metadata. If S3 deletion fails, retain the database record with a
  failed-deletion state so the operation can be retried or reconciled.
- Database references to deleted content, including album, artist, carousel,
  Playlist, saved-content, and recent-activity references, must be cleaned up
  idempotently.
- Shared assets or references must not be deleted merely because one referencing
  record is removed.
- Batch operations report success or failure for each item and retain
  recoverable state for partially completed items.
- Reconciliation reports detect orphaned S3 objects, missing S3 objects,
  dangling database references, and incomplete lifecycle states. Audits do not
  automatically delete unknown data.
