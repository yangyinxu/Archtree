# Social backend and listening rooms

<!-- @catalog -->
**Contents**

- [Social backend](#social-backend)
- [Listening rooms and local demonstration](#listening-rooms-and-local-demonstration)
<!-- @end-catalog -->

## Social backend

The transactional identity/friendship API is mounted at `/api/social/v1`.
`FINITUDE_SOCIAL_ENABLED=true` explicitly enables profile creation/reactivation,
profile edits, new requests, acceptance, music sharing and listening publication;
it defaults to false in all environments. Disabling admission hides listening
status. Other reads, deny-only discovery opt-out, removal, cancellation,
block/unblock, deactivation, share dismissal/withdrawal, listening opt-out/stops
and outcome lookup remain available. Account deletion always performs social cleanup.

The API requires a revocable authenticated session, current Web viewer and the
existing same-origin cookie mutation checks. JSON bodies are limited to 4 KiB.
The existing server-only `JWT_SECRET` signs domain-separated 24-hour mutation
scopes and 15-minute pagination cursors; scope tokens belong in JSON bodies and
must never be logged or placed in URLs. Key rotation invalidates old scopes and
cursors; clients must not automatically resubmit an uncertain command under a
new scope after rotation. Startup verifies the
`required-indexes-v11-musicbrainz-ids` constraints before admission; these are
additive schema changes even when the feature is disabled.

See [the social API contract](../architecture/social.md)
for exact routes, envelopes, limits, retention and recovery behavior. Narrow
checks are `node --import tsx --test test/social/socialContract.test.ts test/social/socialRoutes.test.ts test/social/socialModerationRoutes.test.ts test/social/socialModerationView.test.ts`
and `node --import tsx --test --test-concurrency=1 test/social/socialLifecycle.integration.ts test/social/socialAccountLifecycle.integration.ts test/social/socialAuth.integration.ts test/social/socialModeration.integration.ts`.
The integration harness starts an isolated local MongoDB replica set; it does
not connect to the configured application database. Full gates remain `npm test`,
`npm run build` and `npm run test:integration`.

Use **Share with a friend** on a track or Album to select an existing friend.
**Together → Music shares** (`/finitude/social/shares`) shows private Received and
Sent lists. A share lasts up to 30 days; repeating the same active share does not
create another card. Play, Save and room invitations are explicit actions.
Received cards can be dismissed and Sent cards withdrawn. Removing friendship or
blocking clears the pair's shares. The same page remains available after login.

In **Together**, **Share what I’m listening to** is off by default. Enable it to
share fresh actual Audio playback with current friends, from both ordinary and
room playback. **Share from this device** explicitly chooses the publishing
device. **Listening with friends** lists every friend listening now, 20 at a time
with **Load more**; it is read when Together opens and refreshes the loaded pages
while visible. Status expires within 25 seconds without fresh progress and stops
on pause, buffering or opt-out.
Viewing a status does not play anything. Invite a friend into a room you host,
or explicitly confirm creation of a paused room with eligible Audio before
sending the invitation. If invitation fails, the created room remains available.

**Report** appears on friends, requests, blocked rows and lookup results in
**Together**. It opens a dialog for an optional reason and note and sends only
after **Send report**. The reported listener is never told. A listener can report
each person once per UTC day and file up to 10 reports a day. A suspended
listener sees a notice in place of the profile controls.

Administrators review reports at `/admin/social/reports`, linked as **Social
reports** under Content Manager operations. Each open report can be dismissed,
marked handled, or resolved by suspending the reported listener, which resolves
all of that listener's open reports. The page also lists suspended listeners
for unsuspension and looks up any handle. Resolved reports are deleted 90 days
after resolution. The same routes return JSON for scripted use with an
administrator access token from `POST /auth/login` (Bearer requests skip the
browser same-origin check; keep the token out of shell history and logs):

```sh
curl -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H 'Accept: application/json' \
  'https://<host>/admin/social/reports?state=open&limit=50'
curl -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" 'https://<host>/admin/social/profiles?handle=<handle>'
curl -X POST -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"resolution":"dismissed"}' 'https://<host>/admin/social/reports/<reportId>/resolve'
curl -X POST -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{}' 'https://<host>/admin/social/profiles/<socialId>/suspend'
curl -X POST -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{}' 'https://<host>/admin/social/profiles/<socialId>/unsuspend'
```

Each change is idempotent: repeating it returns `noop`, so a
`mutation_outcome_unknown` response can be retried after reading the current
state. Suspension and moderation work whether or not `FINITUDE_SOCIAL_ENABLED`
is set. See
[reports and suspension](../architecture/social.md#reports-and-administrator-suspension)
for the stored evidence, transactions and account-deletion handling.

## Listening rooms and local demonstration

Finitude Web exposes **Together** at `/finitude/social`: opt-in identity, exact
handle lookup (anyone found can also be blocked), friend requests, invitations, queue selection, shared transport,
Host/Everyone permissions, local pause/resync and accepted host transfer. It uses
the existing player. **Remove friend**, **Block**, **Deactivate social profile** and
**Remove from room** ask for confirmation first and say what changes. Enable both `FINITUDE_SOCIAL_ENABLED=true` and
`FINITUDE_ROOMS_ENABLED=true`; both default to false. Leave/end/decline and account
cleanup remain available when new room admission is disabled. With the flags off,
Finitude Web shows no social entry point and sends no social request; `/finitude/social`
stays reachable by address and says Together is temporarily unavailable, and the room
panel says rooms are temporarily unavailable instead of connecting. Native room UI and
shared Video are not enabled by this slice.

For a disposable local demonstration, run `npm run build` then
`npm run demo:social`. Node 24 and the same trusted local `mongod` used by the
integration suite are required. The command starts its own MongoDB replica set
and loopback S3-compatible HTTP fixture, seeds three original synthesized WAV
tracks, and prints two `/finitude/social` URLs. Open both in Chrome. The separate
`127.0.0.1` and `localhost` origins keep the two normal cookie logins independent.
Use the synthetic accounts `alice@example.test` and `bob@example.test`, each with
password `Social-demo-only-2026!`. This password belongs only to this disposable
fixture; the command refuses production mode and does not use the application
MongoDB database or S3 bucket. Stop the command with Ctrl-C to clean up its owned
resources; restart creates fresh accounts and rooms.

Create an identity in each tab, use exact handle lookup to send/accept a friend
request, select tracks and create a room, then invite and join from the other tab.
Host control is the default. Choose Everyone to let both active controllers seek
or choose a track. Pause only for me stays local. The main button becomes Listen
along when the room is playing, or Resume and play for everyone when the room is
paused and you can control it. A guest in Host control can resume locally and
wait for the host. Switching tabs keeps Audio playing while the browser and
realtime connection remain active. Actual page freezing, sleep with stale
connectivity, or connection loss pauses local playback; after reconnection use
the main button to listen again. Transfer and leave requires the recipient to accept; End room
closes it for every member. A refreshed tab observes until Use this device is
selected. Browser autoplay refusal is surfaced with explicit resync rather than
reported as successful playback.

In **Song requests**, any admitted member can recommend an eligible Audio track,
including an observer device and guests in Host control. The host's active
controller adds requests to the queue or dismisses them; members can withdraw
their own pending requests. The host can move queued songs earlier/later and
remove a song after selecting another current entry. Appending and reordering
preserve playback and local pause. Requester attribution reflects current room
members only. There are at most five pending requests per member and 20 per room.

Use **Listen together** beside an Audio track in Search, an Album, Library, or
the player to request it for your current room. Confirmed requests show
**Requested. Waiting for the host.** With no room, choose a friend and explicitly
confirm a paused room plus invitation. If sending fails, use the existing room
and receipt recovery instead of creating another room. Songs are checked for
room eligibility before submission; ordinary playback still supports other
formats. Together's song pickers support title search and **Load more**, retaining
the initial queue selection across searches. The global room entry returns to
controls and shows shared playback, local pause, observation or connection
recovery without starting playback.

**Room activity** offers five fixed emoji reactions to every admitted member,
including observing devices. It shows brief confirmed join, song, host and
control-mode changes. Events expire after 30 seconds and are cleared when their
member departs or the room ends. Reactions do not change playback; repeated
commands are deduplicated. The per-account limit is 12 reactions per minute,
within a room-wide limit of 60.

Active social profiles have a **Room invitations** bell throughout the Web
listener. Its dot means there are pending invitations, not an unread-history
count; opening the list does not clear it. The list is also available at
`/finitude/social/invitations`, including while the listener is in another room.
After inviting a friend, the host's active controller can choose **Copy invitation
link** beside that friend. A read-only URL field provides a manual fallback if
clipboard access is unavailable. The URL points to
`/finitude/social/invitations/:invitationId` and works only for that invitation's
recipient. Login preserves this destination across reloads. Opening the link
never joins, changes rooms or starts playback; the recipient explicitly joins or
declines. If a link reached the wrong person, **Send new invitation** (after a
confirmation) replaces the invitation and the earlier link stops working; a
replacement does not use another of the host's 20 pending invitations.
Replaced, expired and revoked invitations, and links opened by a
different account, show the same unavailable state. These are Web links; native
invitation handling remains a later delivery stage.

The global entry reuses the existing account-scoped realtime connection and
refreshes invitation reads after subscription/reconnection. Invitations also
refresh every 15 seconds while the page is active and on focus; local expiry
removes stale reminders even when MongoDB TTL cleanup sends no invalidation.
Disabled room capabilities suppress background ticket retries while keeping
explicit safety actions available. No notification sound or push permission is
requested.

Social works with `FINITUDE_ROOMS_ENABLED=false`. Whenever no room socket is
connected, the Web client polls the payload-free `GET /api/social/v1/me/changes`
cursor in a visible tab. It polls 15 seconds after its previous poll and doubles
that wait up to 60 seconds while nothing changes. A changed cursor refreshes
incoming requests, shares and other social reads. Each poll reads two small
documents and writes nothing. A connected socket stops the polling.

The implemented [room API](../architecture/rooms.md#implemented-audio-room-api) uses
HTTP for version-fenced commands and complete authorized WebSocket snapshots for
delivery. The server uses pinned `ws` with compression disabled; no Redis or
external messaging service is required for this bounded single-authority slice.
The proxy must forward Upgrade/Connection and WebSocket subprotocol headers,
preserve the same-origin Host/protocol contract, and allow more than the five
second heartbeat interval. The managed Elastic Beanstalk HTTPS server
(`.platform/hooks/postdeploy/01_configure_https.sh`) does this for every path:
only an `Upgrade: websocket` request gets `Connection: upgrade`, other requests
proxy exactly as before, `Sec-WebSocket-Protocol` and `Origin` pass through
unchanged, and its 120-second idle timeouts exceed the five-second ping and the
gateway's 16-second silence eviction. The next application deploy rewrites an
existing instance's config without reissuing its certificate. The temporary
HTTP server used before a certificate exists never forwards upgrades. Configure
`TRUST_PROXY_HOPS` for the actual proxy chain. Production requires HTTPS/WSS.
Only the live MongoDB lease holder admits realtime connections and scheduling;
verify routing, lease recovery and capacity in the deployment before enabling
it.

New uploads receive a private representation record tied to the exact object.
The room analyzer verifies complete PCM16 WAV (mono/stereo, 8–48 kHz), MP3
(MPEG Layer III, including verified Xing-indexed VBR), and self-contained, single-track AAC-LC
M4A (mono/stereo, 8–48 kHz). Duration must be finite and at most 24 hours.
Compressed inputs are capped at 512 MiB and require strict framing/sample tables
plus full FFmpeg decoding to the null muxer. HE-AAC, encrypted/fragmented MP4,
external references, Video and unverified audio remain outside room selection.
Ordinary playback remains available if inspection fails or the decoder is absent.

Install FFmpeg and run `npm run doctor` before compressed-media development or
rollout. `ROOM_AUDIO_FFMPEG_PATH` may select an absolute executable path; otherwise
`ffmpeg` is resolved on PATH. Each process permits at most two simultaneous
single-threaded decodes, with a 60-second decode deadline. Operational decoder
errors preserve retryable evidence; successful source metadata is never inferred
from a filename, MIME type, display duration or a missing runtime. On Elastic
Beanstalk a prebuild hook installs a pinned, SHA-256-verified FFmpeg and
`.ebextensions/room-audio-decoder.config` points `ROOM_AUDIO_FFMPEG_PATH` at it;
see [Room audio decoder on Elastic Beanstalk](../deployment/aws.md#room-audio-decoder-on-elastic-beanstalk).
See [runtime setup](../development/environment.md#room-audio-analysis-runtime).

Administrators can open **Content Manager → Operations → Room audio analysis**
at `/content/manage/room-audio-analysis`. GET lists 25 rows per page and never
reads storage or starts analysis. POST explicitly analyzes/retries one source,
rechecking the admin role and matching its opaque source revision and original
attempt ID. A source-bound two-minute lease preserves interrupted/uncertain work;
recovery is explicit. Storage/decode work has a 90-second deadline and a 512-MiB
temporary-file limit; database calls retain the bounded driver timeouts and
five-second server-operation limit. Late results cannot publish after lease
expiry. A separate concurrency limit admits one analysis request at a time. It pins S3
HEAD/GET by ETag/version, rechecks the source, and writes only analysis metadata.
It never PUTs or DELETEs objects, replaces bytes, or changes an eligible revision.
A concurrent upload/deletion wins its source fence; stale results cannot publish.

From a full repository checkout on an administrator workstation, a bounded CLI
lists a single page by default, without index or media writes:

```sh
npm run analyze:room-audio -- --admin-id=<admin-account-id> --limit=25
npm run analyze:room-audio -- --admin-id=<admin-account-id> --limit=25 --apply --confirm=ANALYZE_ROOM_AUDIO
```

Use the returned `resumeAfter` with `--after=<track-id>` for explicit continuation.
When `stopped=false` and the cursor is null, the scan is finished. When
`stopped=true` and the cursor is null, restart without `--after` to recover the
first unresolved item. A failed, busy, cancelled, stale or
unknown item stops the batch before advancing past it. Completed items remain
stored and are skipped on continuation. SIGINT/SIGTERM cancels the current item;
retryable attempts retain their original ID. Inspect the current status before
retrying an unknown outcome. This command needs the normal private database/S3
configuration and an existing admin account. The Elastic Beanstalk bundle excludes
repository scripts; use the deployed administrator page for in-app operations.
Use it for targeted recovery; the catalog backfill below covers the whole catalog.
Run either command against production only as the approved launch backfill or
another explicitly authorized catalog operation.

#### Room audio catalog backfill

MP3/M4A uploads made while Elastic Beanstalk had no decoder recorded
`decoder_unavailable`, and older tracks have no verified analysis, so none of
them can be chosen in a room. `npm run backfill:room-audio-analysis` walks the
whole catalog from an operator checkout and analyzes, one source at a time,
every ready/published Audio track whose analysis is missing, retryable or from
an older analyzer version. Eligible, terminally unsupported and leased tracks are
skipped without storage reads, and unpublished or unfinished uploads are never
listed, so rerunning a finished backfill analyzes nothing. It calls the same
source-fenced service as the administrator page: pinned S3 HEAD/GET, no object
writes, analysis metadata only, and a recorded attempt keeps its identity.

```sh
# 1. Preview (the default): catalog reads only, no storage reads or database writes.
npm run backfill:room-audio-analysis -- --admin-id=<admin-account-id> --log=room-audio-backfill.jsonl
# 2. Apply in bounded, paced runs (defaults: 100 analyses per run, 2 s apart, 25 rows per page).
npm run backfill:room-audio-analysis -- --admin-id=<admin-account-id> --log=room-audio-backfill.jsonl \
  --apply --confirm=BACKFILL_ROOM_AUDIO
# 3. Continue after the previous summary's resumeAfter until a summary reports finished=true.
npm run backfill:room-audio-analysis -- --admin-id=<admin-account-id> --log=room-audio-backfill.jsonl \
  --after=<resumeAfter> --apply --confirm=BACKFILL_ROOM_AUDIO
```

`--max-analyses=1..1000` bounds one run, `--delay-ms=0..60000` paces analyses,
and `--page-size=1..100` sizes catalog reads. Each listed track produces one JSON
line (`mediaTrackId`, `listed` status, `result`, bounded `reason`, `resumeAfter`)
and the run ends with a `summary` line. `--log` appends the same lines to a
private (0600) file, so resumed runs extend one audit trail. Titles, storage keys,
validators and attempt IDs are never printed. Exit codes: 0 finished, 2 stopped
and resumable, 1 could not run, 130/143 interrupted.

Busy, stale, timed-out and other per-source failures are logged and passed over
(`retryLater` counts them); a later run started without `--after` retries them.
A missing local decoder, unavailable storage, an uncertain outcome, or SIGINT/SIGTERM
stops the run before its cursor passes that track. `--apply` refuses to start
unless the local FFmpeg passes `node scripts/check-runtime.mjs --room-audio`, so
a broken decoder cannot turn every source into a failed attempt.

Run it safely:

- Use a trusted operator machine with FFmpeg installed and the target's private
  `.env` (`DB_CONN_STRING`, `DB_NAME`, `S3_BUCKET_NAME`, `AWS_REGION` and AWS
  credentials). Analysis needs only `s3:GetObject`/`s3:GetObjectVersion` on the
  media bucket; prefer credentials limited to those reads.
- Check the target before every command; the dry run is the default and writes nothing.
  Compare its `wouldAnalyze` count with expectations before applying. The dry
  run counts each `wouldAnalyze` row toward `--max-analyses` (default 100), so a
  default preview stops at 100 with `stopReason: "limit"`. To see the full count,
  pass `--max-analyses=1000` and follow `resumeAfter` until `finished=true`.
- Each analysis downloads the full source (up to 512 MiB) into the local
  temporary directory and counts as S3 data transfer out. Keep the default
  pacing on the free-tier MongoDB Atlas cluster and run one backfill at a time.
  The deployed administrator page can keep working: a two-minute source lease
  makes either side skip a track the other is analyzing.
- The rooms launch decision approves one production backfill after the
  FFmpeg-enabled deployment has been verified; keep the log's final summary with
  the release evidence.

Verified room response MIME types come from the inspected format rather than an
upload declaration. Room URLs pin an opaque media revision and HEAD/GET validate the same stored S3
ETag/version. S3 permissions must cover `GetObjectVersion` and
`DeleteObjectVersion` when version IDs are present. Fresh PUTs use a unique
identity-bound key and `If-None-Match: *`, preventing an SDK retry from silently
creating another version. A lost PUT response retains its pending key and
unknown-outcome flag for explicit version reconciliation; retry/delete cannot
erase that evidence. Known pending, active and detached versions are deleted by
exact VersionId. The latest-key inventory is not a full version-history
reconciliation tool.

Run `npm test`, `npm run build`, `npm run test:integration`, and
`npm run test:e2e:social --workspace @archtree/finitude-web` for the real
MongoDB/S3/WebSocket browser flows. Each social test owns a disposable
server, database and object store, including separate rate-limit windows; the
two rooms tests run as the `chromium-rooms` and `chromium-rooms-recovery`
projects so neither can exhaust the other's rate windows. The
`chromium-room-lifecycle` project waits through one real 30-second host-absence
grace and verifies the visible countdowns, suspension in both control modes,
host return without automatic resume, five-minute closure in both modes, and
observer logout versus sign out everywhere. Only that disposable fixture exposes
`POST /__fixture/room-host-absence`, which moves a recorded absence start into
the past; the application's own sweep still suspends or closes the room. The
`chromium-social-safety` project runs request cancel and decline, friend removal,
block, unblock, deactivation and reactivation through the Together page against the
real social service; `chromium-room-membership` covers removing a member, leaving,
Reconnect after a lost transport, and the room exit that a block causes. Keep the
ordinary listener E2E gate for playback continuity, navigation and
accessibility changes. The social E2E uses a disposable
headed Chromium profile to verify real background tab visibility; run it in a
desktop session, or use `xvfb-run -a npm run test:e2e:social --workspace @archtree/finitude-web`
on Linux with Xvfb installed. All automated Chromium launches, including this
headed profile, use `--disable-audio-output` to route playback through Chromium's
fake audio output stream. This avoids opening the developer's audio output device
and triggering automatic Bluetooth headphone switching; muting alone can still
open that device. Media decoding, playback clocks, element volume/mute state and
background-tab behavior remain under test. These checks do not verify audible
output or physical headphone routing.

The compressed-media social scenario uploads original CBR MP3, Xing VBR MP3 and
AAC-LC M4A fixtures through the production storage lifecycle. It checks pinned
HEAD/Range responses, real decoding, readiness, seeking, cross-format advancement
and absence of command echoes. All social projects run in Chromium only; the
earlier Firefox/WebKit real-audio projects were removed because their Linux
audio stack made CI flaky without catching product bugs. Production rooms remain
disabled; the controlled rollout checks are still required before public
enablement (see the [social rollout runbook](../deployment/social-rollout-runbook.md)).
Later production checks on 2026-10-12 completed QA registration, verified-email
login and registration-link replay rejection. Already-registered and six-digit
password-reset emails were received; reset completion and session revocation
remain untested. Three original QA audio fixtures were published, and each passed
canonical HEAD plus two Range checks against the source bytes. AAC passed a
supplemental check using its stored `audio/x-m4a` MIME type. The administrator
analysis page confirmed all three new sources **Ready for rooms** after automatic
upload analysis. In an isolated signed-in in-app browser with both flags off,
each track played, paused, sought to 60 seconds while staying paused, and resumed
with an advancing clock. This verifies ordinary playback in that browser only,
not audible output, other browsers or physical devices. Pinned Room media,
including AAC's required `audio/mp4` response, and actual Room playback remain
pending; see
the [production acceptance record](../deployment/finitude-web-rollout-runbook.md#production-authentication-and-media-checks--2026-10-12).

Room playback preloads media while paused so readiness can precede the shared
start; confirming a completed seek does not seek again to the same position.
An explicit resync during a native seek keeps its pending intent until that seek
finishes, then recomputes the position from the current authoritative anchor.
It cannot overlap native seeks or report the superseded position as ready.
It corrects startup drift after credible media-clock advancement. Small-drift
heartbeats retain their clock reference but defer rate changes until that first
progress, avoiding a decoder flush before playback begins; larger drift can still
seek immediately. A corrective
seek measures the clock time lost during that seek, separately from initial
play startup. At most two additional seeks per playback occurrence may compensate
the measured delay, within six seconds of the first compensation. The second
allows one refinement when the first measured decoder delay changes; concurrent
heartbeat corrections update the clock reference
without interrupting that observation. Measurements expire after three seconds.
Valid finite, non-negative delays within that window are retained, while
predictive lead is capped at two seconds. Later ordinary heartbeat
corrections can reuse the measured delay until the playback effect changes.
All pending work is cancelled by local pause, authority loss, or source changes.
A fully buffered Audio decoder that stays paused with only current-frame data
after preparation gets at most one paused source reload per playback occurrence.
A later completed controller-owned drift correction has one separate recovery
for that occurrence: `HAVE_CURRENT_DATA` (`readyState: 2`) can persist even while
the media clock advances. A successful preparation reload does not consume this
later correction recovery. Each phase rechecks its own source and seek ownership,
and explicit resync does not replenish either budget. Ordinary playback is not
reloaded solely for reporting current-frame data. Readiness still requires future
data, and local pause or leaving cancels
recovery.
For that recovered occurrence, drift corrections use explicit measured seeks
instead of playback-rate changes, which can trigger additional decoder seeks.
This may produce a brief jump for smaller drift, but avoids repeated rate
transitions on a decoder that already needed recovery. A new occurrence resumes
normal rate correction. Rate restoration never authorizes a seek from stale
readiness or permission state.
CI runs these scenarios in their own job and uploads `finitude-social-browser-evidence`
when they fail; the MongoDB integration and ordinary browser gates run in parallel jobs.

In isolated Linux CI (`CI=true` or `CI=1`), the native-tab fixture matches
Playwright's default `--no-sandbox` launch option; other local launches keep the
browser sandbox.

The listener and social E2E configurations run Chromium only, with
`--disable-audio-output`, on every platform.

The legacy
`contracts/social/prototype-v1/playback-trace.json` remains a unit-test fixture
and native DEBUG adapter input, not the room wire contract. Native devices and native
background participation, shared Video and deployment performance remain tracked in
[the social implementation plan](../plans/social-and-shared-playback-plan.md).
