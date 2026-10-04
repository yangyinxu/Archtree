# Social and shared playback implementation plan

Created and reviewed: 2026-09-13. Scope and stage statuses refreshed: 2026-10-04.
Scope: design and incrementally deliver social features and shared playback for
Archtree and Finitude. Accepted product behavior is canonical in
[business-rules.md](../business-rules.md) (Social Identity and Friendships,
Direct Music Shares, Friend Listening Status and Shared Playback Rooms); the
architecture is maintained in
[architecture.md](../architecture.md#social-and-shared-playback-architecture-proposed).
This plan sequences the work and records verification boundaries. Production
steps and their completion are tracked in
[deployment-todos.md](../deployment-todos.md#web-only-audio-social-launch).

## Release scope

**Release 1, the current target, is Web-only Audio social.** Product decision
recorded on 2026-10-04: the first release ships Finitude Web only, behind the
default-off `FINITUDE_SOCIAL_ENABLED` and `FINITUDE_ROOMS_ENABLED` flags, to the
single t4g.micro Elastic Beanstalk instance with the free-tier MongoDB Atlas
cluster, in the same `main` merge as email verification. It contains:

- opt-in social identity, exact-handle lookup, friend requests, removal,
  blocking, discovery opt-out and deactivation;
- Direct Music Shares of a ready track or Album with a current friend;
- opt-in Friend Listening Status for ordinary and room Audio;
- Audio rooms with Host or Everyone control, an independent room queue with
  title search, member song recommendations, reactions and brief activity,
  invitations with copyable recipient-bound links and a global silent reminder,
  room entry from the catalog and player, host transfer and End room;
- a rooms-off wind-down, operational signals and conservative deployment
  capacity (one open room, two members and ten realtime sockets).

**Deferred beyond Release 1:** native iOS and Android social and rooms (Stage 5,
which now also holds the remaining native Stage 1 evidence), shared Video
(Stage 6), and the later scope in the Stage 1 decision table. Native clients
keep their DEBUG-only feasibility adapters until Stage 5.

Release 1 may stay enabled for every Web account only after all of these pass:

1. Stages 2 to 4 are Complete. The hardening changes from the 2026-10-04 social
   gap review must be merged with passing checks or explicitly deferred in
   business-rules.md. They cover Web rollout-switch gating, accurate errors,
   safety and management actions and their tests, host-absence alignment and
   countdowns, accessibility, per-account room limits, live social updates
   without rooms, and handle policy and reporting.
2. The release workflow passes for the merged-main candidate.
3. The deployment checklist is complete through the kill-switch rehearsal and
   evidence record (Stage 7).

Scope history: the plan began with identity, friendships and rooms. On
2026-09-14, `67308a8` added song recommendations, Direct Music Shares, reactions
and Friend Listening Status, `7b2a17e` added global invitation reminders and
recipient links, and `43bf327` connected the catalog and player to rooms. These
changes updated business-rules.md but not this plan until 2026-10-04.
`ae17686` (2026-10-01) hardened sustained playback. The 2026-10-04 deployment
changes added WebSocket upgrade forwarding, FFmpeg on Elastic Beanstalk with a
catalog backfill, the rooms-off wind-down, operational signals and capacity
limits.

## Local Web demonstration checkpoint (2026-09-13)

**Status: Complete**

The September 13 goal was a complete local two-account Chrome Audio
demonstration through the real product UI, database, WebSocket and existing
player. The initial visible-tab demonstration missed ordinary tab switching and
personal playback recovery. This checkpoint was reopened and the following
stages are now complete:

- Audio visibility and execution suspension — Complete: hidden Audio follows fresh
  authorized room state. Freeze/pagehide invalidates the transport; wakeup checks
  monotonic and wall-clock freshness and preserves explicit personal pause.
- Explicit playback recovery — Complete: the primary action resumes only this
  device when the room is playing, or resumes participation and starts shared
  playback when authorized. The caller's heartbeat acknowledgement precedes Play;
  original preconditions remain fixed and stale/cancelled gestures cannot rebase.
  Host-control guests can ready themselves while waiting for the host.
- Transaction contention recovery — Complete: confirmed aborted transactions use
  bounded jittered backoff; unknown commits retain exact command identity without
  automatic replay. Real MongoDB tests cover contention, exhaustion and commit loss.
- Ordinary-browser acceptance — Complete: real hidden Chromium tabs keep Audio
  playing and follow shared Pause/Play. Actual freeze/resume reconnects but remains
  locally paused until one explicit primary action. The complete two-account flow
  covers both permission modes, concurrent Next/selection, observer takeover,
  host transfer, End, and the existing accessibility blocker policy.

Validation at the initial September 13 checkpoint:

- `npm test`: 442 backend and 386 Web tests passed.
- `npm run build`: passed with unchanged asset budgets.
- `npm run test:integration`: 345 tests passed, none skipped.
- `npm run test:e2e --workspace @archtree/finitude-web -- room-playback-feasibility.spec.ts playback-continuity.spec.ts`:
  nine real-player cases passed across Chromium, Firefox and WebKit.
- `npm run test:e2e:social --workspace @archtree/finitude-web`: the full real
  MongoDB/storage/WebSocket browser flow passed, including actual tab hiding and
  freezing. `npm run typecheck:e2e --workspace @archtree/finitude-web` passed.
- Manual Chrome verification used fresh synthetic accounts on the final built
  application, real media and the normal product UI. One Resume and play for
  everyone click restarted both players. The retained room is in Everyone control
  with both primary Play buttons enabled and both media elements ready.
- Localization generation/native fallback synchronization and `git diff --check`
  passed. Native fallbacks changed without native room UI or playback changes.

The local demonstration uses only disposable MongoDB/storage resources and
synthetic accounts/music via `npm run demo:social`; no production data or rollout
is involved. The plan remains for the Release 1 gates above and the deferred
native and Video stages.

## Stage 0 — Repository baseline and architecture

**Status: Complete**

- Inspected canonical privacy, account deletion, Feed, Playlist, and Audio/Video
  rules, backend models/routes/services, deployment boundaries and all three
  client player seams.
- Cross-reviewed timing, recovery, privacy and client feasibility. Defined a
  complete-state protocol, immediate committed-state fanout with outbox recovery,
  media version/duration prerequisites and incremental scaling boundaries.
- Recorded recommendations separately from active product contracts; no runtime
  behavior, dependency, infrastructure or private data changes.

## Stage 1 — Transport feasibility, product contract, and fixtures

**Status: Complete**

Complete for the Release 1 Web scope. Implementation began with a
transport-independent arbitration prototype, shared synthetic fixtures and
isolated Web/iOS/Android adapter work. Web integrates its adapter with production
room routes and the frozen `roomV1.ts` contract. When native adoption was
deferred beyond Release 1 on 2026-10-04, the native remainder of this stage
(physical-device evidence, the shared native wire-fixture corpus and the
lifecycle matrix) moved to Stage 5 as its entry gate. Native adapters remain
DEBUG-only until then.

Historical prototype implementation and local review:

- Strict provisional snapshot/command validation, complete allowlisted queue
  identity, pure concurrent-command arbitration, both control modes and bounded
  in-memory deduplication in Archtree. No route or durable writer is enabled.
- Web factory-injected adapter over its existing media element, with absolute
  state application separated from permission-checked user/system intents,
  stale-state rejection, cancellation, local pause, seek readiness and bounded
  correction. The room controller stays out of the production bundle.
- iOS DEBUG-only `RoomPlaybackSession` over `AudioManager`/AVPlayer, with source
  and account fences, cancellable seek/start/correction, detached ownership,
  explicit local pause and no callback-generated commands or room history writes.
- Android DEBUG-only `RoomPlaybackAdapter` over the existing ExoPlayer, with
  PlayerView and MediaSession sharing a mode-aware facade, generation-fenced
  observations, one executable room item, and rate/seek fallback.
- One byte-identical synthetic trace across the three repositories. Native
  changes are reviewed and integrated locally (`fd81728` iOS, `4ad1a3b` Android).

Verification on 2026-09-13:

| Surface | Local evidence | Remaining boundary |
| --- | --- | --- |
| Archtree | `npm test`: 404 backend tests (including 14 arbitration tests) and 305 Web tests passed; `npm run build` passed | In-memory ordering does not prove MongoDB transactions, authorization or recovery |
| Web | 18 room unit tests, 6 real-media cases across Chromium/Firefox/WebKit, 3 ordinary playback-continuity cases; typecheck and bundle budgets pass | DOM callbacks have no original playback generation; native fullscreen provenance and real output alignment remain unproved |
| iOS | Final 257 unit tests, including 20 room tests and real synthetic AVPlayer cases; earlier full run passed 250 unit and 22 UI tests; all units rerun after review fixes | Physical devices, authenticated streams, cross-device timing, Video and background participation remain unproved |
| Android | 137 JVM tests, 6 real ExoPlayer/MediaController emulator tests, build and lint with zero errors | Foreground/manual detach only; no readiness acknowledgement, background service or physical-device timing proof |

The initial full Archtree run exposed stale local dependencies (missing
`cross-env` and an older `qs`). `npm ci` restored the lockfile versions without
changing dependencies or the lockfile; verification was rerun afterward. The
dedicated Android test emulator used a read-only disposable overlay and has been
shut down. No production account, database, media object or deployment changed.

The social identity/relationship and initial Audio room contracts are now frozen
in `src/contracts/socialV1.ts` and `src/contracts/roomV1.ts`, with active product
rules promoted alongside implementation. Web integrates viewer authorization,
controller admission, clock calibration, revision-pinned media and persisted
readiness. The native prototypes still consume normalized trusted test inputs.
The remaining native lifecycle/capability fixture adoption and target-device
evidence is Stage 5's entry gate, described below for reference.

Complete the remaining native technical spike evidence against synthetic
room state and real test media before native room adoption. These
player gates do not block the independent identity/relationship backend. Prove
the existing player can prepare/seek, report actual start, apply
scheduled state, suppress autonomous advancement, intercept system/fullscreen
and browse-launch controls, and preserve deliberate local pause. Check rate
correction/fallback and background/foreground behavior on each platform; the
current Android app does not declare a playback service. Do not infer background
execution from MediaSession alone or silently add that product scope.

The spike uses the existing player with test-only wiring and no production social
writes or broadcasts. Physical-device unavailability may leave a device gate open,
but cannot count as a successful capability. Define foreground support as the
baseline and graceful background detach/resync when continuous execution has not
been demonstrated.

The frozen Web contracts define DTOs, errors, encoded-size bounds, mutation scopes, version
semantics, preparation protocol, numeric duration/seekability, revision-pinned
streaming and synthetic fixtures. Use one corpus across all clients. Update
business rules alongside the implementation of each new behavior. The streaming
preference in room mode is a proposed exception to the existing local-download
preference. The feasibility wiring uses synthetic media and does not change
ordinary playback's source preference.

| Decision | Recommended starting point |
| --- | --- |
| Social model | Opt-in alias/handle, mutually accepted friends; private Artist Follow stays independent |
| Visibility | Opt-in authenticated exact-handle lookup reveals a minimal alias card; profile access requires an allowed relationship; private avatar/activity stay private |
| First release — decided 2026-10-04 | Web-only Audio behind the social and rooms flags: identity and friends, Direct Music Shares, opt-in Friend Listening Status and rooms; native social and rooms deferred (Stage 5) |
| Room size | Product maximum of eight members and 100 queue entries; the Elastic Beanstalk deployment ships one open room, two members and ten realtime sockets until measured |
| Invitations | Account-targeted, 24-hour invitations to current friends; copyable recipient-bound links grant no access by possession; a global silent reminder while pending |
| Shared playback permission — agreed | Host control or Everyone control; only the current host changes mode; admitted active controllers follow the confirmed setting |
| Management permission | Invitations, kick, queue edits, accepting recommendations, permission changes, transfer and End room remain host-only; transfer acceptance belongs to the selected target |
| Initial mode | Host control by default; a host can enable Everyone while the room is open |
| Queue | Independent room queue from the host's selection plus accepted member recommendations (five pending per member, 20 per room); no collaborative Playlist; room Repeat/Shuffle off |
| Concurrent Next | One transition for actions based on the same entry/playback generation; no stale-command rebase or replay; a fresh action on the new entry can advance again |
| Presence | Room presence and brief activity visible only to admitted members; no global online or last-seen status. Outside rooms, only the opt-in Friend Listening Status shows current Audio to current friends |
| Direct shares | A ready track or Album to a current friend; private Received/Sent lists for 30 days; never auto-plays, saves or joins |
| Reactions | Fixed reactions without text, rate-limited per account and room; no chat |
| Notifications | In-app only: no push, email, sound or system notification |
| Rollout flags | Only the social and rooms flags for Release 1; switching rooms off pauses and winds down open rooms; shared Video adds its own flag |
| Account/device | One active room and playing controller per account; observers neither play nor control; observer logout does not end the room |
| Block | No blocked pair in one room; host blocker removes target, other blocker leaves |
| Host exit | Explicit Transfer and leave with recipient acceptance, or End room for everyone; transfer keeps mode/queue/running playback; pending preparation pauses |
| Host failure | 30-second grace, then enforced suspension in both modes; five-minute absence closes the room; no automatic promotion or resume |
| Slow client | Preparation ends early when ready, capped at three seconds; proceed with ready participants or stay paused if none is ready; host-controller presence is required, host-player readiness is not |
| History | Initial Web room playback does not write Recently Played; future history requires explicit local intent and actual start |
| Room exit | Detach control and clear the room queue without restoring/resuming the previous queue; browse playback cannot silently replace room playback |
| Native source | Proposed room-only online-stream exception for Stage 5; ordinary playback still prefers valid Audio downloads |
| Opt-out | Discovery off preserves friends; social deactivation removes access/relationships but retains private blocks |
| Retention/limits | Social limits and 30-day deleted-handle reservation are implemented; rooms/invitations expire after 24 hours and room participation is cleaned before aggregate TTL |
| Later scope | Native social and rooms (Stage 5); Video after device QA (Stage 6); user posts, chat, voice/camera, public rooms and push/email notifications separately |

**Exit gate (met for Web):** Web feasibility evidence, reviewed product
decisions and the frozen social and room contracts exist. The three-client
part of the original gate (native feasibility evidence, unsupported-capability
paths, exact shared fixtures and the lifecycle matrix) is Stage 5's entry gate.
Clock or player limitations found there feed back into a versioned protocol
change. Shared contract edits remain centrally coordinated; independent client
spikes may run in parallel with non-overlapping file ownership.

## Stage 2 — Social identity, relationships, and safety foundation

**Status: Complete**

Depends on Stage 1's social identity/relationship contract; the independent
player device gates do not block this backend-only stage. Implement opt-in
discovery/profile lifecycle, friendship
requests, block/unblock and scoped in-app outcomes. Add verified unique indexes,
transactional caps, immutable expiring mutation scopes, receipts, outbox and
account deletion cleanup before enabling writes. If deletion becomes asynchronous,
extend account/auth/private, avatar and shared-provenance writer fences before
using a deleting state; initial deletion preconditions must remain true throughout.
Room invitations and membership transactions belong entirely to Stage 3; there
is no partially working room invitation UI in this stage.

Implementation uses the existing synchronous account-deletion transaction, with
bounded relationships and receipts. No new deleting-account state or S3 lifecycle
is introduced. Handles are immutable while owned and reserved without their former
owner identifier for 30 days after account deletion. Pair revisions use durable
account-held clocks, so
purging an expired pair tombstone cannot revive a stale acceptance. One payload-free
outbox row per account coalesces invalidations; realtime delivery remains Stage 3.
`FINITUDE_SOCIAL_ENABLED` defaults to false in every environment. Safety and outcome
routes remain available when admission is disabled. Frozen synthetic wire vectors
are in `contracts/social/v1/identity-and-relationships.json`; native social UI and
DTO adoption remain later stages.

Verification on 2026-09-13:

- `npm test`: 425 backend and 305 Web tests passed.
- `npm run build`: passed, including frontend bundle budgets.
- `npm run test:integration`: all 268 tests passed against isolated local MongoDB
  replica sets, including 38 social lifecycle, 11 social account cleanup and 8
  real HTTP/auth cases.
- After fixing block queries to use the required account index,
  `node --import tsx --test test/socialLifecycle.integration.ts` passed all 39
  cases. The added actual-query profiler check examined one document and one
  index key for both block listing and capacity with 1,000 unrelated edges.
  `npm test` and `npm run build` were also rerun successfully after this fix.
- `npm run test:e2e --workspace @archtree/finitude-web -- session-recovery.spec.ts playback-continuity.spec.ts`:
  all 12 cases passed across Chromium, Firefox and WebKit.
- `git diff --check`: passed. No dependency, native client or deployed data changes.

These gates covered the social backend at that checkpoint. Production
verification belongs to Stage 7 and native client adoption to Stage 5; durable
rooms and realtime are Stage 3.

The 2026-09-14 Release 1 additions extend this foundation without reopening it:
Direct Music Shares and opt-in Friend Listening Status have their own limits,
publisher fencing, lifecycle and account cleanup, covered by
`test/musicShareLifecycle.integration.ts` and
`test/listeningLifecycle.integration.ts`. Their Web flows belong to Stage 4.

**Exit gate:** cross-account/guessing tests, request-accept/block/deactivate/delete
races, unknown commits, scope expiry after receipt deletion and notification
privacy pass. A delayed outcome cannot restore revoked visibility or friendship.

## Stage 3 — Durable rooms, pinned media, and realtime recovery

**Status: In progress**

Implemented and covered by local MongoDB and WebSocket integration tests,
including authority lease takeover, the rooms-off wind-down and seat admission.
The stage stays in progress until the authorization, limit and safety-rule tests
from the 2026-10-04 gap review are merged with passing integration tests.
Restart, lease takeover and drain on the actual Elastic Beanstalk instance are
verified under Stage 7.

The user authorized continuing through a complete Chrome demonstration on
2026-09-13. That delivery boundary included Stage 3 and the actual Web
product flow in Stage 4: two synthetic accounts, friendship, invitation/join,
real Audio playback, both control modes, concurrent controls and host transfer/end.
It does not substitute an API debug page for the product. Work is split between
media lifecycle, durable rooms and Web integration, with shared contracts,
realtime transport, verification and demonstration coordinated centrally.

Depends on Stage 2 and frozen protocol. Implement the backend as three bounded
increments, each verified before enabling the next:

1. Numeric duration/seekability and opaque media revision on exact stored
   representations; bounded legacy backfill, version-pinned HEAD/GET/Range, and
   normal publication/deletion invalidation. Unknown media stays ineligible for
   rooms without losing ordinary catalog visibility.
2. Room aggregate, recipient-bound invitations, membership generations,
   controller takeover, playback control mode/generation, scoped host transfer
   offers, participation cleanup, scope receipts and deny-only safety mutations;
   add the fenced singleton authority for overlapping deploys. Serialize permission
   changes, transfer/acceptance and member commands against the same aggregate.
3. Session-bound ticket bootstrap, acknowledged subscriptions, bounded complete
   snapshots (including full active preparation and recipient controller state),
   immediate after-commit fanout/outbox repair, version heartbeat,
   preparation generations, adaptive anchors, clock sampling, drain and recovery.
   Preserve original expected entry/playback/queue/control versions through
   database callback retries; do not refresh an old Next into a new intent.

The read-only implementation audit before Stage 3 identified these seams, all
now implemented:

- All Audio/Video uploads and replacements converge at `uploadMediaObject` in
  `audioStorageService.ts`. Reserve analysis with pending storage and promote
  revision, duration, eligibility and private S3 validators atomically with the
  active representation. Metadata-only edits and cleanup retries preserve it.
- Metadata duration and HTTP byte ranges do not establish seekability. Add a
  bounded finite-file/seek-structure probe and actual client seek readiness;
  unknown analysis preserves ordinary playback but cannot admit a room entry.
  Elastic Beanstalk now provisions a pinned FFmpeg through a prebuild hook, and
  an operator-run catalog backfill analyzes existing Audio (see README).
- Extend the unified MediaTrack HEAD/GET route with a strict optional revision
  fence and recorded object validators. Pin GET after HEAD, including If-Range
  fallback; preserve the versionless path and legacy Audio aliases.
- Extract reusable active-session/account fences and status-only receipt execution
  before adding room transactions. Block, deactivation and account deletion must
  enlist graph and room cleanup in one transaction. Timer work needs a distinct
  authority-backed system context, not an impersonated user session.
- Connect the common session-revocation boundary and server drain lifecycle before
  admitting room controllers or upgraded sockets. Keep account invalidations and
  room aggregate outbox state explicit and separately recoverable.

**Exit gate:** two protocol clients converge after duplicate/coalesced/dropped
snapshots, HTTP/WebSocket response inversion, commit-before-fanout crash,
reconnect, unsupported version, kick/block, session revocation, account deletion,
media replacement and overlapping-process restart. Stale readiness/end timers
cannot operate on a new playback generation. No pre-admission room-data leak,
revision-mixed media responses, stale authority commit or double advancement.
Prove distinct concurrent Next IDs based on the same state produce one transition,
including when the driver reruns the losing transaction callback.

## Stage 4 — Audio room vertical slice on Web

**Status: In progress**

Finitude Web implements the Release 1 flows: identity and friends, Direct Music
Shares, Friend Listening Status, room creation from a song and friend, member
song recommendations, reactions and brief activity, global invitation reminders
and recipient links, room entry from the catalog and player, and room music
search. The nine isolated social browser scenarios
(`npm run test:e2e:social --workspace @archtree/finitude-web`) run in the
release workflow. Remaining for Release 1: the Web hardening from the 2026-10-04
gap review (rollout-switch gating, accurate errors, safety and management actions
with confirmations and tests, host-absence and transfer countdowns with the
plan's host-absence and logout E2E cases, and accessibility), then a passing
release workflow for the candidate. No staging environment exists, so latency
segments and same-NAT behavior are measured during the controlled production
enablement in Stage 7.

Depends on Stage 3. Integrate room mode with the existing player, browse-launch
helpers and all system/transport controls. Build friend discovery/request controls,
invite/join/readiness/shared controls/leave/resync UI and in-app outcomes, including
deactivate/block paths. Add the host-only mode selector and visible current mode,
distinct local/shared Pause, transfer offer/acceptance and explicit End room flow.
Add localization and accessible status announcements.
Keep user-intent submission separate from absolute snapshot application and
asynchronous player observations. Applying a remote or own acknowledged snapshot
must produce zero new shared commands, including through native-control adapters.
Start with two operator-owned test accounts and measure each latency segment
before increasing seats. Permitted actions show pending feedback immediately;
successful commit is not displayed as proof that every participant is playing.

**Exit gate:** real streaming and autoplay evidence in the supported browser
matrix; one player/queue; no feedback-loop commands, phantom activity or old
account state. Verify preparation cancellation, late joins, deliberate guest
pause, permission switch during a seek gesture, concurrent member commands,
host transfer/loss in both modes, buffering, same-NAT limits, fallback polling
and local recovery. A guest cannot bypass host-absence suspension with Play.

## Stage 5 — Native social and Audio room adoption

**Status: Not started**

Deferred beyond Release 1 (decided 2026-10-04); it does not block the Web
release. Entry gate: the native remainder of Stage 1, meaning physical-device
player evidence on each platform, a shared wire-fixture corpus for rooms, music
shares and listening status (only identity and relationships have one today),
and the lifecycle matrix. The room API currently requires a current Web account
viewer and the realtime upgrade a same-host `Origin`, so native rooms need an
agreed contract extension first. iOS invitation links also need the Associated
Domains entitlement in deployment-todos.md. The Finitude iOS architecture
document already records that native social is absent; the Android parity matrix
(`Finitude_Android/docs/parity.md`) still needs a Not started social row.

Depends on Stage 4's stable protocol and the entry gate above. iOS and Android
may implement independently against frozen shared fixtures, with backend and
shared-contract changes coordinated centrally. Start with the native social core
(identity, handle lookup, friendships and blocking, the mutation-scope protocol,
Direct Music Shares and Friend Listening Status), then add the complete room
entry/exit flow, both control modes and host-only management, controller-session
handling, transfer/exit outcomes and the agreed room streaming exception.
Exercise physical-device interruptions, background socket loss, output-route
changes, system controls, account transitions and return-to-foreground resync.

**Exit gate:** Web/iOS/Android agree on queue and timeline; unsupported background
or rate-control capabilities are explicit. No native autonomous advancement or
local download can silently replace the authoritative room representation.
Record unavailable physical-device gates as skipped, never passed.

## Stage 6 — Video capability

**Status: Not started**

Deferred beyond Release 1. Shared Video ships behind its own rollout flag.
Depends on the Audio slice and the client platforms selected for Video release;
it does not block a verified Audio rollout. Reuse the same protocol with explicit
negotiated Video capability. Incompatible controllers cannot become ready for a
Video entry; selection is rejected for a room whose admitted playing controllers
lack support. A reconnect/takeover revalidates capabilities before enabling play.

Verify actual Video buffering, seek, fullscreen/system controls, Audio-to-Video
and Video-to-Audio transitions, revision replacement and graceful recovery.
Remain streaming-only for Video; do not infer offline Video from Audio downloads.

**Exit gate:** mixed-client real-media and physical-device evidence covers every
enabled platform; UI readiness matches actual playback capability. Video can be
disabled without breaking approved Audio rooms or leaving unsupported queues.

## Stage 7 — Capacity, staged rollout, and rollback

**Status: In progress**

Release 1 deployment support is in the repository. The HTTPS Nginx server
forwards WebSocket upgrades, a prebuild hook installs a pinned, digest-verified
FFmpeg, and an operator backfill analyzes existing Audio. A process started with
rooms off pauses and winds down open rooms, and operational signals and
conservative capacity limits are in place (details below and in the
[social rollout runbook](../deployment/social-rollout-runbook.md)). Nothing has
been deployed or enabled yet.

There is no staging environment; the integrated release plan's staging stage is
Blocked. Decided on 2026-10-04: Release 1 relies on CI and local evidence, a
production deployment with both flags off, and then a controlled production
enablement with operator-owned test accounts. Latency segments, same-NAT
behavior, capacity, a redeploy with a room open and the kill switch are measured
or rehearsed during that enablement, before the flags stay on. The steps and
their completion are tracked in
[deployment-todos.md](../deployment-todos.md#web-only-audio-social-launch).

The separate local sustained-room gate now supplies bounded aggregate resource
and real-media evidence for 2–8 members, explicit reload recovery, repeated shared
controls, and owned fixture cleanup. Commands and evidence limits are in the
README and Web release matrix. This starts local capacity verification; the
actual deployment, degraded network, production-equivalent S3, staged rollout,
and rollback exit gates below remain pending.

Finitude Web honors the staged-rollout switches: the public listener capabilities
carry `social: { enabled, rooms }`, flags-off pages offer no social entry point and
send no social request, and a `social_disabled`/`rooms_disabled` refusal refreshes
them while open. The listener Chromium gate covers flags off, social without rooms
and a refusal while open; production rollout and rollback rehearsal remain pending.

All local browser contexts share one source IP. Playback GET admission now waits
within a bounded two-second queue without raising active-request limits. Explicit
local resync retries the exact pinned source, withdraws failed readiness, and
coalesces retries through native metadata, failure, or a ten-second deadline.
Focused Windows Chromium cases verify native 429 recovery, reload without autoplay,
explicit takeover, and running host transfer. An earlier Linux Firefox recovery
case passed; that result does not verify later candidates or the complete engine matrix.
The 2026-10-01 candidate passed a ten-minute, eight-member real-media smoke gate
(12 control cycles, five recovery checks, maximum sampled drift 43.398 ms), with
zero sockets, media requests, and queued playback reads after participant cleanup.
A longer run was stopped at the user's request: its last complete sample covered
8,528 seconds, 171 control cycles, 16 recovery checks, and 42 polling-fallback
checks, with eight upgraded connections and maximum sampled drift 284.143 ms.
It produced no final aggregate or teardown assertion; the runner exited and the
owned listeners and fixture processes were absent afterward. This partial run
does not complete eight-hour endurance acceptance; further long testing is
outside the current requested scope.

Room HTTP read reservations and bounded known-concurrency GET recovery address
the earlier shared-command and invitation-read admission failures without raising
the total request or rate limits. The passing smoke still observed 124 read 429s
(116 concurrency and eight request-window denials); retain these separately from
command acceptance. Those members shared one per-IP room window and concurrency
pool; room HTTP limits are now keyed per authenticated account (per IP only for
unauthenticated requests). Final local checks passed 710 backend tests, 989 Web tests,
580 integration tests, the production build and E2E TypeScript, and two selected
Windows native recovery/command and compressed-media cases. Cross-engine
compressed-media and concurrent-command failures remain independent gates; do
not describe selected cases or a smoke pass as a complete browser or deployment
matrix pass. The current evidence and its limits are recorded in the Web release
matrix.

Operational signals and deployment capacity limits are in place: `/health` room
gauges, a minutely `ops_summary` log line, room lifecycle/authority/capacity lines
and suggested CloudWatch alarms in the social rollout runbook. A counted local
database budget (`test/roomCapacityBudget.integration.ts`) shows the room sweep
dominates free-tier Atlas load, so the Elastic Beanstalk defaults allow one open
two-member room and ten realtime sockets, with a reserved seat for each member
that tabs outside the room cannot take. Lowering the sweep's per-room reads, or
a dedicated cluster, is the prerequisite for raising them; measuring them on the
actual deployment remains part of this stage.

Applies to each enabled capability, beginning with Stage 4; run an Audio rollout
gate as soon as its selected client scope is verified, without waiting for Video.
Measure socket memory, outbox lag/backlog, reconnect storms, same-NAT stream
concurrency and media egress on the actual deployment. Test old/new process
overlap and lease takeover even when deployment nominally has one instance.

Initial lab targets below are candidates, not a product SLA. Use eight active
members, RTT up to 150 ms and 1% simulated packet loss, record jitter/bitrate/device
route and label excluded or unsynchronized members. Also run a degraded-network
scenario to verify truthful failure behavior rather than silently excluding it.

| Measurement | Initial acceptance candidate |
| --- | --- |
| Command acceptance | p95 under 300 ms from local submit to durable acknowledgement |
| Fanout dispatch | p95 under 50 ms from committed state to local gateway enqueue; socket delivery measured separately |
| Preparation | Start scheduling as soon as eligible controllers are ready; three-second ceiling, then explicit partial-readiness/no-ready-participant state; host absence suspends separately |
| Scheduled start | Adaptive lead based on RTT/uncertainty; report per-client actual-start deviation from anchor |
| Correction convergence | Reach 150 ms tolerance within five seconds or show unsynchronized; seek if rate correction cannot meet deadline |
| Stable playback | p95 pairwise player-position difference under 300 ms, sampled after convergence; separately report each client's error against server timeline |
| Recovery | Report startup/seek/reconnect time to convergence and failures separately from stable-state samples |

Measure submit/auth/transaction/fanout/receive/player-execute segments with
monotonic timestamps and clock-uncertainty bounds. Correlation remains transient
in the controlled test harness; production diagnostics retain bounded aggregates,
not private room/member/media identifiers. Player-position agreement does not
certify speaker/display output alignment; test output routes separately.

Deploy flags off; validate cleanup/indexes; enable social and rooms
independently. The first Web release keeps only those two flags because rooms are
Audio-only; shared Video adds its own flag. Rehearse disable, forced restart,
expired sessions and rollback while preserving leave/block/deletion/reconciliation.
A process started with rooms off pauses open rooms and ends them under the ordinary
host-absence and expiry rules; the procedure and rehearsal are in
[the social rollout runbook](../deployment/social-rollout-runbook.md). When shared
Video ships, verify disabled Video pauses or ends Video entries explicitly rather
than reporting an Audio fallback. Extract
realtime workers or add Redis only for measured bottlenecks. Keep this stage in
progress until the selected release scope and its required deployment gates pass.

**Exit gate:** tested artifact and target-environment evidence cover enabled
capabilities; rollout/rollback, admission bounds and cleanup succeed under faults.
For Release 1 this means the deployment checklist is complete through the
kill-switch rehearsal and evidence record, and the go/no-go decision is
recorded. Capacity above the shipped limits, the eight-hour endurance run and
the degraded-network lab targets remain open after Release 1.

## Required verification during implementation

- Contract/player: exact complete snapshots, unknown-version failure, media
  duration/revision, clock uncertainty, drift deadline, playback/queue/membership
  and permission generations, preparation cancellation, local/shared Pause,
  activity intent and caps. Test stale commands after a mode round-trip,
  permission changes racing preparation, locally paused host with ready guests,
  and inactive observers in Everyone mode.
- Concurrent playback: two distinct Next commands on the same entry/generation,
  repeated same-ID requests, manual Next versus natural end, and Next versus
  queue reorder. Assert exactly one transition for competing commands and no
  automatic conflict retry; a later fresh action on the new entry may advance.
- Feedback prevention: repeatedly deliver snapshots to both the sender and peers,
  including newer membership-only revisions; trigger delayed seeked/playing/
  pause/item-change/ended callbacks. Assert zero command submissions, no activity
  write without a separately recorded explicit local playback intent, and no
  repeat load/restart for unchanged media. A valid pending local intent can record
  its actual start once; duplicate snapshots/callbacks must not record it again.
- Mongo integration: expiry after receipt purge, transaction retry, outbox crash
  windows, same-key uncertainty, absent-pair admission/block races, delayed kick
  after rejoin, mode change versus member command, transfer versus End room,
  recipient rejection/expiry/rejoin, uncertain transfer result, profile deactivation
  and resumable account cleanup. Successful transfer must revoke old-host invites.
- Media lifecycle: stale HEAD/GET/Range after replacement, metadata backfill
  conflicts, pending/non-ready media, deletion invalidation and missed notices.
- Client E2E: acknowledged bootstrap, old HTTP response after newer socket state,
  unauthorized/sessionless tickets, Origin, observer logout versus logout-all,
  controller takeover, host return without automatic promotion/resume, 30-second
  suspension and five-minute close in both modes, slow consumers, local launch
  after leave and accessibility.
- Operational: singleton lease overlap/loss, upgraded sockets/work drain,
  outbox recovery, proxy timeouts, resource pressure, stream admission and rollback.

Verified scripts in the current Archtree package manifests:
`npm test`, `npm run build`, `npm run test:integration`, `npm run test:e2e`,
`npm run test:e2e:chromium`, `npm run test:e2e:social --workspace @archtree/finitude-web`,
`npm run test:soak:rooms`, `npm run test:media-load`, `npm run demo:social`,
`npm run analyze:room-audio` and `npm run backfill:room-audio-analysis`.
Use the [Listener release matrix](../testing/finitude-web-release-matrix.md)
for release-facing changes. `git diff --check` applies to every stage.
New room/load fixture commands must exist before being listed as runnable.

The initial architecture review changed documentation only. At that checkpoint,
Stage 1's executable
test seams have passed local arbitration/player checks, with device gates still
open. Stage 2 has passed the social transaction, authorization and lifecycle gates
listed above. Room MongoDB arbitration, WebSocket delivery and room lifecycle gates
were still pending; passing the in-memory prototype could not satisfy them.
The current implementation and verification boundaries are recorded in the stage
statuses above, including the deployment gates in Stage 7 and the native device
gates in Stage 5.

## Plan lifecycle

Update each stage's single status as work progresses. When Release 1's gates
pass, move the remaining Stage 5 and 6 work, and Stage 7 capacity work beyond
the shipped limits, into a dedicated native and Video plan. After the approved
implementation scope and all required verification are complete, delete this
plan and remove its temporary links from architecture.md, README.md and
deployment-todos.md. Preserve architectural decisions in architecture.md and
accepted behavior in business-rules.md. If a future capability is explicitly
deferred beyond that scope, move only its remaining work into a dedicated active
plan rather than retaining a completed execution plan.
