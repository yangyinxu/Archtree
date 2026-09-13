# Social and shared playback implementation plan

Created and reviewed: 2026-09-13. Scope: design and incrementally implement the
social foundation for Archtree and Finitude, with future listening and watching together. This plan does not
authorize a production rollout. The proposed architecture is maintained in
[architecture.md](../architecture.md#social-and-shared-playback-architecture-proposed);
accepted product behavior remains in [business-rules.md](../business-rules.md).
The user has agreed that rooms support Host control and Everyone control,
switchable only by the current host. That requirement is recorded in the planned
feature section of the business rules; default mode and departure flow below
remain architecture recommendations until implementation scope is finalized.

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

**Status: In progress**

Implementation began with a transport-independent arbitration prototype, shared
synthetic fixtures and isolated Web/iOS/Android adapter work. These modules remain
unreachable from production room UI or routes until the durable authorization,
media and recovery stages exist. Device evidence and the final protocol freeze
remain required before this stage can be marked complete.

Implemented and locally reviewed in this stage:

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

Still required to finish Stage 1: freeze the complete social-v1 wire contract and
product defaults, include the lifecycle/capability fixtures, and resolve the
target-device evidence. These local adapters consume normalized trusted test
inputs; they are not substitutes for viewer authorization, controller admission,
clock calibration, revision-pinned media or a persisted readiness coordinator.

Complete the bounded Web/iOS/Android technical spike against synthetic room state
and real test media, before building the full social graph or freezing the wire
contract. Prove the existing player can prepare/seek, report actual start, apply
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

Then freeze social-v1 DTOs, errors, encoded-size bounds, mutation scopes, version
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
| First release | Account-targeted invitations, 2–8 members, both playback control modes, Audio first |
| Shared playback permission — agreed | Host control or Everyone control; only the current host changes mode; admitted active controllers follow the confirmed setting |
| Management permission | Invitations, kick, queue edits/sharing, permission changes, transfer and End room remain host-only; transfer acceptance belongs to the selected target |
| Initial mode | Host control by default; a host can enable Everyone while the room is open |
| Queue | Independent room queue copied through explicit share action; no collaborative Playlist; room Repeat/Shuffle off |
| Concurrent Next | One transition for actions based on the same entry/playback generation; no stale-command rebase or replay; a fresh action on the new entry can advance again |
| Presence | Visible only to admitted members; no global online/listening status |
| Account/device | One active room and playing controller per account; observers neither play nor control; observer logout does not end the room |
| Block | No blocked pair in one room; host blocker removes target, other blocker leaves |
| Host exit | Explicit Transfer and leave with recipient acceptance, or End room for everyone; transfer keeps mode/queue/running playback; pending preparation pauses |
| Host failure | 30-second grace, then enforced suspension in both modes; five-minute absence closes the room; no automatic promotion or resume |
| Slow client | Preparation ends early when ready, capped at three seconds; proceed with ready participants or stay paused if none is ready; host-controller presence is required, host-player readiness is not |
| History | Explicit local join/play intent after actual start only; remote changes do not write history |
| Room exit | Detach control; offer local continuation without auto-resuming old queue; ordinary browse Play explicitly exits room |
| Native source | Proposed room-only online-stream exception; ordinary playback still prefers valid Audio downloads |
| Opt-out | Discovery off preserves friends; social deactivation removes access/relationships but retains private blocks |
| Retention/limits | Architecture defaults; settle handle reservation/reuse and abuse-evidence retention before launch |
| Later scope | Video after device QA; user posts, chat, voice/camera and public rooms separately |

**Exit gate:** three-client feasibility evidence and unsupported-capability paths,
reviewed product decisions, exact fixtures and lifecycle matrix exist. Clock or
player limitations feed back into the protocol before it freezes. Shared
contract edits remain centrally coordinated; independent client spikes may run
in parallel with non-overlapping file ownership.

## Stage 2 — Social identity, relationships, and safety foundation

**Status: Not started**

Depends on Stage 1. Implement opt-in discovery/profile lifecycle, friendship
requests, block/unblock and scoped in-app outcomes. Add verified unique indexes,
transactional caps, immutable expiring mutation scopes, receipts, outbox and
account deletion cleanup before enabling writes. If deletion becomes asynchronous,
extend account/auth/private, avatar and shared-provenance writer fences before
using a deleting state; initial deletion preconditions must remain true throughout.
Room invitations and membership transactions belong entirely to Stage 3; there
is no partially working room invitation UI in this stage.

**Exit gate:** cross-account/guessing tests, request-accept/block/deactivate/delete
races, unknown commits, scope expiry after receipt deletion and notification
privacy pass. A delayed outcome cannot restore revoked visibility or friendship.

## Stage 3 — Durable rooms, pinned media, and realtime recovery

**Status: Not started**

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

**Exit gate:** two protocol clients converge after duplicate/coalesced/dropped
snapshots, HTTP/WebSocket response inversion, commit-before-fanout crash,
reconnect, unsupported version, kick/block, session revocation, account deletion,
media replacement and overlapping-process restart. Stale readiness/end timers
cannot operate on a new playback generation. No pre-admission room-data leak,
revision-mixed media responses, stale authority commit or double advancement.
Prove distinct concurrent Next IDs based on the same state produce one transition,
including when the driver reruns the losing transaction callback.

## Stage 4 — Audio room vertical slice on Web

**Status: Not started**

Depends on Stage 3. Integrate room mode with the existing player, browse-launch
helpers and all system/transport controls. Build friend discovery/request controls,
invite/join/readiness/shared controls/leave/resync UI and in-app outcomes, including
deactivate/block paths. Add the host-only mode selector and visible current mode,
distinct local/shared Pause, transfer offer/acceptance and explicit End room flow.
Add localization and accessible status announcements.
Keep user-intent submission separate from absolute snapshot application and
asynchronous player observations. Applying a remote or own acknowledged snapshot
must produce zero new shared commands, including through native-control adapters.
Start with two staging users and measure each latency segment before increasing
seats. Permitted actions show pending feedback immediately; successful commit is not
displayed as proof that every participant is playing.

**Exit gate:** real streaming and autoplay evidence in the supported browser
matrix; one player/queue; no feedback-loop commands, phantom activity or old
account state. Verify preparation cancellation, late joins, deliberate guest
pause, permission switch during a seek gesture, concurrent member commands,
host transfer/loss in both modes, buffering, same-NAT limits, fallback polling
and local recovery. A guest cannot bypass host-absence suspension with Play.

## Stage 5 — Native Audio adoption

**Status: Not started**

Depends on Stage 4's stable protocol and Stage 1's player evidence. iOS and Android
may implement independently against frozen shared fixtures, with backend and
shared-contract changes coordinated centrally. Add the complete social entry/exit
flow, both control modes and host-only management, controller-session handling,
transfer/exit outcomes and the agreed room streaming exception.
Exercise physical-device interruptions, background socket loss, output-route
changes, system controls, account transitions and return-to-foreground resync.

**Exit gate:** Web/iOS/Android agree on queue and timeline; unsupported background
or rate-control capabilities are explicit. No native autonomous advancement or
local download can silently replace the authoritative room representation.
Record unavailable physical-device gates as skipped, never passed.

## Stage 6 — Video capability

**Status: Not started**

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

**Status: Not started**

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

Deploy flags off; validate cleanup/indexes; enable social, rooms, Audio and Video
independently. Rehearse disable, forced restart, expired sessions and rollback
while preserving leave/block/deletion/reconciliation. Verify disabled Video pauses
or ends Video entries explicitly rather than reporting an Audio fallback. Extract
realtime workers or add Redis only for measured bottlenecks. Keep this stage in
progress until the selected release scope and its required deployment gates pass.

**Exit gate:** tested artifact and target-environment evidence cover enabled
capabilities; rollout/rollback, admission bounds and cleanup succeed under faults.

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

Verified scripts in the current Archtree package manifest:
`npm test`, `npm run build`, `npm run test:integration`, `npm run test:e2e`,
`npm run test:e2e:chromium`, and `npm run test:media-load`.
Use the [Listener release matrix](../testing/finitude-web-release-matrix.md)
for release-facing changes. `git diff --check` applies to every stage.
New room/load fixture commands must exist before being listed as runnable.

The initial architecture review changed documentation only. Stage 1 now changes
executable test seams, so its arbitration, player, build and relevant real-media
checks must pass before handoff. Actual MongoDB transaction, authorization,
WebSocket delivery and lifecycle gates remain pending until those implementations
exist; passing the in-memory prototype cannot satisfy them.

## Plan lifecycle

Update each stage's single status as work progresses. After the approved
implementation scope and all required verification are complete, delete this
plan and remove its temporary link from architecture.md. Preserve architectural
decisions there and accepted behavior in business-rules.md. If a future capability
is explicitly deferred beyond that scope, move only its remaining work into a
dedicated active plan rather than retaining a completed execution plan.
