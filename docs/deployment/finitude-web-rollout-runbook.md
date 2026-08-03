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
- This release has no database migration and its display-size artwork variants
  are transient responses. It does not create, replace, or delete S3 objects.

## 1. Prepare and identify the candidate

The release workflow runs unit/component tests, production builds, the
three-engine browser/axe gate, and artifact staging before retaining a
commit-named rollback bundle. For a local artifact verification run:

```bash
npm ci
npm test
npm run build
npm run stage:eb-artifact
```

Local staging requires a clean committed worktree so `RELEASE.json` cannot
misidentify uncommitted bytes. CI supplies the immutable source identity
directly.

Before promotion, verify all of the following:

- CI is green for the commit recorded in `RELEASE.json`.
- The candidate bundle is the artifact retained by that same CI run.
- The previous known-good bundle and its `RELEASE.json` are retrievable.
- The staging environment uses production-equivalent MongoDB/S3 contracts and
  contains no production customer credentials or unapproved test traffic.
- A release owner, rollback owner, observation window, and stop conditions are
  recorded before deployment starts.

Stop if the candidate or previous version cannot be identified exactly.

## 2. Deploy and verify staging

Deploy the retained candidate bundle to the approved staging Elastic
Beanstalk environment. Do not deploy a newly generated archive from a local
worktree. Wait for the environment and `/health` to report healthy, then record
the deployment version and candidate release identity.

Run these checks against the staging origin:

1. `GET /health` returns 200 and identity-free media delivery metrics.
2. `GET /`, `GET /listen`, and a direct listener deep link such as
   `GET /listen/search` return successfully over HTTPS.
3. Listener HTML references hashed `/listen/assets/` resources, and those
   resources return immutable cache headers.
4. The landing-page Finitude entry opens `/listen`; password login, logout,
   refresh, and the signed-out Library state behave normally.
5. A known public, currently attached artwork ID returns WebP from
   `/content/images/:imageId/v1/320.webp`, with an ETag, positive
   `Content-Length`, and `public, no-cache` revalidation.
6. A ready track returns 206 for a small `Range` request, the expected
   `Content-Range`, and the same ETag used by its preflight response.
7. Home, Search, Album, Artist, Library, Account, compact player, and expanded
   player complete their core smoke flows without a console or telemetry leak.

Run the checked-in media workload only on a target explicitly approved for
load testing. Remote targets require `ALLOW_REMOTE_MEDIA_LOAD=1` and an exact
`MEDIA_LOAD_ALLOWED_HOSTS` entry. Retain only its aggregate result and server
metrics; do not record content IDs, signed URLs, or validators.

Do not promote while any of these checks is failing or while staging metrics
show unexplained authentication, API, artwork, or playback errors.

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

## 4. Roll back

Rollback is mandatory for an unexplained health failure, release-blocking
authentication or playback regression, private-data exposure, data-integrity
risk, sustained server errors, or a stop condition agreed before rollout.

1. Stop further promotion and record the first failing signal and time without
   copying credentials, content IDs, URLs, or raw user data.
2. Select the immediately previous known-good retained archive. Verify its
   `RELEASE.json`; do not rebuild the previous commit.
3. Redeploy that exact archive through the normal Elastic Beanstalk version
   mechanism and wait for environment health to stabilize.
4. Repeat `/health`, landing/listener deep links, login/refresh, attached
   artwork, and audio Range smoke checks.
5. Confirm error and media-admission metrics returned to the prior baseline,
   then record the rollback artifact identity and outcome.

Application rollback does not guarantee reversal of persistent instance
infrastructure such as issued TLS certificates or systemd timer state. Inspect
those separately if a release changed `.platform` or `.ebextensions`. The
current artwork change has no persistent derivative or storage cleanup step.

## Evidence record

Retain the following with the release ticket or approved evidence store:

| Field | Required value |
| --- | --- |
| Candidate | `RELEASE.json` commit SHA and build ID |
| Previous version | Previous `RELEASE.json` commit SHA and build ID |
| CI | Workflow run and result; unit, build, browser/axe, artifact gates |
| Staging | Environment/version, timestamp, tester, smoke result |
| Load | Approved target class, source count, bounded configuration, aggregate result |
| Production | Environment/version, start/end time, owner, smoke result |
| Observation | Window, traffic profile, health/error/Web Vitals summary |
| Rollback rehearsal | Previous artifact used, start/end time, smoke result |
| Exceptions | Accepted difference, owner, expiry/follow-up |

The checked-in runbook and retained bundles establish the rollback contract;
Phase 7 is not complete until an actual staging rollout and rollback have both
been rehearsed and their evidence is attached.
