# Archtree

Archtree is an Express + TypeScript service for authentication, content
management, and media upload/streaming. It also hosts the React-based Finitude
Web listener under `/listen`.

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
- `npm run dev:web`: start the listener Vite server at `/listen/`; run the
  Express development server separately so API requests can be proxied
- `npm start`: start production-mode server
- `npm run build`: type-check the server and build the listener bundle
- `npm test`: run server and listener unit/component tests
- `npm run test:integration`: run transactional authentication lifecycle tests
  against a disposable single-node MongoDB replica set

The integration suite requires a trusted `mongod` executable on `PATH`. On
macOS, approve or install that binary according to the machine's security
policy before running the suite; the tests never weaken Gatekeeper themselves.
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
- `AWS_ACCESS_KEY_ID`: AWS access key for S3 operations
- `AWS_SECRET_ACCESS_KEY`: AWS secret key for S3 operations
- `AWS_REGION`: AWS region
- `S3_BUCKET_NAME`: target S3 bucket for audio uploads
- `S3_CONNECTION_TIMEOUT_MS`: maximum S3 connection setup time (defaults to 5000)
- `S3_REQUEST_TIMEOUT_MS`: maximum S3 socket inactivity time (defaults to 60000)
- `S3_SUMMARY_WAIT_TIMEOUT_MS`: maximum content-manager wait for an S3 summary refresh (defaults to 2000)
- `MAX_AUDIO_BATCH_UPLOAD_MB`: maximum aggregate multipart request size for bulk audio uploads (defaults to 1024)
- `MAX_AUDIO_BATCH_FILES`: maximum files accepted in one bulk upload (defaults to 5)
- `MAX_VIDEO_STREAM_CHUNK_MB`: largest video byte range returned per request (defaults to 4)
- `MAX_MEDIA_REQUESTS_PER_IP`: concurrent public media requests allowed per client IP (defaults to 8)
- `MAX_MEDIA_REQUESTS_GLOBAL`: concurrent public media requests allowed per server process (defaults to 40)
- `MAX_RECONCILIATION_OBJECTS`: safety ceiling for storage reconciliation reports (defaults to 50000)
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
`http://localhost:5173/listen/`. For a production-style local run, use
`npm run build` first; Express then serves the generated `web/dist` bundle at
`/listen` and supports listener deep links.

The listener reads browser-safe content from `/api/listener/v1`. The versioned
namespace provides Home, Search, Album, Artist, Track, and authenticated Library
responses without exposing storage lifecycle fields. Public audio streaming is
limited to database-confirmed `ready` tracks and preserves HTTP Range seeking.

## AWS CodeBuild

This repo includes `buildspec.yml` with CI-oriented behavior:

- `install`: `npm ci`
- `build`: `npm test`, then `npm run build --if-present`
- `post_build`: removes `node_modules` before artifact packaging

Artifact packaging intentionally excludes `node_modules` so Elastic Beanstalk performs a clean dependency install on each instance.

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
- `GET /auth/sessions`
- `DELETE /auth/sessions/:id`
- `DELETE /auth/identities/:provider`
- `DELETE /auth/activity/listening-history`
- `DELETE /auth/account`

Web content management:

- `GET /content/manage`
- `GET /content/manage/audio-tracks`
- `GET /content/manage/search`
- Create/update/delete forms for artists, albums, and audio tracks
- Single and bulk audio-track creation record filenames and a pending upload state before sending files to S3
- Every newly uploaded track requires at least one owned artist. `audioTrack.artistIds` is the canonical artist-to-track relationship.
- Artist responses no longer expose the legacy `audioTrackIds` field. Clients should find an artist's tracks by querying audio tracks whose `artistIds` contains the artist ID.
- Content Manager reference fields validate IDs against the expected owned content type before saving.
- Artist, album, and audio-track create/update forms accept optional JPG, PNG, or WebP cover art through the `coverArtFile` multipart field.
- Cover art is stored in the private S3 bucket and referenced by `coverArtId`. API responses derive `coverArtUrl` as `/content/images/:imageId`.
- Replacing cover art attaches the new image before deleting the old object. Deleting an artist, album, or audio track deletes its tracked cover-art object before removing its database record.
- Existing tracks support replacing their uploaded audio file
- S3 bucket storage usage and an estimated monthly storage-only charge (requires the S3 `ListBucket` permission)

Artist carousels:

- Manual carousels keep an explicitly managed item list.
- Manual carousels can be renamed without changing their items.
- Artist carousels dynamically resolve either albums or audio tracks for one owned artist.
- Album carousels use the artist's `albumIds`; audio-track carousels query `AudioTrack.artistIds`.
- Dynamic results support newest-release or title sorting and a configurable limit from 1 to 100.
- Artist carousel items cannot be manually added, reordered, or moved between carousels.

Personalized Library:

- Authenticated users can save and unsave albums or audio tracks through
  `/content/me/saves/:contentType/:contentId`.
- `POST /content/me/saves/status` resolves saved state for up to 100 visible
  items, and `POST /content/me/recently-played` records explicit playback
  actions.
- Personalized carousels mix albums and audio tracks from either Recently Saved
  or Recently Played and resolve for the viewer requesting an expanded page.
- Each recent history is capped at 20 mixed-content entries; the full saved
  relationship is retained separately.
- Expanded page responses include the resolved album and audio-track documents
  in an additive `included` payload.
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

Session behavior:
- API login returns a short-lived access token and a rotating opaque refresh
  token. Only a SHA-256 hash of the refresh token is stored in `authSessions`.
- Access tokens default to 15 minutes. Refresh sessions have an absolute
  lifetime of 30 days by default.
- Refresh rotation is atomic, so a refresh token can succeed only once.
- Protected requests verify that the access token's backing session is still
  active, allowing logout and logout-all to revoke access immediately.
- Web login stores the access and refresh credentials in separate HttpOnly
  cookies and rotates them transparently when the access cookie expires.
- Protected web pages redirect to login if unauthenticated.

## Audio Upload and Delete Lifecycle

Upload:

- API creation: `POST /content/audioTrack` as multipart form data with required `audioFile`
- API: `POST /content/audioTrack/:audioTrackId/upload`
- Form field for file: `audioFile`
- Large audio uploads are spooled to bounded temporary files and streamed to S3; they are not retained in the Node.js heap.
- Upload requests require `Content-Length`, are concurrency/rate limited, and temporary files are removed on completion or disconnect.
- Playback: `GET /content/audioTrack/stream/:audioTrackId` supports bounded single-range responses and cancels the upstream S3 request when the client disconnects.
- Legacy audio download routes redirect to the streaming endpoint and no longer buffer whole objects in server memory.
- Authorization required; owner/admin enforced
- New tracks are saved with `uploadStatus: pending` before S3 upload, then marked `ready` or `failed`.
- S3 objects include track ID, owner ID, and encoded original filename metadata.
- Failed or interrupted uploads remain identifiable in MongoDB and can be retried against the same track.

Delete:

- API: `DELETE /content/audioTrack/:audioTrackId`
- Web: content manager delete action
- Track metadata is retained until the matching S3 object has been deleted.
- Failed deletions remain marked as `deleteFailed` for reconciliation.

Reconciliation:

- Admin-only report: `GET /admin/audio-storage/reconciliation`
- Browser requests receive a readable audit page; append `?format=json` for the structured report.
- Compares every `audioTracks` record against the objects in `S3_BUCKET_NAME`.
- Reports orphaned S3 objects, database tracks with missing objects, and pending/failed lifecycle records.
- The report is read-only; it never deletes S3 objects automatically.
- Admin-only image report: `GET /admin/image-storage/reconciliation`
- The image report audits the `images/` namespace against `imageAssets`, including orphaned, detached, missing, pending, and failed image records.
- Admin-only content-reference report: `GET /admin/content-references/reconciliation`
- The content-reference report detects dangling saved/activity references,
  manual carousel items, artist-album links, album-track links, and track-album
  links without mutating data.

## Troubleshooting

- `EADDRINUSE`: another process is already using the chosen port.
- Buildspec path errors (`buildspect.yml` not found): check AWS buildspec override settings in CodeBuild/CodePipeline and set path to `buildspec.yml`.
- S3 upload/delete errors: verify IAM permissions and required S3 environment variables.
- `413 Request Entity Too Large`: increase upload limits in both places:
  - Nginx proxy limit via `.platform/nginx/conf.d/upload_size.conf` (`client_max_body_size`, currently 1 GB total per request)
  - App multer per-file limit via `MAX_AUDIO_UPLOAD_MB` (defaults to 512 MB)
  - Cover-art limit via `MAX_IMAGE_UPLOAD_MB` (defaults to 10 MB)
  - Content Manager bulk uploads send files sequentially, keeping each request below the proxy limit and avoiding buffering the entire selection in memory at once.
