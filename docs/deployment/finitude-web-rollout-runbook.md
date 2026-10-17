# Finitude Web Rollout and Rollback Runbook

This runbook governs promotion of the Finitude Web listener and its Archtree
server routes. It records operational evidence; product behavior remains
canonical in [`../business-rules.md`](../business-rules.md).

<!-- @catalog -->
**Contents**

- [Release invariants](#release-invariants)
- [1. Prepare and identify the candidate](#1-prepare-and-identify-the-candidate)
  - [CodePipeline promotion setup](#codepipeline-promotion-setup)
- [2. Deploy and verify staging](#2-deploy-and-verify-staging)
- [3. Promote the same artifact](#3-promote-the-same-artifact)
- [4. Roll back](#4-roll-back)
- [Evidence record](#evidence-record)
  - [Verified release and served Web bytes — checked 2026-10-12](#verified-release-and-served-web-bytes--checked-2026-10-12)
  - [Production authentication and media checks — 2026-10-12](#production-authentication-and-media-checks--2026-10-12)
<!-- @end-catalog -->

## Release invariants

- Promote the exact tested Elastic Beanstalk bundle. Never rebuild between
  staging, production, or rollback.
- Every candidate contains `RELEASE.json` with the source commit and CI build
  identity. Its retained ZIP has a `release-provenance.json` sidecar binding the
  SHA-256, workflow run/attempt and successful gate set. Record all identities.
- CodeBuild promotes only the retained artifact from the exact successful
  merged-main push gate. Its repository buildspec cannot rebuild a substitute
  from source or promote a PR, fork, failed run, or earlier rerun attempt.
- Keep the immediately previous successful bundle available until the release
  has passed its agreed observation window.
- The bundle must contain only the explicit runtime allowlist produced by
  `npm run stage:eb-artifact`; credentials and `.env` files must remain in the
  deployment environment.
- Artifact staging requires the Certbot installer, application and
  configuration-deployment HTTPS entry points, and bootstrap/renewal timer
  hooks. A candidate missing any one of those hooks is not deployable to the
  single-instance environment.
- Request rate windows and concurrency slots, including the per-account social
  and room budgets, live in the one application process and reset on restart.
  Keep the environment at one instance and one process; adding another would
  give every account and IP an extra budget. Design shared limits first, as the
  [single-process capacity contract](../architecture/runtime.md#single-process-capacity-contract)
  requires.
- The Playlist release adds private `playlists` and account-mutation receipt
  collections plus their owner, replay, and expiry indexes. These changes are
  additive and own no S3 objects; verify every required production index before
  enabling Playlist traffic.
- `FINITUDE_PLAYLISTS_ENABLED` is fail-closed in production: an omitted value
  keeps Playlist APIs and Web entry points disabled. Enabling or stopping the
  release requires an explicit `true` or `false` deployment value.

## 1. Prepare and identify the candidate

The release workflow runs unit/component tests, Mongo-backed lifecycle
integration tests, production builds, the real social browser scenarios, the
three-engine browser/axe gate, and artifact staging before retaining a
commit/run/attempt-named rollback bundle and checksum sidecar. Integration coverage
is required for the account, Playlist, transaction, S3, and content-reference lifecycle; do not infer it from
unit or browser results. For a local artifact verification run in a provisioned
Linux environment:

```bash
npm ci
npm test
npm run test:integration
npm run build
npm run typecheck:e2e --workspace @archtree/finitude-web
CI=1 xvfb-run -a npm run test:e2e:social --workspace @archtree/finitude-web
CI=1 npm run test:e2e --workspace @archtree/finitude-web -- \
  --update-snapshots=none
git diff --check
npm run stage:eb-artifact
```

CI installs Xvfb for the social suite's headed background-tab checks and a
PulseAudio null sink for Firefox. All social Chromium launches disable hardware
audio output. The isolated social scenarios cover room native lifecycle,
room recovery, invitations, song requests, music shares, room interactions,
listening status, catalog room entry, and compressed-audio formats. Once the
browser environment is ready, the ordinary browser/visual gate runs even if a
social assertion failed so both suites retain diagnostic evidence. Both gates must pass before artifact staging. Their traces and failure
screenshots remain under the retained `web/test-results` evidence. The blocking
social gate includes `firefox-audio-formats` and `webkit-audio-formats` with every
other Linux social project. Run just the compressed-audio pair locally on Linux
with the CI audio sink using
`CI=1 xvfb-run -a npm run test:e2e:social --workspace @archtree/finitude-web -- --project=firefox-audio-formats --project=webkit-audio-formats`.
The 2026-10-12 check confirmed consecutive successful
[pull-request](https://github.com/yangyinxu/Archtree/actions/runs/38169379414) and
[merged-main](https://github.com/yangyinxu/Archtree/actions/runs/38170519764)
acceptance: all 17 social scenarios and 347 listener browser tests passed in
each run, with ten intentional Chromium-owned listener skips. Production rooms
remain disabled; the controlled rollout checks are still required before public
enablement (see the
[social rollout runbook](social-rollout-runbook.md#cross-engine-audio-acceptance-blocks-enabling-rooms)).

Local staging requires a clean committed worktree so `RELEASE.json` cannot
misidentify uncommitted bytes. CI supplies the immutable source identity
directly.

The same build emits the Engineering Guide under `engineering/dist`. Both the
staged runtime and the versioned rollback ZIP must retain that directory alongside
`web/dist`. Staging and promotion reject a guide whose manifest identifies a dirty
checkout or a different commit from `RELEASE.json`; rebuild after committing the
candidate. Guide source documents are not copied into the runtime. Once deployed,
verify an administrator can open `/engineering` and a nested page, while an
ordinary account cannot read either the pages or their assets. Local preview and
fixture tests do not replace that deployment check.

The release workflow never updates visual baselines. When the current
candidate has no reviewed Linux baseline yet, its first Ubuntu run is expected
to fail the affected visual assertions while retaining `test-results` with the
actual Linux renders. Review those renders, add only the approved platform-
scoped baselines to a new candidate, and run the complete workflow again. Only
the second run passing with `--update-snapshots=none` is Linux release evidence;
the baseline-producing run is not green evidence and must not produce a
deployable candidate archive.

Before promotion, verify all of the following:

- CI is green for the commit recorded in `RELEASE.json`.
- Mongo-backed integration tests pass for the exact candidate source tree.
- The current candidate's Linux visual baseline has been reviewed separately
  from macOS rendering and then passes without an unapproved snapshot update.
- The candidate bundle is the artifact retained by that same CI run.
- The previous known-good bundle and its `RELEASE.json` are retrievable.
- The previous bundle's own listener base-path contract is recorded. Before
  the first `/finitude` production promotion, either that bundle must accept
  `/finitude` deep links or a tested environment-level compatibility redirect
  to its legacy listener path must be ready for rollback.
- The staging environment uses production-equivalent MongoDB/S3 contracts and
  contains no production customer credentials or unapproved test traffic.
- The staging database has the Playlist owner-order index
  `{ ownerUserId: 1, updatedAt: -1, _id: -1 }`, the unique mutation-replay
  index `{ ownerUserId: 1, idempotencyKeyHash: 1 }`, the owner-expiry lookup,
  and the TTL index on `accountMutations.expiresAt`. Do not rely only on startup
  logging to prove that index creation succeeded.
- The candidate is first deployed with `FINITUDE_PLAYLISTS_ENABLED=false`; its
  public `/api/listener/v1/capabilities` response reports `playlists: false`,
  and direct Playlist API calls reject traffic without removing stored data.
- A release owner, rollback owner, observation window, and stop conditions are
  recorded before deployment starts.
- Before publishing the first production Video MediaTrack, a supported iOS
  build must decode `mediaType`, use the canonical MediaTrack stream, and
  present Video through its shared player. Until then, keep Video MediaTracks
  local or staging-only; the legacy Audio stream intentionally does not
  masquerade a Video object as Audio.

Stop if the candidate or previous version cannot be identified exactly. Also
stop the first base-path migration if rollback would leave `/finitude` deep
links unavailable and no tested compatibility redirect exists.

### CodePipeline promotion setup

Use the repository `buildspec.yml` with a Node 24/Python 3 build image and a
CodeBuild timeout of at least 45 minutes. Preserve the source revision as the full
`CODEBUILD_RESOLVED_SOURCE_VERSION`; do not replace it with a branch name or an
operator-selected newer SHA. The promoter waits up to 35 minutes for that exact
main workflow to finish (`ARCHTREE_RELEASE_WAIT_SECONDS`, 0–3600); a failed gate
stops immediately. A timeout is a failed promotion and requires an explicit retry
after the same gate succeeds. The pipeline emits no deployable fallback artifact.

Provide `GITHUB_ARTIFACT_TOKEN` from a managed secret with only **Actions: read**
for `yangyinxu/Archtree`, and grant the CodeBuild service role access to that secret.
Confirm the source pipeline connection is not being mistaken for this independent
API permission. Permit HTTPS to GitHub's API and artifact blob storage. The
promoter strips the GitHub credential before downloading the signed storage URL.
The repository does not provision these account-side settings.

The release workflow runs its gates as parallel jobs (`build`,
`unit-integration`, `social-e2e`, `browser-e2e`), so a normal run takes about
20–25 minutes, well inside the 35-minute wait. Only the final `release-artifact`
job, which needs all four, stages and uploads the bundle. It stages the
production build that both browser jobs tested, and never rebuilds it. A failed or
timed-out gate skips that job and fails the run, so nothing is promoted. Use
**Re-run all jobs** for a fresh attempt; the new attempt identity is bound into
the provenance as before.

The successful main workflow retains
`archtree-eb-<commit>-<run-id>-<attempt>` containing
`archtree-eb-<commit>.zip` and `release-provenance.json`. CodeBuild validates both
archive digests, exact workflow event/repository/source/attempt, all gate results,
`RELEASE.json`, ZIP safety, runtime layout and executable hooks before handing the
unchanged extracted runtime tree to the existing EB deploy action. It fails if
its output directory already exists. Keep the upload/deploy role restricted to
this verified artifact path and remove saved buildspec overrides that rebuild.

Check the CodeBuild `tested_release_promoted` event against the GitHub run,
artifact ID and bundle digest before enabling automatic deployment. Test one
pending/failed gate and one wrong-source candidate in a safe pipeline to prove
there is no deploy action on failure. This account-side handoff check remains
required even when all offline synthetic promotion tests pass.

Store the exact candidate ZIP and sidecar, plus the prior successful pair, in
retained deployment storage. GitHub's 30-day expiration must not remove the only
rollback copy. Existing pre-provenance archives remain manual emergency recovery
inputs under this runbook; they cannot silently pass the new promotion verifier.

## 2. Deploy and verify staging

Deploy the retained candidate bundle to the approved staging Elastic
Beanstalk environment. Do not deploy a newly generated archive from a local
worktree. Wait for the environment and `/health` to report healthy, then record
the deployment version and candidate release identity.

After the disabled-state checks and index verification pass, set
`FINITUDE_PLAYLISTS_ENABLED=true` in staging, wait for the environment to become
healthy, and verify `/api/listener/v1/capabilities` reports `playlists: true`
before running the Playlist smoke flow below.

Run these checks against the staging origin:

1. `GET /health` returns 200 and identity-free media delivery metrics.
2. `GET /`, `GET /finitude`, and a direct listener deep link such as
   `GET /finitude/search` return successfully over HTTPS. Without following
   redirects, `GET /listen/search` returns 308 with `Location: /finitude/search`.
3. Listener HTML references hashed `/finitude/assets/` resources, and those
   resources return immutable cache headers.
4. The landing-page Finitude entry opens `/finitude`; password login, logout,
   refresh, and the signed-out Library state behave normally. With Listener and
   Content Manager open together, repeat delayed login, refresh, logout, and
   account-switch actions across two tabs. Confirm that the last authoritative
   account wins, the departed account's private DOM and cache never reappear,
   and logout clears only that account's device-local search history.
5. A known public, currently attached artwork ID returns WebP from
   `/content/images/:imageId/v1/320.webp`, with an ETag, positive
   `Content-Length`, and `public, no-cache` revalidation.
6. Ready Audio and Video MediaTracks return 206 from
   `/content/mediaTrack/stream/:mediaTrackId` for a small `Range` request, the
   expected `Content-Range`, and the same ETag used by each preflight response.
   Starting Audio retains the browse layout; starting Video opens the central
   theater and right-side queue without a media-mode switch.
7. Home, Search, Album, Artist, Library, Account, compact player, and expanded
   player complete their core smoke flows without a console or telemetry leak.
8. With one listener account, create, rename, add, reorder, play from the
   middle, remove, and delete a Playlist. Confirm a lost-response retry with
   the same idempotency key does not duplicate the operation and a stale
   revision produces a recoverable conflict.
9. With a second listener account, confirm the first account's Playlist ID is
   indistinguishable from a missing ID and never appears in sidebar, index,
   cache, logs, or telemetry.

For a new or replaced single instance, also verify that the Certbot bootstrap
and renewal timers are loaded. If the first HTTP-01 attempt is transiently
unsuccessful, port 80 may remain available while the bootstrap timer retries
after its base and randomized delay; do not promote until a trusted certificate
is active, port 443 responds, and port 80 redirects application requests to
HTTPS. Confirm the readiness condition gates further bootstrap service work and
the twice-daily renewal timer remains active.

When the target runs with `FINITUDE_ROOMS_ENABLED=true`, confirm that Nginx
forwards WebSocket handshakes before any room smoke flow. This probe sends a
well-formed handshake with a synthetic ticket and a foreign `Origin`, so the
gateway refuses it before any ticket lookup or room work:

```bash
curl --http1.1 -sS -o /dev/null -w '%{http_code} %{size_download}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Protocol: archtree-room-v1, AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' \
  -H 'Origin: https://probe.invalid' \
  https://<target-host>/api/social/v1/realtime
```

`403 0` means the upgrade reached the room gateway. A `401` with a non-zero
size is Express's JSON response, so the proxy dropped `Upgrade`/`Connection`;
`503 0` means the realtime path is not admitting: no authority lease, draining,
or rooms switched off (a process started with rooms off refuses every upgrade;
see the [social rollout runbook](social-rollout-runbook.md)). `429 0` means the
gateway's per-IP upgrade attempt, pending-upgrade or per-address limiter refused
the request; wait and retry. `401 0` means the upgrade reached the gateway, but
`Sec-WebSocket-Protocol` arrived malformed or stripped (or `Origin` was
missing): the subprotocol is checked before the `Origin` comparison. Then
confirm that a signed-in test account's room connects over `wss://` in the
browser.

Before enabling rooms on a target, confirm the room audio decoder: the deployment
log shows the pinned FFmpeg install verified by size and SHA-256,
`/usr/local/bin/ffmpeg -hide_banner -version` runs on the instance, and a short
original MP3 uploaded through Content Manager is listed as eligible on the Room
audio analysis page. Run the [room audio catalog backfill](../features/social-and-rooms.md#room-audio-catalog-backfill) (dry run first)
for existing tracks after this check passes.

Run the checked-in media workload only on a target explicitly approved for
load testing. Remote targets require `ALLOW_REMOTE_MEDIA_LOAD=1` and an exact
`MEDIA_LOAD_ALLOWED_HOSTS` entry. Retain only its aggregate result and server
metrics; do not record content IDs, signed URLs, or validators.

Do not promote while any of these checks is failing or while staging metrics
show unexplained authentication, API, artwork, or playback errors.

Before production promotion, complete the recorded current/previous branded-
browser matrix and the agreed physical-device and assistive-technology checks
against staging. Keep this evidence separate from the automated Playwright
engine matrix.

## 3. Promote the same artifact

Promote the exact staging-tested archive to production. For the single-instance
environment, treat replacement or restart as a user-visible risk and use the
approved maintenance/traffic procedure. During and after deployment, watch:

- Elastic Beanstalk environment health and process restarts;
- HTTPS bootstrap/renewal unit state, port 443, and the port 80 redirect;
- `/health` media admission, rejection, and 5xx outcomes by resource;
- listener page/API/playback error telemetry, split only by bounded audio/video
  failure class;
- authentication success and refresh failures;
- Web Vitals p75 once the agreed traffic sample is large enough.

Repeat the staging smoke checks using production-safe test accounts and media.
Do not run the load harness against production unless that exact target and
traffic level were separately authorized.

Keep `FINITUDE_PLAYLISTS_ENABLED=false` for the initial production deployment.
After shared health checks and index verification pass, explicitly enable it,
confirm the public capability response, and then run the production-safe
Playlist smoke flow. A cohort rollout requires separate environment or traffic
routing controls; this binary flag alone does not select individual accounts.

## 4. Roll back

Rollback is mandatory for an unexplained health failure, release-blocking
authentication or playback regression, private-data exposure, data-integrity
risk, sustained server errors, or a stop condition agreed before rollout.

For a Playlist-specific stop condition, set `FINITUDE_PLAYLISTS_ENABLED=false`
first to reject new Playlist traffic while retaining every Playlist and receipt.
This containment switch is not a substitute for application rollback when the
release also affects authentication, playback, or shared infrastructure.

1. Stop further promotion and record the first failing signal and time without
   copying credentials, content IDs, URLs, or raw user data.
2. Select the immediately previous known-good retained archive. Verify its
   `RELEASE.json` and recorded base-path contract; do not rebuild the previous
   commit.
3. Redeploy that exact archive through the normal Elastic Beanstalk version
   mechanism and wait for environment health to stabilize.
4. Repeat `/health`, landing/listener deep links, login/refresh, attached
   artwork, and MediaTrack Range smoke checks using that archive's own route
   contract. A pre-migration archive may serve `/listen` rather than
   `/finitude`; testing it only through the newer path would be a false
   rollback failure. Separately verify the prepared compatibility redirect so
   user-visible `/finitude` deep links remain usable after rollback.
5. Confirm error and media-admission metrics returned to the prior baseline,
   then record the rollback artifact identity and outcome.

Application rollback does not guarantee reversal of persistent instance
infrastructure such as issued TLS certificates or systemd timer state. Inspect
those separately if a release changed `.platform` or `.ebextensions`. The HTTPS
timer installer keeps a stable copy of the configurator under
`/usr/local/sbin`, so explicitly verify that persisted copy and both timer unit
definitions when rolling back across this recovery change. The pinned FFmpeg under
`/opt/archtree-ffmpeg` and its `/usr/local/bin` links also persist across an
application rollback. An older release can still reach that decoder through
`ROOM_AUDIO_FFMPEG_PATH` or PATH; remove them by hand only if the rollback must
also remove the decoder. Analysis results written by the backfill remain valid. The
additive Playlist collections and receipts must remain intact during rollback;
the previous application may ignore them, but rollback must not delete listener
data or remove their indexes. Playlist artwork has no persistent derivative or
storage cleanup step.

## Evidence record

Retain the following with the release ticket or approved evidence store:

| Field | Required value |
| --- | --- |
| Candidate | `RELEASE.json` commit SHA and build ID |
| Previous version | Previous `RELEASE.json` commit SHA and build ID |
| CI | Workflow run and result; unit, build, browser/axe, artifact gates |
| Integration | Exact candidate source identity and Mongo-backed suite result |
| Linux visual | Reviewed baseline identity and no-update CI result |
| Staging | Target environment/version, timestamp, tester, smoke result |
| Owners | Release owner and rollback owner |
| Observation contract | Observation window and explicit stop conditions |
| Manual browser/AT | Browser/device/OS/assistive technology, tester, date, result |
| Load | Approved target class, source count, bounded configuration, aggregate result |
| Production | Environment/version, start/end time, owner, smoke result |
| Observation | Window, traffic profile, health/error/Web Vitals summary |
| Rollback rehearsal | Previous artifact and route contract, compatibility redirect, start/end time, smoke result |
| Exceptions | Accepted difference, owner, expiry/follow-up |

### Verified release and served Web bytes — checked 2026-10-12

| Check | Evidence and limit |
| --- | --- |
| Pull-request gate | [Run 38169379414](https://github.com/yangyinxu/Archtree/actions/runs/38169379414), source `7fd123132a45869c20ba68679db0abe2303d5bcc`, created 2026-10-11 19:45:43 UTC: all five release jobs passed on Ubuntu 24.04. |
| Merged-main gate | [Run 38170519764](https://github.com/yangyinxu/Archtree/actions/runs/38170519764), source `2c1cf6e37e9ea95bf13b8218a153f3e3aa5b45cc`, created 2026-10-11 20:02:22 UTC: all five release jobs passed and the tested deployment artifact was retained. |
| Browser coverage | Each run passed social 17/17, including Firefox/WebKit compressed audio and recovery with zero retries, and listener 347 with ten intentional skips for Chromium-owned checks. The listener gate used all three engines and strict `--update-snapshots=none`. |
| Public Web bytes | `/finitude/` HTML and its four directly referenced JS/CSS resources matched the retained main artifact above byte for byte on 2026-10-12. This does not independently identify the backend's on-instance `RELEASE.json`. |
| Remaining production acceptance | Remaining authentication email/link acceptance, the controlled Rooms enablement and observation, and the rollout/rollback smoke checks remain separate from CI and static Web-byte matching. Production rooms remain disabled pending those checks. |

### Production authentication and media checks — 2026-10-12

| Check | Evidence and limit |
| --- | --- |
| Registration and replay | The operator completed registration for the approved QA account, signed in, and observed **Email verified** in Account. Reopening the original T1 registration link was rejected within its 30-minute validity period. |
| Already-registered email | T2 was received for that account; its login and forgot-password links used the production origin and contained no token. |
| Password-reset email | A requested reset email was received with a six-digit code. Reset completion and session revocation were not exercised; T3 and legacy verification also remain open. |
| New public audio | The administrator created each approved fixture below once through Content Manager. One credential-free public search found exactly one ready/published audio match per title. All three passed canonical HEAD plus two Range checks against their original fixture bytes. The initial checker passed 2/3 because it required `audio/mp4` for AAC, while canonical streaming uses its stored `audio/x-m4a`. An explicit supplemental canonical check passed: AAC HEAD returned 200, 1,941,885 bytes and a strong ETag; both 256-byte ranges returned 206 and matched the fixture. The initial checker failure is retained; this supplemental result does not exercise pinned Room media. |
| New-source Room eligibility | After a normal administrator SPA refresh restored Content Manager access, the Operations link opened the actual Room audio analysis page. Reviewing all four pages found the three exact QA titles below marked **Ready for rooms**. Upload had analyzed them automatically; no manual Analyze action was needed. This closes eligibility for these three new sources only, not fresh decoding of the older 94-source inventory. |
| Ordinary production playback | In the isolated signed-in QA in-app browser with both flags off, each exact public Search result was selected once into a single-track queue. Each used one DOM media element and its correct canonical URL without a query, reported duration 120 seconds, no media error and `readyState=4`, and advanced its clock by more than one second while playing. Pause plus keyboard Home and five PageUp actions sought to 60 seconds while preserving pause and a stable clock; explicit Play resumed clock advancement. VBR briefly reported `readyState=1` after seeking, then reached 4 while still paused before Play. Next was disabled as expected for each single-track queue; queue advancement was not tested. The final QA player was paused. This closes ordinary playback only in that in-app browser, not audible output, Room/pinned-media/synchronization, other browsers or physical devices. |
| Rooms boundary | Pinned Room-media responses, including AAC's required `audio/mp4` MIME type, and actual Room playback are not yet proved. Both production flags remain false; the controlled Rooms window still requires approval, and no flags-on test, playing-room redeployment or kill-switch rehearsal has run. The remaining rollout/rollback checks stay open. |
| SES sandbox decision | The operator intentionally deferred production access and chose to retain the sandbox. The prepared request was cancelled; the console returned to its Sandbox setup page without terms or submission controls, and no request was submitted. Testing may continue only with approved, SES-verified recipients; public delivery to ordinary recipients is not ready. This decision does not close the remaining authentication checks or approve a Rooms test window. |

These public fixture identities connect the upload, public search and administrator
eligibility evidence. Pinned-media and Room-playback checks remain separate:

| Exact public title | MediaTrack ID | Type |
| --- | --- | --- |
| Finitude QA 2026-10-12 — CBR MP3 | `6acd6a6548717d54937d7116` | `audio` |
| Finitude QA 2026-10-12 — AAC-LC | `6acd6ada48717d54937d7118` | `audio` |
| Finitude QA 2026-10-12 — VBR MP3 | `6acd6aea48717d54937d711a` | `audio` |

This runbook defines the rollback contract. Release execution is not complete
until the candidate and previous exact CI archives are confirmed retained, and
an actual staging rollout and rollback have both been rehearsed with their
evidence attached.
