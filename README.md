# Archtree

Archtree is an Express + TypeScript service for authentication, content
management, and media upload/streaming. It also hosts the React-based Finitude
Web listener under `/finitude`.

Product behavior shared by the backend and iOS client is documented in
[`docs/business-rules.md`](docs/business-rules.md).

## Code Documentation

Classes, types, and functions should have concise comments describing their
responsibility or non-obvious constraints. Comments should explain intent
rather than repeat the code and must stay synchronized with behavior.

## Tech Stack

- Node.js 24
- Express
- TypeScript (runtime via tsx)
- React + Vite
- MongoDB
- AWS S3 (audio object storage)

## Scripts

- `npm run dev`: start development server
- `npm run dev:web`: start the listener Vite server at `/finitude/`; run the
  Express development server separately so API requests can be proxied
- `npm start`: start production-mode server
- `npm run build`: type-check the server and build the listener bundle
- `npm test`: run server and listener unit/component tests
- `npm run test:e2e`: run the production listener bundle against Chromium,
  Firefox, and WebKit with accessibility checks
- `npm run test:e2e:chromium`: run the faster Chromium-only browser gate
- `npm run typecheck:e2e --workspace @archtree/finitude-web`: type-check the
  Playwright configuration, fixtures, and browser specs without launching a
  browser
- `npm run test:integration`: run transactional authentication, account,
  Playlist, storage, and content-reference lifecycle tests against a disposable
  single-node MongoDB replica set
- `npm run test:media-load`: run the bounded audio Range, seek/abort, artwork,
  and health-recovery workload against an explicitly authorized environment
- `npm run stage:eb-artifact`: validate and stage the exact allowlisted Elastic
  Beanstalk runtime tree in `elastic-beanstalk-artifact`

The integration suite requires a trusted `mongod` executable on `PATH`. On
macOS, approve or install that binary according to the machine's security
policy before running the suite; the tests never weaken Gatekeeper themselves.
The Linux release workflow installs the pinned, GPG-verified MongoDB Community
server package from MongoDB's official Ubuntu repository before running this
gate.
Each run owns a uniquely prefixed temporary database directory, verifies its
removal during teardown, and conservatively removes abandoned test directories
whose recorded owner process is no longer running.

Notes:
- The previous `prod` alias was removed to keep scripts minimal.
- Runtime startup should be configured in your deployment target (Elastic Beanstalk, ECS, App Runner, etc.).

## Environment Variables

Required variables:

- `DB_CONN_STRING`: MongoDB connection string
- `DB_NAME`: MongoDB database name (required; no runtime fallback)
- `DB_CONNECT_TIMEOUT_MS`: maximum MongoDB connection setup time (defaults to 10000)
- `DB_SERVER_SELECTION_TIMEOUT_MS`: maximum MongoDB server selection time (defaults to 10000)
- `DB_SOCKET_TIMEOUT_MS`: maximum MongoDB socket inactivity time (defaults to 120000)
- `DB_WAIT_QUEUE_TIMEOUT_MS`: maximum wait for a pooled MongoDB connection (defaults to 10000)
- `DB_MAX_POOL_SIZE`: maximum MongoDB connections per server process (defaults to 100)
- `JWT_SECRET`: JWT signing secret
- `AUTH_CODE_PEPPER`: optional separate HMAC secret for verification and reset
  codes (defaults to `JWT_SECRET`)
- `AUTH_EMAIL_FROM`: AWS SES verified sender used for verification and reset mail
- `ACCESS_TOKEN_MINUTES`: short-lived access-token lifetime from 1 to 60 minutes (defaults to 15)
- `ACCESS_TOKEN_SECONDS`: development-only access-token lifetime from 1 to 300 seconds
  for fast refresh-rotation testing (ignored in production)
- `REFRESH_SESSION_DAYS`: rotating refresh-session lifetime from 1 to 90 days (defaults to `SESSION_DAYS`, then 30)
- `ALLOW_LEGACY_AUTH_TOKENS`: temporary `true` opt-in for accepting and issuing
  old non-revocable app tokens during a coordinated client rollout (defaults to
  `false`; remove after migration)
- `BROWSER_ALLOWED_ORIGINS`: optional comma-separated additional exact origins
  for cookie-authenticated browser mutations; same-origin requests are always
  accepted
- `FINITUDE_PLAYLISTS_ENABLED`: set to `true` to expose Playlist APIs and Web
  entry points, or `false` for an emergency rollout stop without deleting
  Playlist or mutation-receipt data. An omitted value defaults to disabled in
  production and enabled in non-production environments.
- `AWS_ACCESS_KEY_ID`: AWS access key for S3 operations
- `AWS_SECRET_ACCESS_KEY`: AWS secret key for S3 operations
- `AWS_REGION`: AWS region
- `S3_BUCKET_NAME`: target S3 bucket for audio uploads
- `S3_CONNECTION_TIMEOUT_MS`: maximum S3 connection setup time (defaults to 5000)
- `S3_REQUEST_TIMEOUT_MS`: maximum S3 socket inactivity time (defaults to 60000)
- `S3_SUMMARY_WAIT_TIMEOUT_MS`: maximum content-manager wait for an S3 summary refresh (defaults to 2000)
- `MAX_AUDIO_BATCH_UPLOAD_MB`: maximum aggregate multipart request size for bulk audio uploads (defaults to 1024)
- `MAX_AUDIO_BATCH_FILES`: maximum files accepted in one bulk upload (defaults to 5)
- `MAX_IMAGE_UPLOAD_MB`: maximum cover-art upload size in MiB (defaults to 10
  and is hard-capped at 25 so public derivative work remains byte-bounded)
- `MAX_VIDEO_STREAM_CHUNK_MB`: largest video byte range returned per request (defaults to 4)
- `MAX_MEDIA_REQUESTS_PER_IP`: concurrent public media requests allowed per client IP (defaults to 8)
- `MAX_MEDIA_REQUESTS_GLOBAL`: concurrent public media requests allowed per server process (defaults to 40)
- `MEDIA_PLAYBACK_RESERVED_PER_IP`: slots within the per-client media limit
  reserved from artwork, avatar, video, and download traffic for playback
  (defaults to 25% of the configured limit, currently 2)
- `MEDIA_PLAYBACK_RESERVED_GLOBAL`: slots within the process media limit
  reserved from non-playback traffic (defaults to 40% of the configured limit,
  currently 16)
- `MAX_RECONCILIATION_OBJECTS`: safety ceiling for storage objects and
  content-reference source records in one reconciliation report (defaults to
  50000)
- `MAX_RECONCILIATION_REFERENCES`: report-wide scan ceiling for embedded
  content, activity, Page, Carousel, Grid/List, and Playlist references and for
  total reference findings (defaults to 50000)
- `MAX_STORAGE_SUMMARY_OBJECTS`: safety ceiling for synchronous S3 storage summaries (defaults to 1000000)
- `TRUST_PROXY_HOPS`: trusted reverse-proxy hop count; the single-instance
  Elastic Beanstalk Nginx configuration uses 1
- `HTTPS_DOMAIN`: production API hostname used for the single-instance Elastic
  Beanstalk certificate and Nginx virtual host
- `ACME_EMAIL`: operational email address used for Let's Encrypt registration
  and expiry notices
- `S3_STORAGE_COST_PER_GB_MONTH`: optional S3 Standard storage rate used for the Content Manager estimate (defaults to `$0.023` per GiB-month)
- `PORT`: optional explicit HTTP port (preferred in cloud environments)

### Verify refresh-token rotation locally

Stop any existing Archtree process, then start the development server with its
dedicated five-second access-token lifetime:

```bash
npm run dev:auth-rotation
```

Sign in again after restarting the server, wait at least five seconds, then refresh
an authenticated screen in the iOS app. The Xcode console reports the expired
access token, successful refresh-token rotation, and successful retry without
printing either token. The server console emits a `refresh_succeeded` security
event only after the stored refresh-token hash has been atomically replaced.

Security:
- Do not commit real credentials.
- Store production secrets in AWS Secrets Manager or SSM Parameter Store.
- Express applies one deployment-wide Content Security Policy before static
  files and routers. Scripts, forms, API requests, and audio stay same-origin;
  images additionally allow HTTPS cover art plus `blob:`/`data:` previews.
  Listener HTML, assets, and APIs use strict same-origin styles. Inline-style
  compatibility is limited to the existing server-rendered Content Manager,
  legacy login result page, and HTML audio-storage audit. Framing, plugins,
  base-tag rewriting, inline script attributes, camera, microphone, geolocation,
  and other unused browser capabilities are blocked.
- Listener HTML, static assets, API responses, and errors also receive
  `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, and
  `Permissions-Policy` headers.
- Production browser session cookies are host-only, `Secure`, `HttpOnly`, and
  use `SameSite=Lax` for the short-lived access cookie and `SameSite=Strict`
  for the rotating refresh cookie. Local development omits `Secure` so HTTP
  loopback testing continues to work.
- Production authentication routes reject requests unless trusted proxy headers
  identify an HTTPS connection. The single-instance Elastic Beanstalk setup in
  `.platform/hooks` obtains and renews a Let's Encrypt certificate, terminates
  TLS in Nginx, and redirects the configured domain from HTTP to HTTPS.
- Deferred production infrastructure work is tracked in
  [`docs/deployment-todos.md`](docs/deployment-todos.md).

## Local Run

1. Install dependencies:
   - `npm install`
2. Configure `.env`.
3. Start server:
   - `npm run dev`

To develop the listener with hot reload, keep the server running and start a
second process with `npm run dev:web`, then open
`http://localhost:5173/finitude/`. For a production-style local run, use
`npm run build` first; Express then serves the generated `web/dist` bundle at
`/finitude` and supports listener deep links. Requests to the legacy `/listen`
prefix permanently redirect to the equivalent `/finitude` path. The Web build
measures every initial route's unique compressed JavaScript and fails if any
route exceeds the reviewed 150 KiB gzip budget. It also caps the complete
emitted stylesheet payload at 32 KiB gzip, emitted fonts at 128 KiB, bundled
images at 256 KiB total, and any one bundled image at 128 KiB. Catalog artwork
continues to load through listener DTOs rather than being bundled into the app.

Install the version-matched browser runtimes once before running the local
browser gate:

```bash
npx playwright install chromium firefox webkit
npm run typecheck:e2e --workspace @archtree/finitude-web
CI=1 npm run test:e2e --workspace @archtree/finitude-web -- --update-snapshots=none
```

Chromium owns the reviewed deterministic pixel baselines; Firefox and WebKit
retain behavior and accessibility coverage. Review intentional visual changes
before creating or updating any named Chromium screenshot rather than bulk-
refreshing snapshots to make a failure pass. Snapshot paths are platform-
scoped so one operating system never silently approves another system font's
rendering.

The listener reads browser-safe content from `/api/listener/v1`. The versioned
namespace provides Home, Search, Album, Artist, Track, and authenticated Library
responses without exposing storage lifecycle fields. Public audio streaming is
limited to database-confirmed `ready` tracks and preserves HTTP Range seeking.
Legacy native-client reads under `/content` and `/feed` also remain available
without authentication. Their Artist, Album, Soundtrack, Page, Carousel,
Grid/List, and Feed Post responses use explicit public projections rather than
raw MongoDB documents. Soundtrack list, search, Album relationship, personalized
section, and expanded-page queries require a published (or legacy) Track with
`uploadStatus: ready` and an S3 key bound to that Track ID before applying item
limits or pagination. Public responses do
not expose `createdBy`, `updatedBy`, `coverArtId`, object keys, upload errors,
original filenames, or lifecycle timestamps. Feed Posts retain only their
existing opaque author reference; it cannot be used to read private account or
avatar data.
Finitude Web is streaming-only and exposes no Download action, Download filter,
offline state, or browser-local media lifecycle; native-client downloads remain
a separate product capability.
Public artwork resolution similarly permits only ready Artist, Album, and
Soundtrack image assets that their current owner still references; account
avatars remain private behind `/auth/avatar`. Finitude Web derives responsive
96, 192, 320, 480, 640, 960, and 1280 px square WebP responses from
`/content/images/:imageId/v1/:width.webp`. They are versioned, revalidated,
CPU-concurrency bounded responses and never create extra S3 objects; the
original image route remains the fallback and native-client contract.
The Archtree landing page links both signed-out and signed-in visitors to
`/finitude` while preserving its existing content-management and authentication
actions. Content-management actions are rendered only for administrators.

`POST /api/listener/v1/telemetry` accepts only same-origin JSON envelopes of
one to ten bounded anonymous events. It has an independent 16 KiB body limit,
rate/concurrency protection, no cookie requirement, no retry contract, and no
fields for identity, credentials, content/search text, URLs, or raw errors.
`GET /health` is `no-store` and exposes process-local, identity-free media
admission and stream outcomes split across playback, download, artwork,
avatar, and video. The shared 40/8 process/client ceiling reserves 16/2 slots
from non-playback traffic so artwork-heavy pages cannot consume all playback
capacity.

### Verify media Range behavior under bounded load

The media load command targets `http://127.0.0.1:8081` by default and requires
one or more database-confirmed ready audio-track ObjectIds. It checks `HEAD`,
full and partial responses, open-ended and suffix ranges, invalid ranges,
overlapping seek cancellation, concurrent fixed-width WebP artwork (including
its type, validator, size, and revalidation contract), and `/health`
recovery.
The command enforces maximums of 32 simulated clients and 1,000 total requests
and emits only one aggregate JSON result; it does not print URLs, content IDs,
ETags, or Range values.

For a production-equivalent staging target, remote traffic requires both an
explicit opt-in and an exact hostname allowlist:

```bash
MEDIA_LOAD_BASE_URL=https://staging.example.com \
MEDIA_LOAD_ALLOWED_HOSTS=staging.example.com \
ALLOW_REMOTE_MEDIA_LOAD=1 \
MEDIA_LOAD_TRACK_IDS=<ready-audio-track-object-id> \
MEDIA_LOAD_ARTWORK_IDS=<public-artwork-object-id> \
MEDIA_LOAD_CLIENTS=12 \
MEDIA_LOAD_ARTWORK_CONCURRENCY=4 \
npm run test:media-load
```

Run this only in an environment approved for load testing. The harness models
concurrent clients from one runner; release evidence still needs approved
multi-source staging traffic against the real media store.

## AWS CodeBuild

This repo includes `buildspec.yml` with CI-oriented behavior:

- `install`: `npm ci`
- `build`: `npm test`, then `npm run build --if-present`
- `post_build`: stages and validates the explicit Elastic Beanstalk runtime
  allowlist before packaging

Artifact packaging includes only the root package/lock/TypeScript files,
server source, Web runtime package plus built distribution, `.platform`, and
`.ebextensions`. It rejects nested dependencies, environment files, test
reports, symbolic links, missing or unhashed Vite assets, and non-executable
platform hooks. `RELEASE.json` records the source commit and build identity;
Elastic Beanstalk performs a clean dependency install on each instance.

The separate `.github/workflows/finitude-web-release.yml` gate follows the
Playwright CI installation flow and runs unit/component tests, the Mongo-backed
lifecycle integration suite, both production builds, and all three browser/axe
projects on pull requests and pushes to `develop` or `main`. Browser traces,
screenshots, videos, JUnit output, and the HTML report are retained as workflow
artifacts. A missing or failed integration environment blocks artifact staging.

After the browser gate, CI retains a commit-named Elastic Beanstalk ZIP for 30
days so staging and production can promote the same tested bytes and the
previous successful version remains directly deployable. Follow
[`docs/deployment/finitude-web-rollout-runbook.md`](docs/deployment/finitude-web-rollout-runbook.md)
for the smoke, observation, evidence, and rollback contract. A retained bundle
and runbook do not replace the required production-equivalent rollout and
rollback rehearsal.

### Single-instance Elastic Beanstalk HTTPS

This repository supports direct TLS termination on a single-instance Amazon
Linux 2023 Elastic Beanstalk environment without a load balancer:

1. Point the Route 53 record at the environment and allow it to propagate.
2. Set `HTTPS_DOMAIN`, `ACME_EMAIL`, and `TRUST_PROXY_HOPS=1` in the environment.
3. Deploy with ports 80 and 443 allowed. The included `.ebextensions` resource
   admits port 443 on the instance security group.

The first successful post-deployment run obtains a public Let's Encrypt
certificate through the HTTP-01 challenge, enables port 443, and redirects
requests for `HTTPS_DOMAIN` to HTTPS. If DNS is not ready, deployment remains
healthy over HTTP and a later deployment retries issuance. A systemd timer
checks renewal twice daily. Certificate files remain on the instance, so
replacing the single instance requires issuance again; Let's Encrypt rate
limits should be considered before repeated environment rebuilds.

Important:
- Build phase should not run `npm start`.
- Runtime process startup should happen in the deployment service configuration.

## Browser Auth and Content Management

Web auth endpoints:

- `GET /auth/signup-web`
- `POST /auth/signup-web`
- `GET /auth/login-web`
- `POST /auth/login-web`
- `POST /auth/logout-web`

Listener browser-session endpoints (HttpOnly cookies; credentials are never
returned to JavaScript):

- `GET /auth/browser/capabilities`
- `POST /auth/browser/register`
- `POST /auth/browser/email/verify`
- `POST /auth/browser/email/resend-verification`
- `POST /auth/browser/password/forgot`
- `POST /auth/browser/password/reset`
- `POST /auth/browser/login`
- `POST /auth/browser/refresh`
- `GET /auth/browser/session`
- `POST /auth/browser/logout`

Public Listener capability discovery:

- `GET /api/listener/v1/capabilities` returns only deploy-safe feature
  availability. The Web client uses its `playlists` boolean to hide Playlist
  routes and controls when the server-side rollout switch is off.

Browser authentication mutations require same-origin JSON. Registration,
verification resend, and recovery-request responses are deliberately generic
so account existence is not disclosed. Browser capability discovery reports
only end-to-end browser methods; native Apple, Google, or passkey configuration
does not expose a nonfunctional listener button.

App session endpoints:

- `GET /auth/capabilities`
- `POST /auth/login`
- `POST /auth/signup`
- `POST /auth/email/verify`
- `POST /auth/email/resend-verification`
- `POST /auth/password/forgot`
- `POST /auth/password/reset`
- `POST /auth/password/change`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/logout-all`
- `GET /auth/me`
- `GET /auth/avatar`
- `PUT /auth/avatar` with `If-Match` and `Idempotency-Key`
- `DELETE /auth/avatar` with `If-Match` and `Idempotency-Key`
- `GET /auth/sessions`
- `DELETE /auth/sessions/:id`
- `DELETE /auth/identities/:provider`
- `DELETE /auth/activity/listening-history`
- `DELETE /auth/account`

Account roles:

- Public registration and federated sign-in create ordinary `user` accounts.
- Only the exact database role `admin` grants shared-content management access;
  missing, legacy, or unknown role values are treated as `user`.
- There is no public role-promotion endpoint. An operator may promote or demote
  one verified account by updating that account's `users.role` field directly
  to `admin` or `user`, using an exact `_id` match and verifying that exactly
  one record matched.
- Authorization reloads the current database role for each request, so a role
  change applies without trusting a stale role claim from an access token.
- `createdBy` remains internal provenance. It does not grant an owner/creator
  role and never lets an ordinary user mutate shared content.

Shared-content authorization:

- Artist, Album, Soundtrack, audio upload, Page, Carousel, Grid/List,
  relationship, and Feed Post mutations require authentication and the exact
  database-backed `admin` role.
- Authentication and admin authorization run before JSON/form parsing for
  shared mutations and before multipart decoding, temporary-file creation,
  upload throttling, or controller work.
- Public Catalog, Search, Home, Feed, artwork, and ready stream reads do not
  require authentication and do not filter by `createdBy` or viewer role.
- Personal `/content/me/*`, account, avatar, session, activity, Save, Library,
  download, and own-Playlist operations remain owner-scoped rather than
  administrator-only.

Web content management:

- Every Content Manager page, search, form, upload, and backing shared-content
  mutation is administrator-only. Anonymous browser requests are sent to login;
  an authenticated non-admin receives `403`.
- `GET /content/manage`
- `GET /content/manage/audio-tracks`
- `GET /content/manage/search`
- Administrator inventory is global rather than `createdBy`-scoped. Artist,
  Album, Soundtrack, Page, Carousel, and Grid/List sections use stable bounded
  pagination; internal provenance remains available for audit.
- Create/update/delete forms for artists, albums, and audio tracks
- Single and bulk audio-track creation record filenames and a pending upload state before sending files to S3
- Every newly uploaded track requires at least one existing artist. `audioTrack.artistIds` is the canonical artist-to-track relationship.
- Artist responses no longer expose the legacy `audioTrackIds` field. Clients should find an artist's tracks by querying audio tracks whose `artistIds` contains the artist ID.
- Content Manager reference fields validate IDs against the expected shared content type before saving.
- Artist, album, and audio-track create/update forms accept optional JPG, PNG, or WebP cover art through the `coverArtFile` multipart field.
- Cover art is stored in the private S3 bucket and referenced by `coverArtId`. API responses derive `coverArtUrl` as `/content/images/:imageId`.
- New Artist/Album cover art reaches ready storage before the owner is inserted;
  the ready owner and exact `coverArtId` are then published in one insert, so a
  failed upload cannot expose a partially created catalog record.
- Replacing cover art attaches the new image before deleting the old object.
  For an existing owner, the post-S3 `pending` to `ready` transition rechecks
  owner readiness and commits with an exact lifecycle CAS in one short
  transaction. Deletion retains the owner and evidence while a Put is pending;
  whichever owner fence commits first determines whether deletion proceeds or
  the uploader removes the exact newly written key. A lost staging or
  finalization response proceeds only after an exact pending/ready lifecycle
  readback; otherwise it preserves the evidence and requires reconciliation.
  Deleting an Artist, Album, or Soundtrack retries every current or detached
  asset recorded for that owner before removing the owner; a storage failure
  keeps the owner and lifecycle evidence retryable.
- Existing tracks support replacing their uploaded audio file
- S3 bucket storage usage and an estimated monthly storage-only charge (requires the S3 `ListBucket` permission)

Artist carousels:

- Manual carousels keep an explicitly managed item list.
- Manual carousels can be renamed without changing their items.
- Artist carousels dynamically resolve either albums or audio tracks for one existing artist.
- Album carousels use the artist's `albumIds`; audio-track carousels query `AudioTrack.artistIds`.
- Dynamic results support newest-release or title sorting and a configurable limit from 1 to 100.
- Artist carousel items cannot be manually added, reordered, or moved between carousels.

Personalized Library:

- Authenticated users can save and unsave albums or audio tracks through
  `/content/me/saves/:contentType/:contentId`.
- Both `/content/me/library` and `/api/listener/v1/library` return private,
  allowlisted DTOs rather than catalog storage/lifecycle records. Existing
  non-ready saves remain visible as unavailable, with no stream URL; the legacy
  native Album shape retains an empty `audioTrackIds` field and resolves detail
  order separately.
- `POST /content/me/saves/status` resolves saved state for up to 100 visible
  items, and `POST /content/me/recently-played` records explicit playback
  actions.
- Personalized carousels mix albums and audio tracks from either Recently Saved
  or Recently Played and resolve for the viewer requesting an expanded page.
- Each recent history is capped at 20 mixed-content entries; the full saved
  relationship is retained separately.
- Expanded page responses include allowlisted resolved Album, Soundtrack, and
  Feed Post documents in an additive `included` payload. Referenced Posts are
  hydrated independently of the default Feed page, so older configured items
  remain discoverable.
- Included audio tracks expose `displayCoverArtUrl`, resolving track-specific
  cover art first and linked album cover art second. Linked albums used for
  this resolution are also included without transferring image ownership.
- Album cards read `Album.title`, while audio-track cards read
  `AudioTrack.title`; correct album text does not verify the encoding of a
  legacy track title.
- Audio-track titles and original filenames are normalized when read, created,
  or updated. Expanded Home and Library responses must apply the same
  normalization even though they resolve included tracks directly from the
  database.
- The iOS client accepts an `ARCHTREE_AUTH_BASE_URL` Info.plist value for
  authenticated traffic. Release builds require HTTPS; DEBUG builds additionally
  permit HTTP only for `localhost` and `127.0.0.1`.

User Playlists:

- Authenticated listeners manage private, owner-only Playlists under
  `/content/me/playlists`. Reads accept either the native Bearer session or the
  Web HttpOnly-cookie session, return only allowlisted DTOs, and use
  `Cache-Control: private, no-store`.
- `GET /content/me/playlists?limit=&cursor=` returns newest-updated summaries;
  `POST /content/me/playlists` creates one empty Playlist; and
  `GET`, `PATCH`, or `DELETE /content/me/playlists/:playlistId` reads, renames,
  or deletes an owner-scoped Playlist.
- Playlist summary and detail DTOs include a non-persisted `artworkUrl`. Read
  projection scans persisted member order and selects the first Soundtrack
  that is published, has `uploadStatus: ready`, an identity-bound `s3Key`, and usable track-specific or
  inherited Album artwork. Missing, pending, deleting, unsafe, or artwork-free
  candidates are skipped; `artworkUrl: ""` instructs clients to render the
  Finitude placeholder. List projection is bounded to 100 Playlists and 500
  member candidates each, using page-wide Soundtrack and Album reads rather
  than one catalog query per Playlist. Only single-slash same-origin paths and
  credential-free HTTPS artwork URLs are returned.
- `POST /content/me/playlists/:playlistId/items` adds one ready Soundtrack,
  optionally at a zero-based `position`;
  `DELETE /content/me/playlists/:playlistId/items/:itemId` removes one exact
  membership; and `PUT /content/me/playlists/:playlistId/items/order` accepts
  the complete current `itemIds` permutation.
- `GET /content/me/playlists/memberships?audioTrackIds=id1,id2` returns only
  the current owner's Playlist IDs containing up to 50 requested Soundtracks,
  so Add controls can show existing membership without exposing names or
  another account's data.
- Every mutation requires `Idempotency-Key`, replayable for 24 hours. A replay
  returns the original success status and rehydrates the current owner detail;
  if that Playlist was subsequently deleted, a non-delete replay returns the
  same owner-safe `404`, while a Delete receipt continues to replay `204`.
  Mutations of an existing Playlist also require its quoted revision ETag in
  `If-Match`; missing revisions return `428` and stale revisions return `409`.
  Every cookie-authenticated Web Playlist request also sends
  `X-Finitude-Account-Viewer` so a stale browser tab cannot read or mutate the
  newly switched account's private data. Bearer-authenticated native requests
  remain bound to their access-token identity.
- Names contain 1–100 trimmed Unicode characters. Each account may own at most
  100 Playlists, each containing at most 500 unique Soundtracks. Playlist order
  is explicit; unavailable members remain represented but only ready members
  are projected into playback.
- Playlist writes own no S3 objects. Deleting a Playlist does not unsave or
  delete its Soundtracks, and deleting a Soundtrack or listener account cleans
  Playlist references through the database lifecycle before final removal.

Session behavior:
- API login returns a short-lived access token and a rotating opaque refresh
  token. `authSessions` stores only SHA-256 hashes; the immediately previous
  hash is retained as revocation-only evidence so logout wins a refresh race.
- Access tokens default to 15 minutes. Refresh sessions have an absolute
  lifetime of 30 days by default.
- Refresh rotation is atomic, so a refresh token can succeed only once.
- Protected requests verify that the access token's backing session is still
  active, allowing logout and logout-all to revoke access immediately.
- Web login stores the access and refresh credentials in separate HttpOnly
  cookies and rotates them transparently when the access cookie expires.
- Cookie-authenticated Web requests for account-owned or personalized reads
  and writes send `X-Finitude-Account-Viewer` with the identity currently
  projected by the tab. The server validates it before controller work and
  echoes the same header on a successful private response. Missing or stale
  identity returns `409` with stable code `account_viewer_mismatch` without
  reading or mutating the replacement account. `GET /auth/browser/session`
  remains the unbound authoritative identity resolver, and native Bearer
  requests remain bound to their access-token identity.
- Web publishes login, logout, logout-all, account deletion, and viewer
  mismatch transitions across tabs using BroadcastChannel with a bounded
  storage-event fallback. A transition cancels in-flight queries, hides the
  previous session, removes every non-session query cache, and refetches the
  authoritative browser session; detached late responses cannot repopulate
  those caches. Account changes are intentionally treated as security
  boundaries, so public catalog data may refetch afterward.
  Storage or BroadcastChannel unavailability does not block the originating
  authentication action.
- Listener avatar reads bind private bytes to the requesting account and
  authoritative revision; a stale account projection receives no image bytes.
- Listener avatar writes and destructive account actions also bind to the
  account projected in the page. A stale tab receives a conflict instead of
  mutating whichever account most recently replaced the browser cookies.
- Avatar mutations reserve a pending account-scoped lease in the same
  transaction that touches the active account. Account deletion takes that
  fence and refuses to commit while an avatar reference, pending lease, or any
  current/detached private avatar lifecycle record remains.
- Protected web pages redirect to login if unauthenticated. Content Manager
  additionally requires the current database role to be `admin`.

## Audio Upload and Delete Lifecycle

Upload:

- API creation: `POST /content/audioTrack` as multipart form data with required `audioFile`
- API: `POST /content/audioTrack/:audioTrackId/upload`
- Form field for file: `audioFile`
- Large audio uploads are spooled to bounded temporary files and streamed to S3; they are not retained in the Node.js heap.
- Upload requests require `Content-Length`, are concurrency/rate limited, and temporary files are removed on completion or disconnect.
- Playback: `GET /content/audioTrack/stream/:audioTrackId` supports bounded single-range responses and cancels the upstream S3 request when the client disconnects.
- Legacy audio download routes redirect to the streaming endpoint and no longer buffer whole objects in server memory.
- Authorization required; admin enforced before multipart parsing or upload work
- New tracks are saved with `uploadStatus: pending` and
  `publicationStatus: pending` before S3 upload. Storage may become ready first;
  public/reference readiness is committed only when publication and the
  Album's canonical `audioTrackIds` relationship succeed in one transaction
  (or a no-Album publication condition succeeds). Legacy rows without the new
  publication field remain readable.
- Assigning or clearing a Soundtrack Album relationship transactionally removes
  that Soundtrack from every prior Album `audioTrackIds` list, updates
  `audioTrack.albumId`, and adds it to the requested Album when present. An
  empty canonical list uses reverse-link fallback only for a truly legacy Album
  whose `lifecycleStatus` field is absent; lifecycle Albums treat even an empty
  `audioTrackIds` list as authoritative.
- S3 objects include track ID, owner ID, and encoded original filename metadata.
- Failed or interrupted uploads remain identifiable in MongoDB and can be retried against the same track.
- Content Manager bulk-upload JSON responses include one `outcomes` row per
  selected file with its recoverable `audioTrackId` when a record was created,
  plus separate `uploadStatus`, `publicationStatus`, `cleanupPending`, and
  bounded `error` fields. The browser result panel preserves and displays those
  per-item lifecycle outcomes after navigation. A publication failure does not
  require re-uploading the successful storage object.

Delete:

- API: `DELETE /content/audioTrack/:audioTrackId`
- Web: content manager delete action
- Track metadata is retained until the matching S3 object has been deleted.
- Failed deletions remain marked as `deleteFailed` for reconciliation.

Reconciliation:

- Admin-only report: `GET /admin/audio-storage/reconciliation`
- Admin-only publication retry: `POST /admin/audio-storage/publication-retry`
  with `{"audioTrackIds":["..."]}` (1–100 items). It reuses existing
  database-confirmed ready objects, isolates every item, and returns stable
  outcomes for ready, non-ready, missing, malformed, and duplicate IDs without
  stopping the rest of the batch.
- Browser requests receive a readable audit page; append `?format=json` for the structured report.
- Compares every `audioTracks` record against the objects in `S3_BUCKET_NAME`.
- Reports orphaned S3 objects, database tracks with missing objects, and
  pending/failed storage or publication lifecycle records. Incomplete rows
  include `publicationStatus`, `publicationUpdatedAt`, and bounded
  `publicationError` evidence.
- The report is read-only; it never deletes S3 objects automatically.
- Admin-only image report: `GET /admin/image-storage/reconciliation`
- The image report audits the `images/` namespace against `imageAssets`, including orphaned, detached, missing, pending, and failed image records.
- Admin-only content-reference report: `GET /admin/content-references/reconciliation`
- The content-reference report detects dangling saved/activity references,
  Page-to-Carousel and Page-to-Grid/List references (including presentation
  mismatches), manual carousel and Grid/List items, artist-album links,
  album-track links, and track-album links, plus both directions of
  Album/Soundtrack mismatch (a stale canonical membership or a published
  reverse Track link missing from a lifecycle Album's canonical order);
  dangling Playlist items and missing owners; invalid Playlist mutation receipt
  ownership/targets; and stalled Soundtrack reference cleanup without mutating
  data. Page target deletion and detachment are atomic, and each reconciliation
  source scan and embedded finding remains bounded by the two limits above.

## Troubleshooting

- `EADDRINUSE`: another process is already using the chosen port.
- Buildspec path errors (`buildspect.yml` not found): check AWS buildspec override settings in CodeBuild/CodePipeline and set path to `buildspec.yml`.
- S3 upload/delete errors: verify IAM permissions and required S3 environment variables.
- `413 Request Entity Too Large`: increase upload limits in both places:
  - Nginx proxy limit via `.platform/nginx/conf.d/upload_size.conf` (`client_max_body_size`, currently 1 GB total per request)
  - App multer per-file limit via `MAX_AUDIO_UPLOAD_MB` (defaults to 512 MB)
  - Cover-art limit via `MAX_IMAGE_UPLOAD_MB` (defaults to 10 MB; maximum 25 MB)
  - Content Manager bulk uploads send files sequentially, keeping each request below the proxy limit and avoiding buffering the entire selection in memory at once.
