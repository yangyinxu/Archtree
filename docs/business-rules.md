# Archtree Business Rules

This document is the shared product-behavior reference for the Archtree backend
and Finitude clients. Update it whenever an agreed business rule changes.

<!-- @catalog -->
**Contents**

- [Social Identity and Friendships](#social-identity-and-friendships)
- [Direct Music Shares](#direct-music-shares)
- [Friend Listening Status](#friend-listening-status)
- [Shared Playback Rooms](#shared-playback-rooms)
- [Saved Content and Library](#saved-content-and-library)
- [Web Listener Presentation](#web-listener-presentation)
- [User Playlists](#user-playlists)
- [Catalog Visibility and Administration](#catalog-visibility-and-administration)
- [Native Home Startup and Recovery](#native-home-startup-and-recovery)
- [Finitude Localization](#finitude-localization)
- [Personalized Carousels](#personalized-carousels)
- [Artist Follows and New Releases](#artist-follows-and-new-releases)
- [Recent-Activity Limits](#recent-activity-limits)
- [Album and MediaTrack Playback](#album-and-mediatrack-playback)
- [Web Listener](#web-listener)
- [Background and System Playback](#background-and-system-playback)
- [Offline Downloads](#offline-downloads)
- [Administrator Album Imports](#administrator-album-imports)
- [Administrator Metadata Lookup](#administrator-metadata-lookup)
- [Web Administrator Local MP3 Conversion](#web-administrator-local-mp3-conversion)
- [Page Items](#page-items)
- [MediaTrack Artwork](#mediatrack-artwork)
- [Profile Identity and Avatars](#profile-identity-and-avatars)
- [Search](#search)
- [Authentication and Resolution](#authentication-and-resolution)
- [Naruto Mobile private analysis proxy](#naruto-mobile-private-analysis-proxy)
- [Database and S3 Lifecycle](#database-and-s3-lifecycle)
<!-- @end-catalog -->

## Social Identity and Friendships

- Social participation is opt-in and separate from the private account profile.
  The versioned backend is disabled for new participation by default until
  explicitly enabled. Existing listener APIs and private avatar access do not
  change. Finitude Web provides an explicitly enabled social screen; native
  adoption remains a separate stage.
- A social profile has a separately generated opaque ID, an explicit nickname
  of 1–50 Unicode characters, and a case-insensitive handle of 3–24 ASCII letters,
  digits or underscores beginning with a letter. The handle cannot change during
  the account's lifetime; the nickname and discoverability can change.
- Names that could pass for Finitude, its staff or a system account are
  reserved, and the rejection says whether the handle or the nickname must
  change. This is a closed-beta safeguard; listeners can also block and report,
  and administrators can suspend a social profile (see below).
  - A new handle cannot be a staff role (such as admin, administrator,
    moderator, mod, staff, official, support, helpdesk, security or system) or a
    system or mailbox name (such as root, help, api, www, mail, no-reply, null or
    undefined), and cannot contain Finitude, Archtree or Kashewt. A staff role
    is also reserved as an underscore-separated part of a handle, such as
    support_team.
  - The handle comparison ignores case, underscores and a trailing number, and
    treats common look-alikes as the same letter (0 and o, 1 and i or l, 3 and e,
    4 and a, 5 and s, 7 and t, 8 and b, rn and m, vv and w), so adm1n and
    admin_2024 are reserved too.
  - A nickname cannot use a staff role as a whole word, including camel-case
    and spaced-out spellings such as SupportBot and A D M I N, and cannot contain
    Finitude, Archtree or Kashewt. The same look-alike and trailing-number
    rules apply, plus capital I and lowercase l, accents, full-width and other
    Unicode compatibility forms, and common Cyrillic or Greek look-alike
    letters. The Chinese staff terms 管理员, 官方, 客服, 版主 and 工作人员 (and
    their traditional forms) are rejected anywhere in a nickname. System and
    mailbox names stay allowed in nicknames.
  - Existing profiles are not modified. A handle or nickname that predates
    these rules stays usable, including for discovery changes, deactivation and
    reactivation. The nickname rules apply once its owner changes the nickname.
- Authenticated exact-handle lookup returns only the opted-in handle, nickname,
  opaque social ID and generated-icon seed. Missing, undiscoverable and blocked
  results are indistinguishable. Email, account IDs, private avatars, saves and
  activity are never projected into social cards.
- Finitude Web shows a social identity by nickname and @handle beside a
  generated icon: the nickname's first character on a color derived from the
  generated-icon seed, never a private account avatar. Profile setup states the
  handle format before submission and counts the nickname in Unicode characters
  with the backend's trimming and character rules, so a nickname of 50 emoji is
  accepted and one the backend would refuse is explained before sending.
- Friendship requires an explicit request and recipient acceptance. Crossing
  requests do not automatically become friends. Only the sender may cancel a
  pending request and only the recipient may accept or decline it. Either friend
  may remove the relationship. Changes apply to the observed relationship
  revision; a stale action never applies to a later request incarnation.
- A listener may block another social identity in either direction. Blocking
  removes friendship and pending requests atomically. Both directions remain
  independent, and unblocking restores no relationship. A private block list
  exposes only the owner's blocked opaque IDs and mutation revisions; it does
  not unlock the blocked person's current profile.
- A listener with a social profile, including a deactivated or suspended one,
  can report another existing social identity, including one it has blocked or
  that is no longer active. A report has an optional reason (pretending to be
  someone else, harassment or bullying, spam or unwanted requests, offensive
  name or content, or something else, the default) and an optional note of up
  to 500 characters. Finitude Web asks for the reason and note in a
  confirmation dialog before sending.
  - Reporting never blocks, removes or notifies anyone. The reported listener
    is never told that they were reported or by whom, and nothing they can see
    changes. A report keeps the handle and nickname as they were when reported.
  - Each reporter files at most one report about the same listener per UTC day;
    repeating it that day succeeds without creating another report or using
    allowance. Each reporter can file at most 10 reports per UTC day. Reporting
    follows the mutation-scope and command-ID rules and remains available while
    new social participation is disabled.
  - Administrators review open reports, oldest first, with the reporter's
    current handle. They can dismiss a report, mark it handled, or suspend the
    reported listener, which resolves every open report about that listener.
    Resolved reports are deleted 90 days after resolution; open reports remain
    until an administrator resolves them.
- An administrator can suspend a social profile from social features and lift
  the suspension later. Suspending or lifting again has no further effect.
  - While suspended, the profile cannot be looked up and appears on no friend
    list, request, music share, listening status, room or invitation. The
    listener cannot edit or reactivate the profile, send or accept requests,
    share music, share listening, or create, join or be invited to rooms.
  - Suspension cancels pending requests in both directions, removes music
    shares, turns listening sharing off, removes room participation (ending a
    room the listener hosts) and revokes invitations, as deactivation does.
    Accepted friendships and blocks are kept but hidden from both sides.
  - The suspended listener sees that the profile is suspended and can still
    block, unblock, report, look up command outcomes and delete the account.
  - Lifting a suspension restores the listener's own active or deactivated
    state, discoverability and retained friendships. Cancelled requests,
    removed shares, listening sharing and room participation are not restored.
- Finitude Web offers Block both in the relationship lists and for anyone found
  by handle lookup, with or without an existing relationship. Removing a friend
  and blocking first ask for confirmation that says what changes for both
  people; declining or cancelling a request and unblocking stay single explicit
  actions because they are easily redone. A Remove confirmation acts on the
  relationship revision observed when it was opened; Block carries no revision
  and applies to whatever relationship exists when it is confirmed. Deactivating
  the social profile likewise asks first and says what is removed and what is
  kept.
- Turning discovery off preserves existing friends and pending requests.
  Deactivation hides the profile, turns discovery off, cancels requests and
  removes friendships, while retaining the listener's identity, handle and private
  blocks. Reactivation restores none of those removed relationships, and the
  profile stays undiscoverable until the listener turns discovery back on. A new
  request after removal uses a fresh, authorized relationship-state read.
- The first backend release permits at most 500 friends, 50 combined incoming and
  outgoing pending requests, 1,000 owned blocks and 2,048 retained relationship
  pairs per account. Existing-pair safety operations remain possible at the pair
  limit. New requests also have sender and recipient abuse limits per UTC day:
  - A listener can send at most 50 friend requests per day, and at most 3 of
    them to the same listener.
  - A listener can receive requests from at most 100 different listeners per
    day. More requests that day from a listener already counted use no more of
    this allowance, so one sender cannot use it up for everyone else.
  - Every request sent counts, even if it is later cancelled, declined or
    accepted, so cancelling and re-sending cannot get around these limits.
    Repeating a request that is still pending, or a request that is rejected,
    does not count.
  - A request over any limit is rejected without being created, and the
    rejection does not say which limit applied.
- Every durable social action uses its original server-issued mutation scope and
  command ID. Identical retries return a status-only outcome and never restore
  revoked access. Reusing the identity with a different action fails. Expired
  scopes cannot execute, even after receipt cleanup; an uncertain result must not
  be silently resubmitted with a fresh scope.
- Account deletion atomically removes social identity and both-sided
  relationships with its existing private-account cleanup. A deleted handle is
  reserved for 30 days without retaining its former account/social ID, then may
  be reused with a new opaque identity. Existing avatar and shared-provenance
  deletion blockers remain unchanged and preserve social state on failure.
  Deletion removes every report about the account. Reports the account wrote
  remain as anonymous evidence about the reported listener: the reporter's
  identity and note are removed, and the reason and reported name stay until
  the report is resolved and expires.
- Disabling new social participation preserves reads, discovery opt-out without
  changing the handle/nickname, explicit cancellation, removal, block/unblock,
  reporting, deactivation, outcome lookup, administrator suspension and account
  cleanup. Admission attempts cannot
  consume the reserved receipt capacity for safety actions and final deactivation;
  short request-rate limits still apply.
  Social participation adds no public Feed, collaborative Playlist, chat,
  push/email delivery or S3-backed social avatar.
- Finitude Web offers Together navigation, Share and friend listening status
  only while social participation is enabled. Listen together, room invitation
  reminders and the active-room entry additionally require rooms to be enabled.
  An unknown rollout state offers none of them, so a default deployment neither
  shows nor requests anything social. While social is disabled, the Together
  screen stays reachable by its address for the preserved reads and safety
  actions and states that Together is temporarily unavailable.
- A request refused because social or rooms were switched off is explained as
  temporary unavailability, never as a generic or uncertain failure, and needs
  no outcome recovery. It refreshes the rollout state so the affected entry
  points disappear without a reload; a dialog that is already open stays until
  closed so it can explain the refusal.
- Any other definite refusal names its reason so the listener knows what to do
  next: a taken or reserved handle, a handle that is already set, a request the
  other person has already sent (to be accepted from Incoming requests), an
  unavailable profile, the friend, pending-request and block limits, the
  music-share limits and too many recent actions each have their own message.
  An unavailable profile is never distinguished from a block. Only an action
  that lost a race against a newer relationship, profile or listening revision
  says the state changed and shows the latest state. None of these refusals
  offers outcome recovery or keeps the action for a resend.
- Social does not depend on Shared Playback Rooms. While its page is visible,
  Finitude Web refreshes new friend requests and received shares, with or
  without rooms. It uses the live room connection when one exists. Otherwise it
  checks for changes about every 15 seconds and slows to once a minute while
  nothing changes. These refreshes are silent: no unread count, sound, system
  notification, push or email. A hidden page does not check.

## Direct Music Shares

- An active social profile can explicitly share a ready MediaTrack or Album with
  a current friend. Sharing uses the observed friendship revision. Private
  Playlists, account activity and arbitrary messages or external URLs are not
  shared. Recipients can return later; simultaneous presence is unnecessary.
- Received and Sent lists are private to their respective account and show the
  other person's current social card. They are not a public feed, unread-history
  count, or read/play receipt. Sharing, opening a card and viewing its list never
  automatically play, save, join or create a room.
- Play and Save remain explicit personal actions under the ordinary catalog and
  player rules. An Album play resolves its complete current playable order.
  Another room is never left implicitly. Inviting the sender back uses current
  host/controller permissions and existing friendship and room admission checks.
- Each account may retain up to 100 incoming and 100 outgoing shares for 30 days,
  with at most 50 new incoming shares per day. Repeating a still-active share of
  the same content to the same friend creates no duplicate or new notification.
  The recipient can dismiss a card; its sender can withdraw it. Both remove that
  share, and an old action cannot affect a later share incarnation.
- Current friendship, active profiles and no block are required on every read.
  Removing friendship, blocking, deactivation, administrator suspension or account
  deletion clears affected shares. Reconnecting friendship never restores them. Turning discoverability
  off preserves current shares. Disabling social admission preserves authorized
  reads, dismiss/withdraw and outcome recovery while preventing new sends.
- Shares retain catalog identity rather than copied media bytes or versioned
  playback URLs. Replacement resolves the current ready content. Deleting or
  non-ready content exposes no former title/artwork; an unavailable card can be
  dismissed while idempotent content-reference cleanup removes the share.

## Friend Listening Status

- Sharing current listening is off by default and requires an explicit preference
  change by an active social profile. It supports ordinary and shared-room Audio;
  Video, readiness, play intent and historical activity never establish status.
  Turning discoverability off preserves this independent preference. Deactivation
  and administrator suspension reset it to off; reactivation or lifting the
  suspension does not restore it.
- Only current friends with active social profiles and no block can see a fresh
  status. It exposes the current ready Audio and chosen social identity, without
  playback position, room/device/session identity, last-seen data or history.
  Friend status refreshes while its panel is visible and disappears when stale or
  unreadable. The panel lists every friend listening now, not only those on one
  page of the friend list, 20 at a time with an explicit Load more, and shows the
  Audio's public artwork, title and artists. Removing friendship or blocking
  removes visibility immediately at the server, independently of continued room
  membership.
- A new explicit playback or sharing gesture may claim the account's publishing
  device against its observed publisher revision. That claim publishes nothing
  until the device reports actual playback. Automatic advancement, reconnecting,
  polling and old callbacks cannot take over from a newer device. Delayed reports
  and stops affect only their captured publisher and playback occurrence.
- Actual advancing playback renews the short status at most once per ten seconds.
  Observations must be fresh, and status expires within 25 seconds of the latest
  accepted observation. Pause, buffering, seeking, end, errors, source changes,
  freeze and account transitions stop local publication. Fresh actual progress
  may restore a still-owned lease; an expired or replaced lease needs a new
  explicit gesture. Merely hiding an Audio tab does not stop fresh playback.
- Room reports additionally require the exact admitted playing controller and
  current ready timeline occurrence. Ordinary Audio does not require room-format
  analysis. Reads and renewals recheck the current ready source; replacing or
  removing that source invalidates its earlier publication. A loaded source keeps
  its identity across buffering and resumes so old bytes cannot silently rebind
  within the same publishing lease.
- Opt-out clears publication atomically while preserving its version fence.
  Revocation clears only the matching publishing session; retaining the current
  session during a password change preserves its eligible publication. Account
  deletion removes the preference and publication with existing account cleanup.
  Ephemeral publication records expire; their durable owner clock prevents a
  delayed report from recreating expired state. Safety stops and opt-out retain
  access when new participation or playing-report capacity is unavailable.
  Disabling social participation suppresses listening status while preserving
  private setting reads, opt-out and captured safety stops.
- Inviting a listening friend is explicit and follows existing room permissions.
  A current host can invite into its room. With no room, an explicit confirmation
  may create a paused room using eligible Audio and then invite the friend.
  Creation and invitation have separate recoverable outcomes; invitation failure
  leaves that room available. No status view creates, leaves or joins a room,
  starts playback, or sends an invitation automatically.

## Shared Playback Rooms

The initial implementation supports explicitly enabled Audio rooms in Finitude
Web. Production rollout, native room screens and shared Video playback remain
separate verification and delivery stages. Ordinary local playback and private
Playlist access retain their existing rules.

- A room supports Host control and Everyone control. Only its current host can
  change that mode while the room is open. New rooms start with Host control.
- Host control allows only the host to change shared playback. Everyone control
  allows each admitted participant, through that account's active playback
  device, to play, pause, seek, move Previous/Next, or select an existing room
  queue entry. Other devices observing the room do not gain control.
- Shared playback permission does not grant room-management permission. Changing
  the mode, inviting/removing members, choosing the initial queue, transferring
  the host role, and ending the room remain host-only operations. The initial
  selection and subsequent accepted recommendations belong to an independent
  room queue; no change mutates a member's private Playlist.
- Every admitted member can recommend eligible Audio, independently of Host or
  Everyone playback control and without taking over a playing device. Each member
  may have five pending recommendations, within a room-wide limit of 20. Repeating
  the same pending recommendation by that member does not create another copy.
- Web listeners can recommend a single Audio track from Search, Album, Library
  or the current player to their current room. Eligibility is checked before the
  action and again by the server. Pending feedback reflects the confirmed room
  recommendation; opening an action never plays, submits or changes rooms.
- Room music selection supports title search and pagination across eligible
  tracks. Initial queue selections persist across searches and pages, up to the
  existing 100-entry limit. Unsupported ordinary-playback formats remain usable
  privately and are explained before a room action.
- With no current room, an explicit song-and-friend confirmation creates a
  paused room and then invites that friend. These are separate recoverable
  commands. A changed room requires another explicit action; a failed invitation
  preserves the created room. The current queue is never left implicitly.
- An authorized active-room entry remains available across Web browsing routes
  and returns to room controls or command recovery. Its status distinguishes
  connection recovery, observing, local pause and shared playback state; merely
  opening it never resumes playback or takes over a device. Account transitions
  immediately hide the previous account's room information.
- The active host controller can accept or dismiss a recommendation, remove a
  queued entry, or reorder the queue. Members may withdraw their own pending
  recommendations. Acceptance appends one occurrence with requester attribution;
  it never starts playback. Queue edits require the observed queue and playback
  versions; concurrent stale edits do not silently overwrite the winner.
- Appending, reordering, or removing another queued entry preserves the current
  timeline, readiness preparation and each device's local pause. The current
  entry cannot be removed directly; select another entry first. A room retains
  at least one entry. Pending recommendations disappear when their member leaves
  or their media is replaced/deleted. Attribution resolves current admitted social
  profiles only and is cleared on departure; it is not historical identity data.
- Mode changes are server-confirmed and visible to every participant. They apply
  to subsequent commands; they do not undo an already accepted playback operation
  or restart the current media. Commands that rely on superseded permission state
  cannot take effect after a mode change.
- Every admitted member, including an observing device, may explicitly send a
  heart, clap, fire, smile or music reaction. Reactions are independent of playback
  permission and accept no arbitrary text. Accepted reactions are limited to 12
  per account and 60 per room per minute; reconnecting or rejoining does not reset
  the account allowance. Replaying the same command adds no reaction or quota use.
- Brief room activity shows confirmed joins, song changes, host changes, control
  mode changes and reactions. It retains at most 20 events for 30 seconds, subject
  to bounded projection size. Automatic advancement is identified as a system
  action; readiness, reconnects, rejected/noop commands and heartbeat traffic do
  not become human activity. Events never issue playback commands or change
  playback/control/queue generations by themselves.
- Activity resolves only current admitted social cards. A departing member's
  events disappear and room closure clears every event. Initial load and reconnect
  may show still-current events but never replay their announcements as new.
- Volume, mute, and an explicitly device-local pause remain personal controls in
  either mode. Shared Pause affects the room; a deliberate local pause is not
  silently undone by another participant's shared playback command.
- Concurrent Next actions based on the same current queue entry and playback
  state advance the room at most once. A losing stale action synchronizes to
  the confirmed state without automatically becoming another Next. A new
  explicit action after observing the next entry may advance again.
- Conflicting selections based on the same playback state accept at most one
  transition. The first server-accepted selection becomes the shared choice;
  the losing action refreshes without automatically overwriting it. Selecting
  again after observing the new state is a new explicit action.
- Applying shared state, retrying an already accepted action, or receiving a
  resulting player callback does not create a new shared playback action.
  Automatic advancement and explicit Next cannot both advance the same playback
  occurrence. These rules apply in both permission modes.

- While rooms are disabled, the Web room panel says listening rooms are
  temporarily unavailable instead of appearing to connect. It offers no room
  creation or reconnection and stops background reconnects until rooms are
  enabled again; leaving, ending and declining remain available.
- A refused room action names its reason: a full room, rooms at capacity
  service-wide, the host's 20 pending invitations, a current room on
  this or another device, a host-only action or one the current control mode
  does not allow, a disconnected host, a host leaving without ending the room or
  transferring the role, an ended room, an expired invitation or transfer, a song
  no longer eligible for rooms, the queue, song-request and reaction limits, and
  too many recent actions. Losing to a newer playback, queue, control or room
  version still shows the latest room state as a change made meanwhile.

- A room has at most eight members and 100 queue entries. An account joins at
  most one active room and has one playing controller. Other tabs/devices are
  observers until the user explicitly chooses Use this device. Refreshing or
  duplicating a tab cannot silently take over the existing controller.
- A deployment may set lower capacity than these maximums for open rooms, members
  per room and live room connections. Creating a room beyond the open-room limit
  says rooms are at capacity; accepting an invitation to a full room says the room
  is full and leaves the invitation pending. A tab refused a live connection says
  live updates are busy and retries automatically after a short wait. It can still
  create a room, accept an invitation and invite friends, and connects as soon as
  it has joined; playback and other room controls wait for the live connection.
  Each admitted member's first live connection is reserved, so tabs outside rooms
  and a member's extra tabs cannot lock members out of shared playback, and one
  account's tabs may hold only a share of the other connections. A tab whose room
  ended gives up its reserved connection only when no other connection is free.
  Lowering a limit never removes members or closes rooms already open.
- The host invites existing friends to a specific room. Invitations expire after
  24 hours, expose only the inviter's social card before acceptance, and require
  current friendship, capacity and block checks at admission. Removing friendship
  cancels unused invitations but preserves an already admitted membership.
  A host can have at most 20 pending invitations at a time; sending a fresh
  invitation to a friend who already has a pending one replaces it without
  using another.
- Finitude Web shows a global, silent reminder for current pending room
  invitations, including while browsing outside Together or participating in a
  different room. The indicator means an invitation still needs a response; it
  is not an unread-history count and viewing it does not dismiss the invitation.
  Accepted, declined, replaced, expired or revoked invitations cease to appear.
  Reminders add no notification sound, system notification, email or push delivery.
- The host can copy a link to an existing pending invitation for its selected
  friend. Each link identifies that invitation only and grants no access by
  possession. A recipient who is signed out can sign in and continue to the
  invitation; before acceptance only its inviter's social card and expiry are
  visible. Other accounts and unavailable invitations receive the same unavailable
  result. Sending a replacement invitation invalidates its earlier link. Finitude
  Web lets the host explicitly send a new invitation for a pending one, after a
  confirmation that the earlier link stops working. Replacing a live invitation
  adds no pending invitation, so it remains possible at the 20-invitation limit.
- Opening a reminder or invitation link never accepts it, starts playback,
  takes over another device, or leaves an existing room. Joining still requires
  an explicit action and the current admission checks. A listener already in a
  room can inspect or decline another invitation and must explicitly leave or
  end the current room before joining the other one.
- The host removes a member only after confirming; the member leaves at once and
  can be invited again later while still a friend.
- A blocked pair cannot share a room. If the blocker hosts, remove the blocked
  member; otherwise remove the blocker. Deactivation, administrator suspension
  and account deletion remove participation, ending a hosted room. These changes
  take effect atomically.
- The Web member list shows each member's role and whether they are connected,
  with readiness for connected members, and the room queue names its current
  song in text rather than by color alone.
- The host can End room for everyone or offer Transfer and leave to a connected
  participant. The selected controller must accept within 30 seconds; Finitude
  Web shows the host and that participant the time remaining to accept. Acceptance
  transfers the role and removes the old host atomically, preserving the mode,
  queue and running timeline; an in-progress preparation is cancelled and paused.
  There is no automatic host promotion.
  End room, like a guest's Leave, works from any of that account's signed-in
  tabs or devices, including one that is only observing. Inviting, removing
  members, transferring and changing the mode need the host's active playback
  device.
- Host absence is measured from the last confirmed controller heartbeat,
  with a 30-second grace period. The grace changes no shared playback: the
  current timeline, an already accepted preparation and automatic advancement
  continue, and Everyone control participants keep their playback controls. The
  absent host's disconnected device cannot change shared playback until it
  reconnects. Both control modes suspend after that grace: shared playback
  pauses and guests cannot start it again, even after the host returns. Five
  minutes of host absence ends the room. Reconnection never automatically
  resumes a suspended timeline: the host explicitly starts it; personal audio
  resumes only through explicit resync and readiness. Every room expires after
  24 hours.
- Finitude Web shows the remaining host-absence grace and, once suspended, the
  time until the room ends; the host sees the same for its own disconnected
  playing device. After the host returns, participants see that playback stays
  suspended until the host starts it. Countdowns follow the server's deadlines
  regardless of the device clock, keep counting while the participant visits
  other pages, and reaching zero changes no room state by itself: the server
  suspends, ends the room or expires the offer.
- Revoking the playing controller's session disconnects that controller and
  triggers absence handling. Revoking an observer session cannot remove another
  device's membership. Changing a password preserves a room controller on the
  retained current session; sign out everywhere and password reset remove
  participation and end a hosted room. A Web tab still open on that account
  then drops the former room and shows the signed-out state without a reload
  (see Authentication and Resolution).
- Shared playback uses the existing single player with an online representation
  pinned to the selected media version. Only finite Audio whose duration and
  seekability have been verified is eligible. Supported sources are complete
  PCM16 WAV, MP3, and single-track unencrypted AAC-LC in M4A; compressed sources
  require complete structure and decode validation. Unverified, unsupported or
  failed analysis never prevents ordinary playback and never grants room
  eligibility. Native download preference is unchanged until native room adoption
  explicitly supports the pinned-source contract.
- Administrators can explicitly analyze existing ready Audio without re-uploading
  or changing its stored bytes. Viewing the analysis list never starts work.
  Results belong to the exact source and cannot replace evidence for a changed,
  replacing or deleting source. Already eligible sources keep their identity.
  Failed, cancelled or interrupted attempts are explicitly retryable; a lost
  result is recovered using the same attempt identity rather than automatically
  submitting new work. Cancellation stops pending download and decode work;
  a database write already dispatched is reconciled and may have committed.
  Completed analysis remains durable. Unsupported input
  has a terminal result; replacing that file creates a new analysis opportunity.
- An administrator-started catalog backfill applies that same explicit analysis,
  one source at a time, to every ready published Audio source without a current
  verified result. It skips eligible, terminally unsupported and in-progress
  sources, so a repeated run only revisits sources that still lack a result, and
  it follows the same source, retry and recovery rules as analyzing one source.
- Preparing a play, seek or selection waits up to three seconds for the connected
  playing cohort. Ready participants start on the shared schedule; unready or late
  participants remain silent until their own player reports readiness for the
  exact current occurrence. If nobody is ready, playback stays paused. A slow
  participant does not repeatedly pause the whole room.
- Local pause survives subsequent room events. Resync is an explicit action.
  The Web primary playback action resumes only this device when the room is
  already playing. When the room is paused and the caller can control playback,
  that action resumes the caller's participation and starts shared playback;
  other participants' deliberate local pauses remain unchanged. Host-control
  guests can become ready locally but must wait for the host to start the room.
  Merely switching Web Audio tabs does not pause participation while the browser
  continues media execution and the authorized realtime connection stays fresh.
  Actual browser freeze/page departure or stale authority pauses the device;
  waking or reconnecting does not silently resume it or replay a shared action.
  Lost realtime authority detaches local room playback until a fresh authorized
  connection and explicit resync; periodic reads during recovery do not allow
  offline room control. A server authority change pauses the recovered timeline.
  Leaving, removal or room closure clears the room player and queue without
  restoring or resuming an earlier local queue.
- A media replacement or deletion invalidates its old room representation and
  pauses it if current. Queue positions retain their identity; unavailable items
  cannot be selected or automatically started. No room action mutates a source
  Playlist or another member's Recently Played. This initial Web room mode does
  not record room playback in Recently Played.
- Switching rooms off, directly or by switching social off, is a temporary stop.
  It removes no social identity, friendship, share or setting, and rooms already
  open do not silently continue. Shared playback in every open room pauses, no
  device can connect to a room, start shared playback, or create or join a room,
  and open rooms end through the ordinary rules while rooms stay off: suspension
  after the 30-second host-absence grace, the end after five minutes of host
  absence, or the 24-hour expiry. Leaving, ending, removal, declining, shared
  Pause and account cleanup remain available. Each device stops room playback;
  a fresh page load shows the room's current paused, suspended or ended state.
  Switching rooms back on resumes no paused or suspended room by itself. With
  only rooms off, social identity, friendships, music shares and ordinary
  listening status keep working; listening status from room playback stops.
- Room and social request allowances belong to the signed-in account, including
  how many requests may run at once. Listeners who share a network address, such
  as a household, office or campus, do not spend each other's allowance, and
  changing networks does not add to an account's allowance. Signed-out requests
  and requests with expired or revoked credentials are limited by network
  address and never spend an account's allowance. Media stream admission is not
  a room or social allowance and stays per network address.

The wire protocol and operational bounds are documented in
[the room API contract](architecture/rooms.md#implemented-audio-room-api).

## Saved Content and Library

- Users can save and unsave Albums and MediaTracks.
- `MediaTrack` is the product name for the catalog and playback identity. The
  persisted `audioTracks` collection, `audioTrack` relationship value, and
  older client DTO names remain implementation-only compatibility aliases
  during migration; they do not imply that every MediaTrack is audio.
- Saved-content state is not limited to 20 items. The 20-item limits apply only
  to the recent-activity lists described below.
- Unsaving content removes it from Recently Saved immediately.
- The iOS Library tab renders one dynamic, vertically scrolling list rather
  than administrator-configured page items.
- The Library list contains the union of every saved Album and MediaTrack and
  every device-local Album and MediaTrack download. Matching saved and
  downloaded representations are one row, keyed by canonical content type and
  ID.
- In the native Library, Albums and Songs remain additive content-type filters. Downloads is an
  availability filter that can be combined with either content type. With no
  filters selected, the complete supported Library is visible.
- Web Library is a personal overview with separate My Playlists, Saved music,
  and Recently played destinations. Its Saved music destination uses mutually
  exclusive All, Albums, and Songs filters. Search matches saved titles across
  the complete saved collection before pagination. Sorting changes only the
  current collection's order; it does not switch its source.
- Save and Unsave are the only collection preference state. There is no
  separate Like or Add-to-Library state. Saving an Album does not save its
  individual MediaTracks, and saving a MediaTrack does not save its Album.
- Web Recently played shows the existing latest 20 activity items independently
  of configured Home carousels, including unsaved content, newest first.
  Missing or non-ready content is omitted using public catalog visibility rules.
  Each row shows its actual Save state. Unsaving removes a saved row but does
  not remove a history row or a Playlist membership; clearing history does not
  unsave content. Playing content does not automatically save it.
- Web overview sections load and recover independently. A section failure
  must not be presented as an empty collection or hide other working sections.
- The Library supports Recent Activity, Recently Saved, and Recently Played
  sorting. Recent Activity uses the newest saved, played, or downloaded event.
  Items without the selected sort event follow items that have one, using a
  deterministic fallback order.
- Library play times stay consistent with Recently Played. Saving content that
  is still in Recently Played carries that play into Library sorting, including
  after an Unsave and re-save. Clearing Recently Played also removes the
  Library's play times in the same atomic change: Recently Played sorting then
  treats saved items as unplayed and Recent Activity falls back to their Save
  time. Saves, Save times, and Recently Saved are unchanged.
- Completed downloaded content displays a download checkmark in its Library
  row. In-progress, paused, failed, and corrupted content displays its actual
  state rather than the completed checkmark.
- The Save control remains visible while signed out and uses disabled styling.
  Tapping it shows a sign-in-required error alert; it does not open login
  automatically.

## Web Listener Presentation

- Finitude Web uses Spotify-aligned neutral dark surfaces with `#1ed760` as
  its interaction accent. Filled accent controls use black foreground content,
  while keyboard focus uses a distinct white outline.
- Finitude Web approximates the reference typography with a local platform
  sans-serif stack led by Helvetica Neue, Helvetica, and Arial, with explicit
  CJK and emoji fallbacks. It does not download, bundle, or hotlink Spotify's
  proprietary typefaces.
- In an Album MediaTrack list, the actively playing row uses the Web accent for
  its title and replaces the row number with animated music bars. Highlighting
  that row by pointer or keyboard replaces the bars with the Pause action;
  Reduce Motion keeps the indicator static.
- This presentation contract is Web-only. Finitude retains its own name, mark,
  artwork, copy, components, and supported capabilities; the rule does not
  authorize Spotify assets or an iOS theme change.

## User Playlists

- Authenticated listeners can create, edit, and delete their own Playlists.
  Archtree provides the shared server-backed Playlist contract used by Web and
  future iOS clients.
- A Playlist is private and owner-only. The first release has no public,
  unlisted, shared, or collaborative Playlist state, and another listener
  cannot read or infer it from its ID.
- A Playlist has one required trimmed name of 1–100 Unicode characters.
  Different Playlists owned by the same listener may have the same name.
- A Playlist contains an explicitly ordered set of MediaTracks. Albums,
  Artists, duplicate MediaTracks, folders, pinned Playlists, and smart or
  automatically populated Playlists are not part of the first release.
- A listener may own at most 100 Playlists, and each Playlist may contain at
  most 500 MediaTracks. Repeating Add for an existing MediaTrack leaves its
  existing membership and order unchanged.
- Playlist artwork is a non-persisted read projection. In persisted member
  order, it uses the first ready, playable MediaTrack that provides usable
  track-specific artwork or inherited Album artwork; unavailable members and
  members without usable artwork are skipped. Summary and detail DTOs return
  that value as `artworkUrl`, or an empty string so the client uses the
  Finitude placeholder. The first release has no custom Playlist artwork
  upload or Playlist-owned storage object.
- A listener's Playlist list is ordered by most recent update first with a
  deterministic tie-breaker. MediaTrack order inside a Playlist is manual and
  can be changed with accessible move controls.
- Desktop Web displays a New Playlist control and the signed-in listener's
  Playlist list in the left sidebar below primary navigation. The reference
  layout informs hierarchy without copying another product's branding or exact
  components.
- The desktop Web sidebar begins with primary navigation and does not render a
  separate `Your Library` heading. The Library destination and the Library
  page's own title remain available.
- On Web, Playlists are available as a Library-owned
  destination rather than as an additional primary-navigation tab. Playlists
  remain separate from the Saved/Downloaded Album and MediaTrack union and its
  filters and sorting.
- The New Playlist control remains visible while signed out. Activating it
  reports that sign-in is required and does not automatically navigate to
  login.
- Playlist playback copies the currently ready members, in persisted order,
  into the shared player queue. Starting Play records the first ready
  MediaTrack once; starting from a row records that selected MediaTrack once.
  Previous, Next, and automatic advancement do not add activity entries.
- Unavailable members retain their position in the persisted Playlist but are
  skipped by playback. Editing or deleting a Playlist does not mutate or stop
  a queue that has already started.
- Deleting a Playlist removes only that Playlist and its memberships. It does
  not unsave, delete, download, or otherwise mutate its MediaTracks or shared
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
  ready or published **public** Artist, Album, MediaTrack, configured Page item,
  Feed Post, stream, and public catalog artwork. Public visibility does not
  depend on the viewer role or the record's `createdBy` value.
- Catalog content and individual Page item placements have `public` or `hidden`
  visibility. Missing legacy values are public; malformed values fail closed.
  Hidden content is accessible only through current-administrator private
  management and preview routes. Knowing an ID or public URL does not grant
  access. Listener routes enforce the same rule for admins in User view.
- Hiding one Page placement does not hide its reusable Carousel, Grid, or List,
  another placement, or the referenced content. Hiding an Album makes assigned
  MediaTracks effectively hidden without changing their own stored visibility.
  An assigned MediaTrack whose parent Album cannot be confirmed ready/public
  is unavailable to listeners. Hidden Artist and Organization identities are
  redacted from public Credits; their visibility alone does not hide shared works.
- Discovery, details, Library, Playlist artwork, recent activity, Follow releases,
  Rooms, social shares, media, and artwork revalidate current public access.
  Private Playlists retain unavailable members without former title, artwork,
  creator, or playable links. Hidden targets cannot gain new listener references.
  Already-open online media delivery stops within one second after a confirmed
  access loss or an unresponsive authorization check. Previously delivered or
  downloaded bytes cannot be recalled.
- Visibility changes require explicit admin confirmation of the affected
  entity/placement and the current revision. Page placement review identifies
  its configured name, type and source mode, reports missing or unsupported
  references, and confirms the current and proposed visibility of that exact
  placement. Renaming or changing its source invalidates a previous approval.
  Media storage stays private, and public and private application responses
  never redirect to hidden object locations.
- On Web, admins switch between Admin and User views without signing out or rebuilding
  listening state. User view is the default; leaving Admin view hides private
  presentation, cancels private reads and stops previews. Unsaved drafts and
  unknown catalog/import operation intents may remain only in account-fenced memory and resume
  after current capabilities are verified. Account or role loss clears them.
  Device-local conversion state follows the separate durable, owner-scoped
  recovery rules below.
  View selection is presentation, not authorization.
- The iOS and Android clients provide listener experiences only. They do not
  expose an administrator view, workbench, import editor, catalog/Page editor,
  private administrator preview or administrator upload flow. An administrator
  account can still sign in and use ordinary listener features. Administration
  and local media conversion are available through the Web workbench.
- Existing catalog edits are separate from import review. They preserve unrelated
  metadata, memberships, and storage references, reject stale snapshots, and
  use the canonical Credit and artwork lifecycle. Join phrases and label
  Credits are edited through that same Credit lifecycle. Disc Number and Track
  Number changes update the assigned Album's automatic order in the same
  transaction.
- Web manual catalog confirmation shows the captured saved and proposed values
  for every field in its partial update, including visibility and coupled Credit
  attribution changes. Dates retain their known precision; an unavailable Credit
  list is distinct from an explicitly empty list. If a confirmed refresh detects
  a newer item revision, the open confirmation explains why saving is disabled
  and directs the administrator back to review. Closing it preserves unsaved
  edits; reviewing the latest saved version requires a new confirmation.
- Web administration uses a dedicated page layout for the workbench, imports,
  existing-Album reviews, catalog and Page management. Listener navigation,
  global music search, Now Playing and player controls do not appear in this
  layout. The Admin/User view switch remains reachable. Entering or leaving
  administration preserves the authenticated account, playback queue and
  position, and active Room session; returning to User view restores listener
  navigation and controls.
- The Web workbench exposes management of existing Albums and a separate catalog
  review queue. A completed import links to its confirmed catalog Album,
  Artists and label Organization for subsequent edits; it never unlocks or
  republishes its old approval.
- The Web catalog inventories present artwork and names as a single detail entry
  for Albums, Artists, MediaTracks and Organizations. Artist portraits are
  circular; Organizations use their name mark, matching listener details.
  Manual editing and applicable management actions are available from each
  administrator detail page instead of repeated inventory actions. Proofreading
  applies to Albums; local MP3 conversion applies to Albums and audio MediaTracks.
  Detail pages display current saved artwork, including supported legacy
  artwork, through protected administrator delivery and retain the dedicated
  administrator layout. Returning to the inventory retains the content category.
- Administrators may create a private proofreading project for a ready existing
  Album with at most 100 ready Audio members. Empty Albums are supported; missing,
  malformed, mixed Video, or inconsistent memberships require repair before
  creating a review. The server captures current catalog revisions and original
  filenames when retained. Missing historical filenames and folder names remain
  explicitly unknown; an Album title is not presented as a source folder.
- Existing-Album proofreading shares the durable analysis, grant, concurrency and
  provider-call limits of imports. Opening a project or editing its private draft
  never starts paid analysis. Luna suggestions do not change the catalog. An
  administrator can independently review suggestions and manually edit the
  private Album title/date and Track titles, Disc Numbers and Track Numbers,
  then explicitly select saved fields for a separate catalog confirmation. The
  ordered Artist Credits with their join phrases and the label are read-only
  review context; metadata lookup is not part of existing-Album reviews.
- Applying an existing-Album review validates every captured catalog revision,
  membership, readiness and filename/media identity. A replacement or external
  edit prevents applying the stale project, rather than silently rebasing it.
  Selected metadata changes, automatic Album order and the operation receipt
  commit atomically; retries use the original intent. Artist identity/Credits,
  artwork, visibility, membership and stored media are preserved. Artist-name
  suggestions are identity hints for a separate explicit catalog Credit edit.
  Applied reviews remain read-only; further corrections use the current Web
  catalog editor or a new Web review.
- Administrator confirmations bind the item and revision displayed when opened.
  A refresh that changes the draft, publication approval or staged file requires
  a fresh review; confirmation never silently rebases onto a newer target.
- Pending, failed, deleting, orphaned, or otherwise non-ready lifecycle data is
  not public. Private account data, including avatars, saves, activity,
  sessions, and account metadata, is not part of the public catalog.
- A public Feed Post may retain its opaque author `userId` as content
  attribution for existing clients. That reference does not make the author's
  profile, avatar, email, account metadata, or other private state public.
- Only admins can create, update, delete, upload, link, reorder, or otherwise
  mutate shared Artists, Albums, MediaTracks, Feed Posts, assets, content
  relationships, Pages, Carousels, Grids, and Lists.
- Only admins can see or access Content Manager. Hiding its navigation is not
  an authorization boundary; direct page, form, API, and upload requests must
  enforce the same administrator role before processing a mutation.
- The hosted Engineering Guide is a read-only internal resource available only
  to administrators. Its pages and supporting assets enforce that permission
  directly, and its Archtree landing-page entry is visible only to admins.
  Reading the guide grants no additional permissions and changes no account or
  catalog data. A repository-local documentation preview uses no account data.
- The Engineering Guide is available in English and Simplified Chinese. Its
  language switch preserves the current topic, and the selected language is
  retained in shareable page links. Changing the guide language does not change
  the listener's Finitude language preference.
- Admins manage the global shared catalog regardless of `createdBy`, while
  retaining that field for provenance and lifecycle auditing.
- Album primary Artist Credits are the canonical Artist-to-Album membership.
  `Artist.albumIds` remains a server-owned compatibility projection during
  migration. One Album may have more than one primary Artist.
- Adding an existing Album primary Artist Credit is idempotent. Removing it
  removes only that Credit and its compatibility membership; it does not
  delete the Album, its MediaTracks, saves, downloads, or Carousel definitions.
- Content Manager metadata and relationship mutations do not consume image or
  audio upload concurrency capacity when no file bytes are accepted by that
  endpoint. Authenticated administrator uploads to the shared catalog have no
  hourly request-count quota. Per-request and per-file size limits, batch file
  count limits, and upload concurrency bounds still apply before multipart
  decoding and storage work.
- One Content Manager bulk Audio selection may contain at most 100 files.
  The browser uploads those files sequentially as one file per request, so
  every file keeps an independent lifecycle outcome and the selected batch is
  never buffered or submitted as one aggregate media request.
- Audio MediaTrack creation persists a valid positive whole-number Track
  Number from embedded file metadata, including single and bulk uploads, and a
  valid positive whole-number Disc Number when the file carries one.
  Administrator imports and existing catalog edits may also set a Disc Number.
  Every Album membership write derives the complete persisted
  `Album.audioTrackIds` order by Disc Number, then Track Number; administrators
  cannot manually order Album MediaTracks. A missing Disc Number orders as
  disc 1, so an Album without Disc Numbers keeps its order. Missing or invalid
  Track Numbers follow numbered tracks on the same disc, and duplicate or
  missing-number ties use canonical MediaTrack ID order so request order cannot
  change the result.
- The guided Artist release workflow may create or reuse an Artist, create and
  link an Album through a primary Credit, and optionally create or reuse a
  dynamic Artist Album Carousel and attach it to a Page. A dynamic Artist
  Carousel derives membership from Credits (with a transition fallback for
  unmigrated records) and does not copy results into manual items.
- A partially completed guided release retains successfully published catalog
  content and traceable operation evidence for an idempotent retry. Failure of
  an optional Carousel or Page step does not automatically delete a published
  Artist or Album.
- Catalog attribution uses ordered, role-bearing Credits whose subject is
  either an Artist (a person or creative/performing group) or an Organization
  (such as a label, publisher, distributor, archive, broadcaster, or studio).
  An Organization is never represented as an Artist merely to satisfy content
  validation.
- A Credit may carry a short join phrase, such as `、`, `&` or `feat.` with
  any surrounding spaces, that connects its name to the next name in a byline.
  A join phrase is visible text without control or invisible formatting
  characters. Join phrases are presentation only: they never set or change a
  Credit's subject, role or order, Artist page sections, Organization
  Releases, Follow eligibility, Search or legacy projections. A name after
  `feat.` is featured only when its Credit role is featured. Public Credit
  lists, including legacy content responses, expose only allowlisted fields,
  never a join phrase or an internal Credit identifier, so join phrases reach
  listeners only through server bylines. A stored join phrase that fails
  validation is presented as `, ` and never hides the Credit list or changes
  Follow eligibility.
- Album and MediaTrack Credits are independent. A MediaTrack participant does
  not silently become an Album primary Artist. Adding a MediaTrack primary
  Artist who is not already an Album primary Artist requires an explicit
  administrator choice to keep the Credit on the MediaTrack only or also
  promote it to the Album; MediaTrack-only is the safe default.
- Album promotion itself updates the Album Credit and its compatibility
  membership atomically. If promotion fails after uploaded media was safely
  published, the MediaTrack remains valid and MediaTrack-only; Content Manager
  reports the partial outcome and offers an idempotent Credit-editor retry
  rather than deleting media or inviting a duplicate upload.
- Album primary Artist Credits derive Discography, Album featured Artist
  Credits derive Collaborations, and qualifying MediaTrack Artist Credits
  derive Appears On when no higher Album classification exists. Composer,
  producer, and remixer participation derives Credits. One Album appears once
  per subject using `Discography > Collaborations > Appears On > Credits`.
- Institutional Album Credits derive Organization Releases. An Album or
  MediaTrack may be published with only Organization Credits, or with an
  explicit `unknown` attribution state. Missing attribution never creates a
  synthetic `Unknown Artist` record and a failed lookup never silently changes
  attribution to unknown.
- Single and bulk MediaTrack creation accept Artist Credits, Organization
  Credits, inherited Album primary Credits, or an explicit undocumented
  attribution state. They never require a synthetic Artist merely to publish
  an institution-only or unattributed recording.
- During the Credit migration, legacy `AudioTrack.artistIds`,
  `Artist.albumIds`, and flattened artist-name fields remain server-owned
  compatibility projections. `Artist.albumIds` projects only Album primary
  Artist Credits; Appears On results are not inserted into that legacy field.
  Existing explicit Artist-to-Album memberships migrate as Album primary
  Credits, while ambiguous legacy MediaTrack Artist relationships migrate as
  `legacyUnspecified` rather than inventing a role.
- Dynamic Artist Carousels have an explicit `discography`, `collaborations`,
  `appearsOn`, or `allRelated` scope and default to `discography`. Legacy
  Carousels without a scope retain that default.
- Ordinary users continue to manage their own saves, Library state, Recently
  Played activity, profile/avatar, account, device-local downloads, and
  Playlists. These owner-scoped actions do not mutate the shared catalog.

## Native Home Startup and Recovery

- Finitude iOS and Android initiate a public Home load whenever Home is first
  presented after an install, update, or ordinary relaunch. Retained device or
  account storage must not suppress that load.
- The expanded Home response is the required native composition response.
  Ready content included in that response remains renderable when an auxiliary
  public catalog or Feed request used only for compatibility enrichment fails.
- Before Home has usable content, a failed or cancelled load presents a
  recoverable unavailable state rather than an empty success. Initial loading,
  unavailable, and empty states expose an explicit retry or refresh action.
- A refresh requested while an older Home load is still active must result in
  a fresh attempt. A cancelled or stale load cannot clear the loading state or
  overwrite the result of that newer attempt.
- A later refresh failure preserves already rendered Home content and reports
  the refresh failure without replacing that content with an empty page.

## Finitude Localization

- Finitude Web starts in explicit `en-US` when no valid app-language preference
  has been stored and offers only explicit published-language choices. It does
  not present browser UI or content-language detection as a reliable automatic
  choice; a legacy Browser default preference migrates to `en-US`. iOS and
  Android continue to default to System and follow the operating system's
  ordered preferred languages. A listener may choose any explicitly supported
  language. The preference survives relaunch, logout, and account changes.
- Supported language identifiers use canonical BCP 47 tags. System is the
  native presentation label for its automatic preference state, not a language
  identifier; the retired Web Browser default label is retained only in older
  client translation contracts.
- Every client release includes a complete `en-US` runtime bundle as the final
  fallback: Web packages a same-origin static JSON asset and native clients
  package `en-US.json` as an app resource. It can render the app without a
  session, remote localization request, writable cache, or prior launch. A raw
  localization key, missing-variable marker, or blank translation is never
  listener-facing fallback copy.
- Startup uses the valid last-known-good bundle for the resolved language, or
  packaged `en-US` when no such bundle exists. Every client checks for a newer
  published translation in the background on cold launch and does not block
  startup on that remote request.
- A downloaded translation becomes active only after its entire schema,
  locale, messages, and variables validate. Malformed, incomplete, stale,
  cancelled, or failed responses preserve the current readable bundle. A
  response for an older language choice cannot overwrite a newer choice.
- Changing to an uncached explicit language succeeds only after that bundle is
  downloaded and validated. A failed change preserves the prior preference and
  visible language and offers retry.
- Published locale bundles share one complete semantic-key set and the same
  named-variable contract for each key. Translatable sentences, plurals, and
  accessibility copy are complete messages rather than concatenated fragments.
- Runtime translation bundles localize Finitude interface copy. They do not
  automatically translate catalog metadata, creator or listener content, or
  replace platform-packaged text that the operating system needs before the
  app's localization runtime is available.
- Canonical locale JSON is the only manually maintained translation source.
  Each client build derives its platform-packaged iOS or Android text from the
  same reviewed catalog revision. Runtime copy may update remotely, while a
  change to operating-system-owned copy becomes visible with the next app
  release that includes regenerated native resources.
- Finitude Web listener pages keep a globe language shortcut at the bottom-left
  of the desktop sidebar, matching the persistent placement pattern used by
  Spotify. Compact listener layouts and the dedicated administration layout
  expose the same control in the top bar. Both open the same accessible selector
  for published languages. Native selectors continue to show System.
- Every published-language option shows its native name as the primary label
  and a stable English name as secondary context. Both names are maintained
  once in canonical locale metadata and published in the shared manifest so
  Web, iOS, and Android present the same reviewed language identity.

## Personalized Carousels

- Personalized carousels have one of three sources:
  - Recently Saved
  - Recently Played
  - New from artists you follow
- Albums and MediaTracks are mixed in all three carousel sources.
- Content Manager does not offer Album-only or MediaTrack-only filters for
  personalized carousels.
- Content Manager configures only the carousel name, source, and item limit.
- Personalized carousel items cannot be manually added, removed, reordered, or
  moved between carousels.
- Activity is stored by appending new entries to the end of its history, while
  carousels display the newest activity first.

## Artist Follows and New Releases

- Following an Artist is private, authenticated account state. It does not
  save the Artist to Library, affect discovery ranking, expose follower counts,
  or send email or push notifications.
- Follow and Unfollow are server-confirmed, naturally idempotent actions.
  Repeating Follow preserves the original follow time; repeating Unfollow
  confirms the unfollowed state. Follow requires a ready Artist; Unfollow
  remains possible when that Artist is unavailable.
- Follow updates transact with the active account and ready Artist. Artist
  deletion prevents new follows and removes every follow relationship before
  final metadata deletion, retaining lifecycle evidence after partial failure.
  Artist artwork cleanup retains its existing database/S3 lifecycle.
- Account deletion removes all follows transactionally. Follow ownership does
  not count as shared Catalog provenance.
- Artist pages offer Follow when the deployment reports this feature enabled.
  A signed-out listener sees the action and receives the existing sign-in
  required alert when selecting it; selecting it does not open sign-in.
  An unresolved or failed status is not presented as unfollowed. During a
  request the action is disabled, and failure preserves confirmed state with
  an explicit retry.
- Successful Follow or Unfollow refreshes that account's Home. Account exit,
  deletion, switch, or identity mismatch immediately removes private follow
  state and generated sections and invalidates pending responses. Clients
  retain no durable private follow cache or offline mutation queue.
- New from artists you follow uses only that listener's follows and the ready
  public Catalog. Content Manager chooses its name, Home position,
  and limit of 1–20 items using the existing configured Carousel order. Clients do
  not insert an unconfigured section.
- Eligible releases have a complete valid UTC calendar release date, from today
  through 89 days before today inclusive. Partial, invalid, and future dates
  are excluded. Upload, publication, and follow times do not define eligibility.
- A ready Album qualifies when it has at least one ready canonical MediaTrack
  and its own canonical Artist Credit names a followed ready Artist with role
  primary or featured. A ready MediaTrack qualifies through its own canonical
  Artist Credit with role primary, featured, or performer. Legacy unspecified,
  composer, producer, and remixer Credits do not qualify.
- A qualifying Album represents its qualifying linked MediaTracks. A qualifying
  MediaTrack remains when its Album does not independently qualify. Results
  sort by complete release date descending, Album before MediaTrack, then
  lowercase canonical content ID ascending.
- Each generated item explains the followed Artist using a ready public Artist
  ID and name. When several Artists qualify, choose primary before featured
  before performer, then Credit order, then Artist ID. The explanation is
  contextual Home data and does not change ordinary public content summaries.
- Following immediately makes all qualifying releases in the 90-day window
  eligible; there is no read/unread state or persisted release feed. Empty,
  signed-out, disabled, and unsupported-client sections are omitted while
  preserving the relative order of the other configured Home sections.
- Rollout is independent of discovery and defaults off. Disabling the feature
  hides its UI and generated Home source but preserves follow records, status
  reads, Unfollow, and deletion cleanup. Clients negotiate this Home contract
  explicitly so older clients continue receiving their existing sections.

## Recent-Activity Limits

- Each user has one Recently Saved history with at most 20 entries total across
  Albums and MediaTracks.
- Each user has one Recently Played history with at most 20 entries total across
  Albums and MediaTracks.
- Adding a 21st entry removes the oldest entry from that history.
- Repeating an activity for an existing item moves it to the newest position
  instead of creating a duplicate.
- Content that falls out of Recently Saved remains saved and can be exposed by
  a future complete Saved Library view.

## Album and MediaTrack Playback

- An Album detail page has one prominent Play button above its MediaTrack list.
  It does not show an unconditional Album-level Play Video action; media kind
  belongs to each MediaTrack.
- A populated legacy `Album.audioTrackIds` list is the canonical Album
  MediaTrack order. Missing and non-ready references do not become playable
  queue items, and reverse-linked tracks are not silently appended. Legacy
  Albums with no declared IDs may fall back to ready MediaTracks whose
  `albumId` references that Album, using a deterministic order.
- Web, iOS and Android number Album MediaTrack rows by their position in that
  canonical order across the whole Album. Listener clients receive no Disc or
  Track Number, so a multi-disc Album plays and downloads in disc order without
  disc headers or per-disc numbering.
- Album attribution is derived from its ordered, role-bearing Credits. During
  migration only, a client that receives no canonical Credits may display the
  server-maintained legacy Artist relationship as a compatibility fallback;
  it must not infer or persist Album Credits from component MediaTracks.
- MediaTrack attribution is derived from its own ordered Credits, including
  inherited Album primary Credits, with their order and join phrases,
  materialized by the server at creation time. Adding or changing a MediaTrack
  Credit later does not silently mutate Album attribution unless an
  administrator explicitly selects promotion.
- Web, iOS and Android show one server-built byline for an Album or
  MediaTrack. It names the primary, featured and performer Credits in Credit
  order; without them, the Organization Credits; otherwise every remaining
  Credit. A label therefore stays out of the byline of an Album with a
  primary, featured or performer Credit. Explicit unknown attribution shows
  that attribution is not documented.
- Each name in a byline is followed by its Credit's join phrase, or by `, `
  when none is set, and the last name has no trailing phrase. A repeated name
  appears once, at its first position. When Credits between two shown names
  are omitted because they are hidden, repeated or outside the byline's roles,
  those two names are joined by `, `, so an omitted name never leaves a stray
  or misleading separator. The server keeps each byline within 500
  characters, ending after the last whole name that fits followed by `…`.
- Surfaces that show plain Artist names instead of a server byline, such as
  Playlist rows, Web friend listening and Web music shares, keep their existing
  presentation without join phrases. Offline presentation of an earlier Album
  download keeps the byline and MediaTrack order saved with it. Finitude Web
  lists the label among an Album's Credits; showing it on iOS and Android
  Album details requires a separate product decision.
- Tapping the Album Play button starts the Album queue and adds only the Album
  to Recently Played.
- On Finitude Web, an Album card may also offer Play on hover-capable devices
  without a touch pointer. It loads the same canonical ready-only Album queue,
  starts it without leaving the current route, and follows the Album Play
  button's Recently Played policy. An Album with no playable MediaTrack starts
  nothing. A load that fails, or that does not finish within the browser's
  roughly five-second user-intent window, leaves current playback unchanged and
  is announced; it never starts playback later. A newer launch, a newer Album
  card Play, or an account change during the load abandons it silently, and an
  abandoned load never cancels another launch's Recently Played activity. While
  listening-room playback owns the player, the launch is refused and the card
  says so. Native clients need not offer an Album card Play action.
- Explicitly tapping an individual MediaTrack in an Album list adds that
  MediaTrack, but not the Album, to Recently Played.
- Using Next or Previous and automatic queue advancement inside an Album queue
  do not add MediaTracks to Recently Played and do not add the Album again.
- Playing a MediaTrack outside an Album queue adds that MediaTrack to Recently
  Played. The Album Play action consumes one entry in the shared 20-entry
  Recently Played history.
- A MediaTrack has exactly one ready media object and one active `mediaType`,
  either `audio` or `video`. Audio and Video are mutually exclusive media kinds,
  not two selectable representations of the same MediaTrack. The optional
  motion preview below is decoration derived from a Video, never a second
  playable or selectable representation.
- A Video MediaTrack may have at most one optional motion preview: a muted MP4
  with one H.264 video track whose configuration declares Baseline, Main, or
  High (8-bit 4:2:0) and no audio, at most 8.5 seconds long, 854 × 480 in both
  its displayed and encoded size, and 4 MiB. It is never a queue item, never played by the shared player, never
  downloadable or kept offline, creates no playback activity or telemetry, and
  is shown only by Finitude Web. It is public only while motion previews are
  enabled and it is bound to the exact active Video object of a ready,
  published, publicly visible MediaTrack; replacing or deleting that Video
  hides it at once, before any cleanup. The clip is prepared on the
  administrator's device; the server only validates its complete structure and
  decoding and stores it. A missing, invalid, or failed preview never changes
  the outcome of an upload, replacement, publication, or deletion of the
  MediaTrack itself.
- The MediaTrack ID, metadata, Credits, artwork, Saved state, Playlist
  memberships, queue entry, and Recently Played identity remain unchanged when
  an administrator replaces Audio with Video or Video with Audio.
- Replacement validates and uploads a new identity-bound object while the old
  object remains public, atomically promotes the new key and kind, and only then
  deletes the old object. Failed upload, promotion, cleanup, deletion, or retry
  retains exact database/S3 lifecycle evidence for reconciliation.
- A successful Audio or Video replacement automatically runs the idempotent
  publication retry for that MediaTrack, so an earlier publication failure needs
  no separate audit retry. Publication still requires a ready assigned Album,
  when there is one, and a publishable lifecycle state; the upload and
  publication outcomes are reported separately, and a failed publication never
  requires uploading the file again.
- Public metadata exposes one `mediaType` and one stream URL; a Web client may
  additionally read the motion preview of a Video at its own preview route,
  which exposes nothing else. Stream `HEAD` and
  `GET` require a ready/published database row and resolve the exact stored key
  allowed for that kind and MediaTrack ID. Pending, failed, deleting,
  delete-failed, detached, missing, wrong-kind, and orphan-only objects are not
  public.
- Legacy rows without `mediaType` are Audio unless they contain a ready video
  from the superseded optional-video prototype. That state is migration input,
  not authorization to expose two playable objects; all old objects retain
  lifecycle evidence until migration or cleanup is confirmed.
- Finitude Web listener pages automatically use their existing browse layout
  for Audio. Video automatically replaces the center workspace with a
  contain-fit theater and uses the right panel for the playback queue. Video
  offers no cover-only or audio-only mode switch.
- Audio and Video use one long-lived media element, queue, elapsed clock,
  transport, Shuffle/Repeat state, playback origin, and activity identity.
  Automatic queue advancement changes presentation from the next MediaTrack's
  kind without restarting or reporting another play.
- A Video playback failure retains the queue and exposes a recoverable playback
  error. It does not fabricate an Audio fallback because no second media object
  exists.
- Finitude Web remains streaming-only. The first iOS and Android adoptions also
  stream Video. An existing device-local Audio download does not imply a Video
  download, Video offline availability, or another representation on the same
  MediaTrack.
- When a Video MediaTrack becomes current on iOS, Finitude automatically opens
  the expanded shared-player surface and renders the Video inline. The listener
  may collapse it back to the compact player; Video has no cover-only or
  audio-only mode switch.
- The iOS Video surface renders the same shared playback state and
  transport used by its compact player, expanded player, queue, system media
  controls, and media routes. It must not create a second player or queue.
- When a Video MediaTrack becomes current on Android, Finitude automatically
  opens the expanded shared-player surface and renders the Video contain-fit.
  The listener may collapse it back to the compact player; Video has no
  cover-only or audio-only mode switch.
- Android's inline and fullscreen Video surfaces attach to the same app-owned
  Media3 player and MediaSession used by the compact player, expanded player,
  queue, elapsed clock, transport controls, and system controls. Entering or
  exiting fullscreen must not replace or restart playback.
- Native download actions remain Audio-only in the first Video release. An
  Album containing any Video MediaTrack is playable online but is not offered
  as a complete Album download.

## Web Listener

- The Web listener renders administrator-configured Carousel, Grid, and List
  Home sections in persisted order. A client limitation on another platform
  does not change the configured presentation type.
- The Web Saved music collection is the complete server-backed union of saved
  Albums and MediaTracks. My Playlists also includes empty owner-created
  Playlists, and its members need not be saved. Web is streaming-only: it provides no Download action, Download
  filter, offline state, or browser-local Finitude media lifecycle. An ordinary
  browser file download is not represented as Finitude offline content.
- The Web listener owns one long-lived media element, queue, and playback
  state. Starting playback keeps the current route visible, and navigation
  inside the listener does not replace or restart that player. Audio and Video
  MediaTracks use that same player.
- On hover-capable Web devices with a fine pointer, a Video MediaTrack card may
  show a short, muted, looping preview of that MediaTrack after a mouse rests on
  it for about half a second. A preview is decoration, not playback: it uses its
  own media element, never changes the shared player, queue, elapsed time,
  Shuffle/Repeat state, or system media controls, and never records Recently
  Played, listening status, telemetry, or social activity. Only one card
  previews at a time; leaving the card, hiding the page, or the MediaTrack
  becoming current playback stops it and releases its request. Previews are
  skipped with Reduce Motion, forced colors, Save-Data, slow connections, and
  touch or hover-less pointers, and a failed preview is not retried in that
  page session. While motion previews are enabled, the card reads only the
  MediaTrack's motion preview, loops that whole clip from its start, and a
  Video without one keeps its artwork; while they are disabled, the card reads
  the public stream, so its one request shares the listener's media delivery
  limits until the preview stops. A card that cannot tell whether previews are
  enabled shows no preview.
- A Web MediaTrack card whose MediaTrack is currently playing offers Pause in
  place of Play. Pause keeps the queue and elapsed time and adds no Recently
  Played activity. Once paused, the card's Play action launches that MediaTrack
  again under the normal standalone launch policy, matching Album track rows.
- Web Shuffle changes only the upcoming order of ready items already present in
  the current queue. Enabling it keeps the current MediaTrack, elapsed time,
  and actual playback history in place; disabling it restores canonical queue
  order for subsequent navigation. Shuffle never inserts recommendations,
  missing items, or Smart Shuffle content.
- Web Repeat cycles through Off, All, and One. Repeat All wraps the current
  playback order, including a shuffled order; Repeat One restarts the current
  MediaTrack only after natural completion, while an explicit Next or Previous
  action still navigates normally. Shuffle and Repeat mode changes do not add
  Recently Played activity.
- Web Previous restarts the current MediaTrack when at least three seconds have
  elapsed. Before that threshold it navigates to the available previous item;
  at an unavailable boundary it remains a no-op. Repeat All may make the
  opposite queue boundary available.
- Hovering or dragging the Web progress control may preview a candidate time
  without changing playback. Pointer seeking commits on release, keyboard
  seeking commits with the range control, and every committed value is clamped
  to the known MediaTrack duration.
- Entering Video fullscreen exposes browser-native controls, including seeking,
  on the same shared media element. Exiting fullscreen restores Finitude's
  custom controls and must not replace, restart, or duplicate playback state.
- The compact Web player remains anchored to the viewport bottom. Scrolling
  page content, including a wheel gesture that begins over the player, must not
  move the player or the surrounding application shell.
- The landing page is the Kashewt portfolio at kashewt.com. It lists every public
  portfolio project, including Finitude Web, to signed-out and signed-in
  visitors in the order administrators set. Public browsing does not require
  authentication, and project entries do not replace content-management or
  account actions.
- Only admins can reorder portfolio projects or switch them between public and
  hidden. A hidden project is left off the landing page only; hiding is not an
  authorization boundary, and the project's own routes keep their own access
  rules. A change made from an outdated view of the order is refused rather
  than overwriting a newer one.
- The landing page's Log in action opens a Kashewt-branded login page and
  never redirects to Finitude's login page; its Create account action opens
  Kashewt sign-up, never Finitude's. Finitude remains a separate explicit
  entry. A visitor who is already authenticated is returned to the requested
  safe destination instead of seeing another login form.
- Logging out from the landing page or Content Manager completes on the
  Kashewt site and returns to the homepage; it never redirects through a
  Finitude route. Supported browsers coordinate cookie cleanup under the
  shared session-transition lock, while the HTML fallback remains revoke-only.
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
- Web playback shortcuts are inactive in the dedicated administration layout
  and while focus is in an editable control.
  Unmodified single-character shortcuts are not used; the accessible player
  help lists the available non-character keys and every action remains
  available through visible controls.
- Public Web registration, verification-link, and password-recovery writes
  use same-origin JSON contracts and never return session credentials. Generic
  registration, verification-link, and recovery responses do not reveal
  account existence.
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
  requested MediaTrack ID. The iOS app must not request the remote stream when
  that local file is available; it uses the server stream only when no valid
  completed local asset exists.
- The iOS Library composes device-local Downloaded content even when the
  authenticated server Library is unavailable or returns `401`. Signed-out
  state suppresses protected server sections, not device-local downloads.
- A download manifest must retain the canonical content ID. An album manifest
  must retain its Album ID and the canonical ID of each component MediaTrack.
  Missing or invalid required IDs make the affected entry corrupted and
  non-playable because it cannot be reconciled safely.
- Missing non-identity metadata does not make valid downloaded audio
  unplayable. The app renders every available field, uses clear fallback text
  for missing titles or durations, and shows a warning when metadata is
  incomplete. Manage Downloads treats incomplete metadata as a clearable
  download issue while preserving the separate playable/unplayable distinction.
- Packshot artwork is non-critical. A MediaTrack uses its own cached artwork,
  inherited album artwork, or the packaged placeholder in that order; missing
  downloaded artwork never blocks playback.
- Selecting a corrupted entry explains that its required identity is missing
  and offers Delete download. The app deletes it only after the listener
  confirms the destructive action. An entry that retains a valid content ID
  may offer authenticated Retry to repair its file or metadata.
- In-progress MediaTrack and Album downloads remain recoverable and visible.
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
  its MediaTrack or Album, and unsaving content does not remove its download.
- A local audio asset may be owned by multiple device-local download entries.
  Removing one entry must not delete an asset still owned by another entry.

## Administrator Album Imports

- Imports are private, durable administrator projects. The Web workbench
  provides analyzing, awaiting review, needs attention, and completed views with
  independent upload, analysis, review, and publication state. All current admins
  may resume saved projects; ordinary users cannot read their titles or assets.
- The import editor separates Draft, Review, Files and Publish. Switching between
  these sections retains the current account's unsaved fields, selected
  suggestions and local file choices; navigation alone does not save, analyze,
  upload or publish. Source evidence and technical details remain available
  without obscuring the current values, file identities or next explicit action.
- File names and relative containing-folder names are untrusted context. Absolute
  device paths are not sent to analysis. Source bytes remain in S3; the database
  retains bounded metadata, hashes, object identities, drafts, jobs and receipts.
  Private staged uploads do not create playable catalog MediaTracks.
- Creating an import, or resuming it after reselecting its files, is the one
  approval for uploading every selected file; no file needs its own
  confirmation. The browser uploads the files sequentially as one file per
  request, so each keeps its own lifecycle outcome, progress, failure and retry.
  An upload whose outcome is unknown is retried only with its original intent,
  by the administrator who started it; only a definite refusal before the upload
  was accepted, or a failure that reconciliation confirms, may be retried as a
  new upload. Reselection resumes incomplete files matched by relative path and
  size and refuses a file whose content changed. Reopening reconciles an upload
  of unknown outcome against storage without its bytes: it becomes ready only on
  an exact identity match, and only a confirmed failure asks for the file again.
  Leaving Admin view, losing the role, or a publication that locks the import's
  sources stops the queue after the current file, and navigation never restarts
  it. Files chosen without a folder need no typed folder name, and no folder
  name is then sent to Luna or metadata lookup.
- The import draft holds the Album title, ordered Artist entries, an optional
  label, the release date and visibility, and each track's title, Disc Number
  and Track Number. Each Artist entry has a name, a role of primary or
  featured, and an optional join phrase connecting it to the next entry. Every
  primary entry precedes every featured entry, and two entries cannot share a
  name compared case-insensitively. A role changes only by an administrator
  edit, an accepted suggestion or applied metadata lookup values; editing a join
  phrase never changes it. An empty label adds no label Credit, and unknown Disc
  and Track Numbers stay empty.
- Each draft value is either automatic, written from file tags or metadata
  lookup and not yet reviewed, or the administrator's own: typed, accepted,
  included in a publication approval or, for the label, carrying an explicit
  identity decision. The Artist entries count as one value, which becomes the
  administrator's own once any entry carries an explicit identity decision.
  Automation writes only empty or automatic values, and only while a value is
  still the one it last saw. An administrator save writes only the values that
  administrator changed: it always wins over automation for those values, is
  never refused merely because automation wrote other values meanwhile, and
  never erases automatic values it did not change, so nothing is rebased.
  Automatic text is normalized and trimmed like typed text; a value with control
  or invisible formatting characters, or over a length limit, is left out and
  shown, never stripped or truncated. Automatic writes do not use the import's
  ordinary editing allowance. The summary and the publication confirmation mark
  Artist and label entries that rest only on file tags.
- A confirmed upload keeps bounded, cleaned evidence from the file's embedded
  tags: title, Album, artist and album artist, label, year, Disc and Track
  Numbers, duration, and identifiers such as a barcode, catalogue number, ISRC
  or MusicBrainz release ID, each kept only when it matches its format. Once a
  file's upload is confirmed, its empty or automatic track title, Disc Number
  and Track Number are filled from its tags; without a disc tag, a disc folder
  or prefix in its relative path, such as `Disc 2` or `CD2`, may supply the Disc
  Number. Once every selected file is confirmed, the empty or automatic Album
  title, year, label and one primary Artist entry from the album artist are
  filled in one step from the values all files share; a value on which files
  disagree stays empty. Placeholder artists such as Various Artists or Unknown
  Artist never become Artist entries, and a company-like artist name is flagged
  as a possible label.
- A project saved before Artist entries, labels and Disc Numbers existed opens
  with its Artist name as one primary entry, no label and unknown Disc
  Numbers. Its existing values count as the administrator's own, and its staged
  files contribute no newly read tags. Its saved Artist decision applies to that
  entry while the name is unchanged. A pending Artist-name suggestion becomes a
  one-entry Artist suggestion that can still be rejected; accepting it after the
  entries changed reports a conflict instead of replacing them. This conversion
  alone never starts analysis or metadata lookup. A save from an editor that
  predates these fields is refused with a reload request and never removes
  Artist entries, the label or Disc Numbers.
- An approval made before these fields existed keeps its frozen snapshot. It
  commits that snapshot unchanged while its captured revisions still verify;
  otherwise it becomes needs attention without minting identities or changing
  catalog content. Saved duplicate decisions and open existing-Album reviews
  captured earlier may need one fresh review and are never silently rebased.
  Retrying an import creation with its original operation intent still
  resolves to the original project.
- Luna proposes supported draft values with source evidence; metadata lookup
  applies values as described in Administrator Metadata Lookup. Unknown facts
  stay empty and partial release dates retain their precision. Analysis never
  publishes, edits existing catalog records, or silently overwrites manual draft
  changes, and metadata lookup likewise never does. Administrators see
  baseline/current/proposed values and can accept or reject individual
  suggestions; a suggestion that equals the current value is resolved
  automatically. Adoption changes only the saved private draft.
- Accepted analysis runs on the server after a browser closes or changes page.
  Reopening observes existing status and results; it does not start another
  paid generation. Local file transfer may require reselection of incomplete
  files. Explicit Stop analysis is separate from leaving the page.
- Analysis uses finite per-project and global concurrency/call budgets, durable
  checkpoints and expiring administrator grants. Permission loss prevents new
  steps. An ambiguous potentially paid provider outcome is retained and blocks
  automatic paid replay; administrators may continue manual review.
  The deployment-wide daily allowance resets at UTC midnight; budget exhaustion
  becomes needs attention without dispatching another provider request.
- Name matches, identical bytes, external identifiers and matching durations are
  candidates, not proof of Artist or Organization identity, Album edition, or
  recording identity. Candidates load automatically, matching names
  case-insensitively. Unless the import appends to an existing Album, each draft
  Artist entry and any label need their own decision, and two entries cannot
  reuse one Artist. A decision binds its entry and that entry's name: reordering
  the entry or changing its role or join phrase keeps it, while renaming or
  removing the entry or the label clears it. Applying a replacement Artist list
  keeps decisions only for unchanged entries. A decision that this section
  preselects needs no explicit answer, even when other candidates are shown;
  otherwise administrators explicitly choose reuse, skip, append missing
  members, or create a distinct entry. Luna never chooses or preselects an
  identity. No automatic merge, deletion of catalog content, catalog media or
  uploaded source audio, media replacement, or reassignment of a Track to a
  different Album is permitted. Unhashed historical assets remain unverified.
- For each Artist entry and the label, create is preselected when no candidate
  exists. Each preselected create is rechecked when approved and when published.
  At approval, a new name candidate requires a fresh review. A publication that
  finds such a candidate becomes needs attention without minting identities, and
  cancelling it permits a fresh review.
- The Album is preselected as create when no Album name candidate exists, and
  that create is rechecked like a preselected Artist create. An Album name
  candidate is shown as a possible duplicate Album that needs an explicit
  choice. A ready MediaTrack on another Album whose bytes match a staged file is
  flagged as a possible duplicate and never collapsed, but it needs no answer by
  itself. The Tracks of a new Album are preselected as create, since a Track
  never moves to another Album. When appending, a file whose bytes match a
  MediaTrack on that Album is preselected as reuse, a name-only match needs an
  explicit choice, and a file with no candidate is preselected as a new member.
- A new Album's cover is chosen automatically only while the administrator has
  made no cover choice; an explicit choice, including No cover, always wins. A
  single embedded image shared by every track is selected, re-evaluated whenever
  the file set changes while the cover choice is automatic. Embedded images are
  validated and completely decoded like other covers and staged under the same
  staged-upload lifecycle; identical ones are staged once, and each import
  stages a bounded number of them. While the cover choice is automatic, any
  Album decision other than create deselects every automatic cover. Unless it is
  selected or a publication uses or locks it, an automatically staged cover
  candidate is cleaned up automatically through the existing cleanup lifecycle
  once the import completes. A cleaned-up candidate's record remains until
  deletion is confirmed, a retry uses the original intent, and a failure becomes
  needs attention.
- Publishing a new Album requires at least one primary Artist entry, and
  appending requires a target Album that has a primary Artist Credit. It creates
  the Album's Credits in draft order: each Artist entry as an Album primary or
  featured Artist Credit with its join phrase, then the label as an Album Credit
  with role `label` whose subject is an Organization. A new label Organization
  has the label type and a reused one keeps its own; the label is never an
  Artist or a plain text field. The MediaTracks of a new Album receive its
  ordered primary Artist Credits with their join phrases; featured entries and
  the label stay on the Album. New Artists and Organizations take the draft's
  visibility. Imports do not yet support an Album without a primary Artist, such
  as a compilation, and never suggest a stand-in Artist for one.
- After uploads and metadata lookup, an import opens on one Review and publish
  summary. It shows the draft values, the Artist entries with their roles and
  join phrases, the label, the disc and track order, identity decisions, the
  cover, upload progress and visibility, which defaults to public and can be
  changed in place. Rows that need no answer are collapsed; values resting on
  file tags or Luna are flagged and never collapsed. Only a choice among tied
  matching groups, a conflict with the administrator's own value or an identity
  candidate that is not preselected needs an answer. Publish stays unavailable
  until each is answered and while any upload, lookup, value application or
  analysis is queued or running. When the files or the applied release credit
  only a placeholder such as Various Artists and a new Album has no primary
  Artist entry, the summary says at once that the import cannot be published
  yet. The Draft, Review, Files and Publish sections remain available for manual
  work.
- The publication confirmation lists everything that becomes catalog content:
  the title, the ordered Artist entries with their roles and join phrases, the
  label, the date, the full disc and track list with titles, the cover, the
  visibility, and each new or reused Artist, Organization and Album, with each
  reused record that is hidden marked. Approving it saves the shown draft,
  identity decisions, cover choice and answers to Luna suggestions and freezes
  the approval as one step bound to exactly what was shown; a failed approval
  leaves at most the saved draft, never a partial approval.
- Publication is a separate explicit approval of the reviewed draft and duplicate
  decisions. It freezes the approval snapshot, rechecks current role, revisions,
  memberships, visibility and asset readiness, and reports confirmed per-item
  outcomes. New objects and catalog records remain traceable through every
  upload/copy, partial failure, retry, cleanup and reconciliation step. Unknown
  outcomes never discard the sole lifecycle evidence or mint new identities
  silently. Successful catalog publication and its receipt commit together.
- A current administrator may explicitly cancel an unconfirmed import
  publication after its active worker lease ends, including when the original
  approval has expired or its initiating administrator lost permission.
  Cancellation binds the original approval, never changes existing catalog
  content and cannot undo a completed publication. Unused copied files remain
  traceable until exact cleanup is confirmed; unknown outcomes are not treated
  as successful cleanup. Administrators may edit and review the private draft
  during cancelled cleanup, while source changes, analysis and a new publication
  approval remain blocked. Confirmed cleanup permits a newly reviewed approval
  with independent identities and retains the cancelled approval's recovery
  history. Each import admits at most sixteen publication approvals; reaching
  that bound does not prevent reviewing the private draft, cancelling and
  cleaning existing work, or starting a new import of the same files.
- Required cleanup and cancellation remain available when the ordinary editing
  allowance is exhausted. Repeated recovery uses the original intent and cannot
  silently restart a destructive step or lose lifecycle evidence.
- Publishing an import that reuses an existing Artist, Organization or Album
  does not overwrite that entity's metadata, artwork, Credits or visibility.
  Corrections require a separate existing-catalog edit. Appending preserves all
  current members and only adds approved missing members. It never changes the
  Album's own values or Credits: the draft's Album values, cover, Artist entries
  and label are shown as not applied and need no identity decision or conflict
  answer, and appending creates no Artist or Organization. Appended MediaTracks
  receive that Album's primary Artist Credits, in its order and with its join
  phrases, and join its automatic order by their Disc and Track Numbers, as the
  confirmation shows. A hidden Album continues to hide its Tracks until its own
  visibility changes; a newly created hidden Artist or Organization is not
  exposed by publishing a private import.
- An unconfirmed existing-catalog cover approval may be explicitly cancelled by
  a current administrator after its active worker lease ends. Cancellation leaves
  the saved cover unchanged and retains the unused object's identity and source
  pin until cleanup is confirmed. It permits a new reviewed approval without
  silently rebasing the old one. Attached cover changes require a separate clear
  or replacement; cancellation cannot undo them.
- Expiring grants prevent new copy/attachment/publication steps. Cleanup of a
  confirmed detached or explicitly cancelled object remains recoverable after
  grant expiry, with current administrator checks and exact storage identity.

## Administrator Metadata Lookup

- Metadata lookup serves the administrator's personal, non-commercial library,
  whose audio comes only from the administrator's own files. The Web import
  editor looks up metadata for those files by name. It runs automatically once
  the upload of every selected audio file is confirmed, from the album and
  album-artist tags the files share or, for a one-file import, its title and
  artist tags, and it runs when the administrator submits an Album or song name.
  Without usable tags, it runs once from the selected folder's name, when there
  is one, which the name box shows for editing. Typing, saving and navigation
  never run metadata lookup, and reopening a project runs it only when its
  reconciliation confirms the last selected upload. Existing-Album reviews, iOS
  and Android do not offer it.
- Metadata lookup accepts names, not links. The server queries only fixed,
  server-chosen services and never fetches an administrator-supplied URL. It
  sends only the submitted text, cleaned tag text or a cleaned folder name,
  terms taken from earlier results of the same lookup, and embedded identifiers;
  every identifier or barcode used in a query must match its expected format. An
  automatic lookup never sends file names, sends a folder name only when no
  usable tags exist, and no lookup sends account data or audio. The server
  follows no link found in a lookup response. Metadata lookup never downloads
  audio, audio previews or streams from any service, and audio-preview and store
  links are discarded before results are stored. The lookup box is not listener
  Search: it keeps no search history and does not restore global music search to
  the administration layout.
- Metadata lookup uses these sources in order:
  - MusicBrainz is the primary source.
  - Deezer, Spotify and other services are not used.
- Metadata lookup responses are untrusted data. Each source is bounded in time
  and size, and its request-rate and concurrency bounds apply across the whole
  deployment; automatic lookups wait for them, and a submitted lookup that
  reaches them is reported as busy rather than sent in a burst. Every response
  is completely validated before use, and its text follows the rules for
  automatic draft values in Administrator Album Imports.
- A failed, timed-out, rate-limited or unavailable source is reported as
  unavailable, never as no match, and the remaining sources still run. A
  busy or unavailable source is retried automatically a limited number of times
  within a bounded period, then reported as unavailable with a manual retry. A
  candidate whose details could not be fetched is shown as incomplete and
  unranked rather than as non-matching. Metadata lookup never uses Luna's paid
  budget and is never required: its failure does not block manual editing,
  uploads, Luna analysis or review, and Publish waits for it only while it is
  queued, running or retried automatically.
- Candidates are releases; a song-name query finds releases that contain that
  song. Metadata lookup ranks candidates by how closely their track count,
  disc count and per-track durations agree with the import's selected audio
  files. A candidate matches only when every selected file's duration is known
  and the track count, every duration within a small tolerance and any known
  disc count agree. Unknown local durations or Disc Numbers are disclosed rather
  than counted as agreement, and newly known durations re-rank stored candidates
  without new requests.
- Ranking is evidence, not proof. Every matching candidate scores the same.
  Matching candidates that would write identical draft values form one group,
  represented by a deterministically chosen member that prefers front artwork;
  the others stay in evidence. Metadata lookup preselects the matching candidate
  that an embedded identifier shared by every file matches alone, and otherwise
  the only matching group. A preselection whose credited artist agrees with no
  non-empty artist tag of the files is flagged and never collapsed. A
  preselection is a proposal that the publication approval confirms. An
  incomplete or unranked candidate is never preselected. When several matching
  groups remain, the administrator chooses one from a view of the values that
  differ and each candidate's barcode, catalogue number, country and medium.
  Without a matching candidate nothing is preselected and no choice is needed.
  Every candidate stays selectable, one that does not match shows its
  differences, and the administrator may choose none.
- Applying a candidate, automatically when it is preselected or when the
  administrator chooses it, writes all its supported values in one step: the
  Album title, Artist entries, label and date, and each matched file's track
  title, Disc Number and Track Number. It fills only empty or automatic values.
  Where the administrator's own value differs, the summary shows both with
  nothing preselected, and publication waits until the administrator keeps one.
  Each applied value keeps its source evidence, such as the MusicBrainz release
  ID and the match basis, and each track value names its local file. Applying
  another candidate replaces the values the earlier one wrote that are still
  automatic, and choosing none returns them to their values from file tags or
  leaves them empty. Applying stores its complete set of values or nothing, and
  retrying the same intent is idempotent. Placeholder credits such as Various
  Artists or [unknown], and a [no label] label, are never written.
- Metadata lookup runs on the server and finishes after the browser closes or
  changes page; reopening shows its result without running it again. It runs
  under an expiring grant from the administrator's import creation, uploads,
  reopening that confirms the last selected upload, submission, manual retry or
  choice of a candidate, and every stored step rechecks the current
  administrator role and binds the file set it ranked. A role loss or an expired
  grant stores nothing and ends that lookup and its value application: the
  summary reports it as stopped, with a manual retry as the next step and Luna
  beside it, and Publish never waits for it. A changed file set runs one
  automatic lookup again, within a small per-project limit, and replacing,
  removing or reselecting a file marks its match evidence stale without
  reverting values. Metadata lookup is independent of Luna generations: starting
  or stopping Luna does not discard its results, and a lookup does not discard
  Luna's.
- Applied Artist entries keep the release's credited names, name order and join
  phrases. The entry after a featuring phrase such as `feat.`, and every later
  entry, is featured and the others are primary; the summary and the publication
  confirmation show each role, and the administrator can still change it. Only
  this proposal reads a featuring phrase; a stored or edited join phrase never
  sets a role. The label is the release's first listed label, and any others
  stay evidence. The Album date is the release group's first-release date at its
  known precision; the release's own date stays evidence and is used only when
  the group has none. Romanized or alternate titles enter the catalog only as
  draft values and never become Search aliases. Release and recording
  identifiers remain private import evidence.
- When metadata lookup finds no release or no matching release, or cannot run
  because no usable tags, folder name or submitted name exist, the summary
  offers Luna analysis as the next step beside the name box. When lookup is
  unavailable or busy, the next step is the free retry and Luna is a secondary
  choice until the automatic retries are exhausted; Luna is then offered as the
  next step beside the manual retry. Luna remains an explicitly confirmed paid
  step that shows the remaining project and daily budget; offering it starts
  nothing, a lookup result never starts it, and it may also run beside applied
  lookup values. Luna suggestions return to the summary labelled as Luna and are
  never collapsed: those for empty values or values from file tags arrive
  ticked, the others arrive unticked and keep the current value unless ticked,
  unticking rejects one, and none is applied until the administrator accepts it
  or approves the publication with it ticked. Luna receives the current draft
  values whatever their source. Luna never chooses an identity, selects a
  release or presents its values as lookup evidence.
- Metadata lookup results and evidence are bounded private project data that
  only current administrators can read.

## Web Administrator Local MP3 Conversion

- The Web workbench supports explicit device-local conversion of lossless FLAC
  and PCM WAVE sources to high-quality MP3. Uploaded source bytes are downloaded
  through authenticated private media routes before conversion; encoding never
  runs on the server. Actual container, codec and complete decodability determine
  eligibility, not a filename or MIME declaration. Unsupported or corrupt inputs
  are identified individually and never produce a completed result.
  Browsers without the required device-local storage explain that conversion is
  unavailable and cannot create new conversion tasks.
- The first quality preset is 320 kbps CBR. Mono and stereo retain their channel
  counts; unsupported channel layouts require an explicit alternative rather
  than silent downmixing. Supported 44.1/48 kHz sources retain their sample rate;
  other supported rates use a disclosed resampling policy. Conversion does not
  apply automatic loudness changes or alter catalog attribution.
- Administrators can convert newly selected files or the current sources of an
  existing Album. One Album action creates a fixed ordered batch with independent
  per-track progress, failure, retry and completion. Repeating the same action
  reuses the matching device task. Later Album members are not silently added.
- Local lossless originals remain read-only and are never deleted by conversion,
  upload or MP3-cache cleanup. A local copy fetched from an uploaded source also
  remains a retained source rather than disposable MP3 cache. Users can manage
  application-owned retained source copies explicitly; external original files
  are never removed by Finitude.
- Conversion jobs, validated sources and generated MP3 files persist on the
  current device under the initiating account. Only a currently authenticated
  administrator for that account can run, inspect or upload these private jobs.
  Leaving Admin view, signing out or losing permission stops new work and hides
  private presentation. Durable state never contains credentials or signed URLs.
  Browser permission to protect storage from eviction is optional. An unanswered,
  denied or unavailable permission request does not block task creation while
  local storage and quota remain available; browser eviction or site-data removal
  can still remove device-local files.
- Closing the page or terminating its process does not promise continued
  encoding. Reopening offers recovery after current authorization and source
  checks. Completed validated tracks are reused; a partially encoded track is
  restarted from its retained complete source. Compatible validated partial
  source downloads may resume; bytes from different sources are never combined.
- Conversion and upload are separate approvals. Upload freezes each destination,
  source version, output identity and quality preset. Existing Audio replacement
  preserves the MediaTrack identity and its relationships, follows the canonical
  new-object promotion and old-object cleanup lifecycle, and updates actual MP3
  format and duration. New Album imports still require their own review and
  publication approval.
- An interrupted or uncertain upload retains its original operation identity and
  local MP3. Recovery first reconciles that operation; it does not blindly create
  another replacement or re-encode a completed file. An Album reports partial
  success without retrying already confirmed tracks.
- A generated local MP3 is disposable cache only after the exact output is
  confirmed on S3 and the destination is ready. Unconfirmed upload, failed
  publication or an unknown result never triggers local MP3 deletion. Cleanup
  failure remains visible and retryable, and never removes the retained lossless
  source. This administrator cache is not Web listener offline content.

## Page Items

- Page items use a discriminated contract with three supported presentation
  types: Carousel, Grid, and List.
- Each newly written Page item has a persisted identity that does not change
  when administrators reorder the Page. Legacy references without that field
  use their unique referenced Carousel or Grid/List definition ID until the
  next Page mutation backfills persisted item identities.
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
- A server-backed manual Grid or List is read through its parent Page item with
  a bounded opaque cursor. The cursor is bound to the Page item, collection,
  Page, collection, and ready-content visibility revisions, and—when the parent
  is Library—the authenticated viewer. A cursor cannot be replayed across
  viewers or Page items; malformed, stale, reordered, detached, reconfigured,
  or lifecycle-changed snapshots fail explicitly instead of restarting silently
  or returning a position-dependent slice.
- Server Grid/List pages preserve deterministic configured order and include
  only allowlisted, database-confirmed ready content. If any referenced content
  changes between ready and non-ready during a traversal, the cursor becomes
  stale and the client restarts from the first page. Device-local Downloaded
  sources are rejected by the server pagination surface and must be resolved
  from the device store.
- Outside the unified iOS Library, a Grid always presents its source as a grid.
  A List always presents its source as a vertical list. One page-item type does
  not change into another layout in response to filtering.
- A List is a single-column, vertically scrolling collection. Each row has a
  leading square packshot, a primary title, and a secondary metadata line that
  identifies the content type and available creator or artist attribution.
- List metadata omits unavailable components without leaving stray separators.
  Missing titles use explicit fallback text, while accessibility exposes the
  complete available title even when visible text is truncated.
- The full List row is the primary action target. A MediaTrack row starts the
  shared player and an Album row opens Album details; auxiliary controls must
  not create an overlapping primary tap target.
- A List exposes its active sort above the rows and defaults device-local
  Downloaded content to newest download first. Changing sort resets pagination
  and applies a deterministic tie-breaker.
- Download progress and warning state overlay the row’s packshot without
  changing row alignment or displacing title and metadata text.

## MediaTrack Artwork

- Public catalog artwork is readable only while its lifecycle record is ready
  and its Artist, Album, or MediaTrack owner still references that exact image.
  Private avatars, incomplete assets, and detached replacement assets are not
  public even when an image ID is known.
- Finitude Web may request fixed, versioned display-size variants derived from
  the canonical cover-art object. These variants are transient responses, do
  not create additional S3 objects or ownership records, and never replace the
  canonical asset used by native clients and reconciliation.
- Public catalog artwork responses require origin revalidation before cached
  bytes are reused, so detaching an image prevents subsequent public reads.
- A MediaTrack uses its own cover art when one is explicitly assigned.
- Otherwise, a linked MediaTrack inherits its Album's cover art for display
  without copying Album asset ownership into the MediaTrack record.
- A MediaTrack with neither track-specific nor Album artwork uses the client
  placeholder.
- Artist artwork is not used as an implicit MediaTrack fallback because a MediaTrack can
  reference multiple artists.

## Profile Identity and Avatars

- Signed-out account entry points display a neutral person placeholder and the
  Log in label. Content artwork is never used as a user-avatar fallback.
- A signed-in listener without an avatar displays deterministic initials from
  the authoritative display name, then email, with a neutral placeholder when
  neither value is available.
- A profile avatar is optional, belongs only to its authenticated account, and
  is not reused as Artist, Album, or MediaTrack artwork.
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
  submission, Search displays grouped Artist, Album, and MediaTrack results and
  does not display a Recent Content section.
- On Finitude Web at tablet and desktop widths (768 px and wider), typing in the
  shell search field on any route other than Search keeps the current route and
  shows inline suggestions instead of opening Search: recent searches for an
  empty field, otherwise a Search-for option followed by a bounded preview of
  the grouped results. Draft-driven suggestions never add or reorder search
  history. Submitting without a highlighted suggestion opens Search for the
  query; the search button always opens Search for the query, and editing the
  field clears any highlight. Choosing the Search-for option or any result is
  an explicit selection and records the current normalized query; choosing a
  recent search re-runs that historical query and moves it to the newest
  position. Artist, Album, and Organization results open their details and
  MediaTrack results use the shared playback queue. Narrower widths keep
  opening the Search route, which remains the full-results destination and the
  mobile Search tab; resizing alone never opens Search or records history.
- On Finitude Web, the Search page may filter its grouped results by type. The
  filter is presentation only, resets for each query, falls back to all groups
  when its group disappears, and never changes the request or search history.
- Artist results open Artist details, Album results open Album details, and MediaTrack results use the shared playback queue.
- On native clients with device-local download support, valid downloaded Albums
  and MediaTracks may be shown when the server search endpoint is unavailable;
  those results are visibly marked as downloaded content. Finitude Web has no
  device-local downloaded-content fallback.
- Voice search is not part of the initial Search release and requires a separate product decision.

## Authentication and Resolution

- Accounts are Kashewt accounts, shared by Finitude, Naruto Mobile, and other
  Kashewt projects. Kashewt has its own Web pages for sign-up, registration
  links, verification links, and password recovery, outside any one app.
  Authentication emails are Kashewt-branded, and every link in them opens a
  Kashewt page.
- Finitude has no account pages of its own for these steps. Finitude Web's
  Log in links to Kashewt sign-up and password recovery, and its
  verification guidance links to the Kashewt verification page. Older
  Finitude addresses for these pages, including links in emails sent before
  the move, open the matching Kashewt page, and an emailed link still works
  there.
- Email registration is available only on the Web. The Finitude apps do not
  offer an email sign-up form. Their Create Account button opens Kashewt
  sign-up in the browser, and they keep Apple and Google sign-in.
- Web sign-up asks only for an email address and always answers with the same
  "check your email" response.
  - When the address has no account, or only an unverified record left by the
    earlier code-based sign-up, the email contains a single-use registration
    link that expires after 30 minutes.
  - When the address already has an account, the email says so and links to
    Log in and password reset, and nothing is created or changed.
- Opening a registration link shows the address and asks for a display name
  and password. Submitting creates the account with its email already
  verified, and the listener then logs in with the new password on the Web or
  in an app.
  - A registration link works once, and completing registration voids every
    other registration link for that address.
  - An invalid, expired or used link changes nothing.
- Credentials are chosen only after the inbox owner opens the link.
  Registering an address first therefore never gives anyone control of the
  account the inbox owner creates.
- Unverified records left by the earlier code-based sign-up are not deleted or
  expired automatically. They cannot sign in, open sessions, or link Apple,
  Google or passkey methods.
  - When the inbox owner completes registration for that address, the old
    record is replaced completely. Its password, name, sessions, provider
    identities, passkeys and pending passkey enrollments are removed, and the
    account becomes verified with the new credentials.
  - Apple or Google sign-in whose provider-verified email matches such a
    record replaces it the same way and creates the provider account.
- Every account must have a verified email. An account counts as verified when
  its email was proven through a registration link, a verification link or a
  completed password reset, or when one of its linked Apple or Google
  identities carries that same email as provider-verified. Accounts created
  before email verification existed are otherwise unverified.
- Unverified accounts cannot open new sessions with any sign-in method, and
  cannot link Apple, Google or passkey methods. Sessions, refresh tokens and
  browser cookies that existed before this rule remain valid until they end or
  are revoked.
- Signing in with a valid credential for an unverified account fails with a
  distinct verification-required result and sends an email. The result is the
  same whether or not an email was sent.
  - For an account created before verification existed, the email contains a
    verification link that expires after 30 minutes. Opening it and selecting
    Verify email verifies the address without changing the password or ending
    other sessions, and the listener then signs in again.
  - For an unverified record from the earlier code-based sign-up, the email
    contains a registration link instead, so whoever set that record's
    password never gains the verified account.
- On the Web, a listener can request a new verification link by email address.
  The response does not reveal whether the address needs verification.
- Completing a password reset revokes every active session for that account
  and proves ownership of the inbox.
  - On an account that was not yet verified, the reset also verifies the email
    and removes every provider identity, passkey and pending passkey enrollment
    that existed before the reset.
  - Password recovery for an unverified record from the earlier code-based
    sign-up sends a registration link instead of a reset code.
- A password-reset code is voided by its fifth wrong submission, and the user
  must request a new code.
- The earlier app and Web endpoints for code-based registration, verification
  and verification resend no longer change anything. They tell the user to
  create the account on the Web.
- Registration, verification-link and password-recovery requests do not reveal
  whether an email address belongs to an account, neither through their
  content and latency nor through rate or concurrency limiting.
  - Each address receives at most three registration links, already-registered
    notices or verification links per 15 minutes.
  - Further requests receive the same response without another email.
- Registration, verification-link and password-recovery requests for an
  address whose domain cannot receive email, for example a mistyped or
  nonexistent domain, are rejected with a message asking the listener to check
  the address.
  - Whether a domain can receive email is public information that does not
    depend on any account, so the rejection is the same whether or not the
    address belongs to an account, and responses still never reveal account
    existence.
  - A rejected request sends no email and issues no link or code, so a
    password-reset code the listener already holds stays valid. It does not
    count toward the address's email limits, but limits per network address
    still apply.
  - When the domain cannot be checked, the request proceeds normally.
- On the Web, sign-up, verification-link and password-recovery forms show
  such a rejection on the email field. After an accepted request they show the
  exact address it used and offer to start over with a different address.
  Asking again repeats the check, so a resend to such an address is rejected
  again and sends nothing.
  - While the listener types, a domain that looks like a misspelling of a
    popular email provider gets a suggested correction. The suggestion changes
    the address only when the listener selects it.
- Authentication emails (registration links, already-registered notices,
  verification links and password-reset codes) are never sent to an address
  whose domain cannot receive email. This also covers the email sent after a
  sign-in for an unverified account, whose response stays the same, and a
  domain that could not be checked when the request arrived. Such a skipped
  email issues no link or code and still counts toward the address's email
  limits.
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
- Each refresh rotates the session's refresh token, and a session has exactly
  one current refresh token at any time, including when the previous and
  current tokens are used concurrently. A listener whose refresh response was
  lost is not signed out: for about 60 seconds after a rotation, presenting the
  immediately previous token rotates the same session again and returns a
  fresh pair, and the pair from the lost response stops working. Replays do not
  extend that window. Older tokens, or the previous token after the window,
  are rejected with `401` and leave the session unchanged. Revoked or expired
  sessions cannot be recovered this way.
- Token refresh is rate limited separately from sign-in, so failed sign-ins
  do not block a valid refresh and refreshing does not consume sign-in
  attempts. Native refresh is limited per presented refresh token, so other
  listeners sharing a network address do not spend its budget. Sign-in limits
  are unchanged.
- Listeners can view and revoke active sessions, sign out everywhere, and
  delete their account in-app.
- Active-session UI uses familiar device and browser descriptions and never
  presents raw User-Agent or networking-version strings as device names.
- Authenticated listeners can set or change a password. Changing credentials
  preserves the current session and revokes every other active session.
- Apple or Google can be unlinked only when another password, provider, or
  passkey method remains available for account recovery.
- Listeners can clear Recently Played activity without removing saved albums
  or MediaTracks. Clearing also removes those plays from Library sorting.
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
- A request to an optional-authentication page that presents a Bearer
  credential which fails verification, such as an expired, revoked, or
  malformed access token, receives `401` so native clients refresh their
  session instead of silently receiving anonymous content. Requests without
  credentials remain anonymous.
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
- When a browser session ends elsewhere, for example through sign out
  everywhere or a password reset on another device, a tab still showing that
  account signs out as soon as one of its requests finds, under the shared
  session-transition lock, that no browser session remains. It reconciles
  without a reload, notifies the other tabs and changes no cookies. A response
  that cannot prove the session ended, such as a rate-limited or unavailable
  refresh, keeps the account. A late response for an account this tab has
  already left cannot sign out the account that replaced it.
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
- Backend requests validate that referenced Albums and MediaTracks exist and
  match the declared content type.
- Deleted content is removed from saved and recent-activity references and is
  also omitted defensively during carousel resolution.

## Naruto Mobile private analysis proxy

- Naruto Mobile collection, Chrome access, raw records, cache, and reports remain
  on the user's computer. Archtree receives only the bounded,
  de-identified classification fields required by the versioned protocol.
- The hosted Naruto Web entry uses a Chrome extension for collection in the
  user's own signed-in browser. The server does not run Chrome, collect Bilibili
  cookies, or store raw collection data, local tasks, caches, or reports.
- Naruto Web requires no EXE. The existing Windows EXE remains available with
  its existing collection, analysis, and export behavior.
- Browser-local tasks retain recoverable progress when the Web page closes.
  Reopening the page restores the last committed browser-local checkpoint and
  offers an explicit resume; interrupted analysis reuses saved results without
  silently discarding collected records. Users can
  explicitly export local data and reports in desktop-compatible formats.
  Browser site-data removal deletes those local records, so the Web explains
  this boundary and offers investigation ZIP backups.
- Transient browser analysis transport failures use bounded retries while
  preserving completed local results. Exhausted detail retries leave the
  investigation recoverable and offer explicit resume from saved results.
  Cancellation and account transitions never retry work under another account.
- The browser collector scrolls to trigger public comment loading and waits for
  lazily mounted comments. An unreadable or still-loading comment area remains
  pending for explicit retry; it must not silently become a completed title-only
  source. A rendered explicit empty state may complete the source, including a
  visible zero-comment count paired with a loaded end-of-comments state. An end
  marker alone is insufficient. On the first
  explicit resume after this recovery change, an older live investigation retries
  saved sources with only creator/title evidence once, preserving every saved
  record, pending source, deduplication identity, and elapsed collection time.
- Browser collection and login checks open their tool tabs in a separate, newly
  created normal Chrome window without requesting focus. Each collection uses
  one such window for its parallel tabs and creates its own tab group named
  `火影调查` inside it. The user's existing window, active tab, and groups are
  not adopted, moved, or selected by the collector.
- When background comments remain unreadable, the browser collector may activate
  its own investigation tab inside the separate collection window for one
  bounded retry. These retries run one at a time and never request window focus.
  It restores the previous selection inside that window only if the user has
  not changed it. Paused or expired work does not start queued retries.
- The browser collector never adopts other groups or pre-existing user tabs.
  Pause, completion, and recovery manage only individually owned tabs whose
  navigation is still owned; user-added or repurposed tabs remain open.
  An empty collection window closes naturally after its last owned tab closes;
  a window containing user-added or repurposed tabs stays open. Closing the
  collection window interrupts collection without falling back to a user window.
  A platform-added tracking query or trailing slash on the same canonical
  content does not relinquish ownership. Another content identity or changed
  tab-group/window placement does.
- The proxy is not an OpenAI-compatible pass-through. The server fixes the
  model, prompts, schemas, reasoning level, output ceiling, provider endpoint,
  and Responses `store: false`; client attempts to add fields or select capabilities fail.
- Initial screening uses GPT-6 Luna through Decisions. Detailed analysis uses
  GPT-6 Luna through Responses at medium reasoning. Screening discards only
  non-product feedback with both decision and category confidence/probability
  at least 0.95. Refused or uncertain answers proceed to detailed analysis;
  both desktop and browser clients retain comments when screening fails.
- Detail prompt version `naruto-opinion-v4` retains the complete supporting
  judgment, cause, comparison, or impact in verbatim evidence. A topic with both
  favorable and unfavorable judgments uses mixed sentiment and evidence for
  both sides.
- The OpenAI key is server-only runtime configuration. It is never returned to
  the desktop app, browser, logs, database, report, or packaged EXE.
- Every authenticated Archtree account can use the proxy. The Windows app uses
  the existing access/refresh session contract, encrypts that session with
  operating-system secure storage, and never stores the account password. No
  Naruto-specific account, invitation, token, or allowlist record is created.
- Naruto Web uses the existing shared HttpOnly browser session and displayed
  account identity fence. The page and extension never persist an Archtree
  password or Bearer credential. Account transitions immediately hide the old
  account and prevent late analysis responses from adopting a replacement
  account's identity. Desktop and Web requests share the analysis capacity.
- Bearer authentication runs before the classifier body parser. Request bodies,
  comments, model output, authorization headers, and session tokens are not
  logged or stored by the proxy.
- Browser classification requires exact same-origin proof, cookie authentication,
  and the current displayed account identity before the bounded body parser.
  The desktop analysis API remains Bearer-only and rejects browser origins.

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
- The browser audio-storage audit explains the recommended action for each
  discrepancy and exposes only explicit, administrator-confirmed remediation.
  Generating or refreshing the report remains read-only.
- Motion preview objects keep the same traceability: an upload records a
  leased pending state before its never-reused key is written, an unknown
  write outcome is resolved only through the exact object version, and
  replacing, removing, or retiring a preview keeps the detached object as
  cleanup evidence until its exact version is deleted. Recovery fences the
  pending record before deleting its object, so a late write from that upload
  can no longer publish it. MediaTrack deletion waits for a live preview
  upload, resolves an expired upload's unknown outcome itself through the
  exact object identified on its never-reused key (refusing only when that
  object cannot be identified), and removes every recorded preview object
  before the final metadata; it never depends on the preview rollout. Once
  deletion begins, no preview operation changes the MediaTrack's preview
  record. The audit reports orphaned, missing, incomplete, stale, and invalid
  preview evidence; administrators recover a MediaTrack's unfinished preview
  work explicitly. Preview evidence of a MediaTrack whose deletion has begun is
  recovered only by retrying that deletion, never reported as stale preview
  work.
- An administrator may delete one exact S3-only audio object from the audit.
  The server revalidates the exact key immediately before deletion and refuses
  the action if any MediaTrack lifecycle field references the raw key or the
  object is no longer confirmed as orphaned. Repeating an action after the
  object is already absent is idempotent. A failed or uncertain S3 response is
  retained as an unresolved reconciliation outcome, never confirmed deletion.
- A MongoDB-only MediaTrack is never described as having a deletable S3
  object. Its recommended choices are to upload a replacement file from the
  MediaTrack workspace or use the normal MediaTrack deletion lifecycle to
  remove the record and its references. Storage-ready publication failures may
  use the existing idempotent publication retry without re-uploading.
- An administrator may remove one exact MongoDB-only MediaTrack from the audit.
  The server re-runs reconciliation, matches both the MediaTrack ID and expected
  S3 key, and fences the normal MediaTrack deletion lifecycle against a
  concurrent upload or storage-identity change. A successful action removes
  catalog references before final metadata; failures retain lifecycle evidence,
  and repeating an action after the record is absent is idempotent.
