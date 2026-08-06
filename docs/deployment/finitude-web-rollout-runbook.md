# Finitude Web Rollout and Rollback Runbook

This runbook governs promotion of the Finitude Web listener and its Archtree
server routes. It records operational evidence; product behavior remains
canonical in [`../business-rules.md`](../business-rules.md).

## Release invariants

- Promote the exact tested Elastic Beanstalk bundle. Never rebuild between
  staging, production, or rollback.
- Every candidate contains `RELEASE.json` with the source commit and CI build
  identity. Record both values with the deployment evidence.
- Keep the immediately previous successful bundle available until the release
  has passed its agreed observation window.
- The bundle must contain only the explicit runtime allowlist produced by
  `npm run stage:eb-artifact`; credentials and `.env` files must remain in the
  deployment environment.
- The Playlist release adds private `playlists` and account-mutation receipt
  collections plus their owner, replay, and expiry indexes. These changes are
  additive and own no S3 objects; verify every required production index before
  enabling Playlist traffic.
- `FINITUDE_PLAYLISTS_ENABLED` is fail-closed in production: an omitted value
  keeps Playlist APIs and Web entry points disabled. Enabling or stopping the
  release requires an explicit `true` or `false` deployment value.

## 1. Prepare and identify the candidate

The release workflow runs unit/component tests, Mongo-backed lifecycle
integration tests, production builds, the three-engine browser/axe gate, and
artifact staging before retaining a commit-named rollback bundle. Integration
coverage is required for the account, Playlist, transaction, S3, and content-
reference lifecycle; do not infer it from unit or browser results. For a local
artifact verification run:

```bash
npm ci
npm test
npm run test:integration
npm run build
npm run typecheck:e2e --workspace @archtree/finitude-web
CI=1 npm run test:e2e --workspace @archtree/finitude-web -- \
  --update-snapshots=none
git diff --check
npm run stage:eb-artifact
```

Local staging requires a clean committed worktree so `RELEASE.json` cannot
misidentify uncommitted bytes. CI supplies the immutable source identity
directly.

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

Stop if the candidate or previous version cannot be identified exactly. Also
stop the first base-path migration if rollback would leave `/finitude` deep
links unavailable and no tested compatibility redirect exists.

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
6. A ready track returns 206 for a small `Range` request, the expected
   `Content-Range`, and the same ETag used by its preflight response.
7. Home, Search, Album, Artist, Library, Account, compact player, and expanded
   player complete their core smoke flows without a console or telemetry leak.
8. With one listener account, create, rename, add, reorder, play from the
   middle, remove, and delete a Playlist. Confirm a lost-response retry with
   the same idempotency key does not duplicate the operation and a stale
   revision produces a recoverable conflict.
9. With a second listener account, confirm the first account's Playlist ID is
   indistinguishable from a missing ID and never appears in sidebar, index,
   cache, logs, or telemetry.

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
- `/health` media admission, rejection, and 5xx outcomes by resource;
- listener page/API/playback error telemetry;
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
   artwork, and audio Range smoke checks using that archive's own route
   contract. A pre-migration archive may serve `/listen` rather than
   `/finitude`; testing it only through the newer path would be a false
   rollback failure. Separately verify the prepared compatibility redirect so
   user-visible `/finitude` deep links remain usable after rollback.
5. Confirm error and media-admission metrics returned to the prior baseline,
   then record the rollback artifact identity and outcome.

Application rollback does not guarantee reversal of persistent instance
infrastructure such as issued TLS certificates or systemd timer state. Inspect
those separately if a release changed `.platform` or `.ebextensions`. The
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

This runbook defines the rollback contract. Release execution is not complete
until the candidate and previous exact CI archives are confirmed retained, and
an actual staging rollout and rollback have both been rehearsed with their
evidence attached.
