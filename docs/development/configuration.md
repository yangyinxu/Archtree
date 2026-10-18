# Environment variables

Local `npm run dev` requires application configuration in the current terminal
or a private root `.env` file. `.env.example` is only a template; `npm ci` and
`npm run doctor` do not supply database or authentication credentials. Follow
the [application startup setup](environment.md#configure-application-startup).

Required variables:

- `DB_CONN_STRING`: MongoDB connection string
- `DB_NAME`: MongoDB database name (required; no runtime fallback)
- `DB_CONNECT_TIMEOUT_MS`: maximum MongoDB connection setup time (defaults to 10000)
- `DB_SERVER_SELECTION_TIMEOUT_MS`: maximum MongoDB server selection time (defaults to 10000)
- `DB_SOCKET_TIMEOUT_MS`: maximum MongoDB socket inactivity time (defaults to 120000)
- `DB_WAIT_QUEUE_TIMEOUT_MS`: maximum wait for a pooled MongoDB connection (defaults to 10000)
- `DB_MAX_POOL_SIZE`: maximum MongoDB connections per server process (defaults to 100)
- `SERVER_SHUTDOWN_GRACE_MS`: time allowed for connections and business operations
  to finish during shutdown (defaults to 30000; capped at 120000)
- `SERVER_SHUTDOWN_CLEANUP_MS`: database shutdown deadline after draining
  (defaults to 5000; capped at 30000)
- `JWT_SECRET`: JWT signing secret
- `AUTH_CODE_PEPPER`: optional separate HMAC secret for password-reset codes
  and emailed link tokens (defaults to `JWT_SECRET`)
- `AUTH_EMAIL_FROM`: AWS SES verified sender used for registration links,
  already-registered notices, verification links and reset codes. Requests for
  an address whose domain publishes no usable MX record are rejected with
  `422 email_domain_undeliverable`, and no email is ever sent to one; see the
  recipient-domain check in
  [Browser Auth and Content Management](../features/auth-and-content-management.md)
- `AUTH_LINK_ORIGIN`: exact origin of the Web listener used in emailed links,
  for example `https://kashewt.com` (scheme, host and optional port only; no
  path, query or fragment). `https:` is required; `http:` is accepted only
  outside production for `localhost`, `127.0.0.1` or `[::1]`. An invalid value
  counts as missing. Links are never built from `Host`, `Origin` or
  `X-Forwarded-*`. Without it, `emailRegistration` is reported as unavailable
  and the registration and verification-link requests return `503`; password
  recovery still sends reset codes
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
- `FINITUDE_SOCIAL_ENABLED`: set to `true` to enable social profile/friend admission,
  music sharing and opt-in listening publication; defaults to `false`
- `FINITUDE_ROOMS_ENABLED`: set to `true` alongside social enablement to admit
  Audio rooms and realtime connections; defaults to `false`. A process started
  with either flag off runs no realtime gateway: upgrades get an empty `503`,
  and rooms left open by an earlier process are wound down. Shared playback
  pauses, rooms end through the ordinary host-absence rules (suspended after 30
  seconds, ended after five minutes) or the 24-hour expiry, and the room
  authority is released once no room is open. HTTP room reads and safety exits
  keep working, and social features stay available when only rooms are off.
  Flag changes take effect on restart; enabling, the kill switch, verification
  and rollback are in the
  [social rollout runbook](../deployment/social-rollout-runbook.md).
- `FINITUDE_ROOMS_MAX_OPEN`, `FINITUDE_ROOM_MAX_MEMBERS`,
  `FINITUDE_REALTIME_MAX_SOCKETS`: deployment capacity for open rooms (1–100),
  members per room (2–8) and realtime sockets per process (1–256). Unset values
  use those maximums; out-of-range whole numbers are clamped, anything else falls
  back to the maximum, and the startup `social_capacity_config` line names the
  variable either way. `.ebextensions/social-capacity.config` ships 1, 2 and 10 for
  the t4g.micro with free-tier Atlas; values set on the environment take
  precedence. Lowering a limit refuses new rooms, joins and connections without
  removing anything already admitted. Each connected room member's first socket
  has a reserved seat; the runbook describes the seat rule. At most half of the
  sockets are reserved: with unset values (256 sockets, 100 rooms of 8 seats)
  128 sockets are reserved for room members, so sockets outside rooms stop at
  128. See the
  [capacity budget](../deployment/t4g-micro-capacity-screen.md#social-and-rooms-database-budget--2026-10-04)
  before raising them.
- `FINITUDE_ARTIST_FOLLOWS_ENABLED`: defaults to `false` in every environment,
  independently of Social, Playlists and Catalog Credit display switches. Set
  `true` only after the required Artist Follow indexes and lifecycle checks
  pass. Disabling rejects new Follow with `503 ARTIST_FOLLOWS_DISABLED`; private
  status and Unfollow remain available and no relationship data is deleted.
- `FINITUDE_MOTION_PREVIEWS_ENABLED`: defaults to `false` in every
  environment. Set `true` only after the instance's FFmpeg reports the `h264`
  decoder and the S3 role can read, write, and delete object versions under
  `motion-preview/`. Enabling admits administrator preview uploads and public
  preview delivery; disabling hides every preview at once without deleting
  stored previews or their lifecycle evidence. See
  [media lifecycle](../features/media-lifecycle.md#motion-preview).
- `FINITUDE_PLAYLISTS_ENABLED`: set to `true` to expose Playlist APIs and Web
  entry points, or `false` for an emergency rollout stop without deleting
  Playlist or mutation-receipt data. An omitted value defaults to disabled in
  production and enabled in non-production environments.
- `CATALOG_SEARCH_INDEX_ENABLED`: defaults to `false`. Enable indexed substring
  candidates only after all catalog writers are updated and the bounded
  `backfill:catalog-search` command has completed for all four collections.
  Disable before reverting to older writers; see
  [the search rollout procedure](../architecture/runtime.md#substring-candidate-index-rollout)
  for dry runs, checkpoints, compatibility limits, and rollback requirements.
- Catalog Credit rollout switches are documented in
  [`docs/deployment/catalog-credit-rollout-runbook.md`](../deployment/catalog-credit-rollout-runbook.md):
  `CATALOG_CREDIT_WRITES_ENABLED`, `CATALOG_CREDIT_READS_ENABLED`,
  `CATALOG_CREDIT_SECTIONS_ENABLED`, and
  `CATALOG_ORGANIZATION_SURFACES_ENABLED` default to `true` for the additive
  release. `CATALOG_CREDIT_REJECT_LEGACY_WRITES` defaults to `false` until the
  documented adoption and seven-day drift gate passes.
- Administrator workbench settings, including the imports flag, the private
  staging bucket and `FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT`, are documented
  in the [administrator workbench configuration table](../features/admin-workbench.md).
- `AWS_ACCESS_KEY_ID`: AWS access key for S3 operations
- `AWS_SECRET_ACCESS_KEY`: AWS secret key for S3 operations
- `AWS_REGION`: AWS region
- `S3_BUCKET_NAME`: target S3 bucket for MediaTrack Audio and Video uploads
- `S3_CONNECTION_TIMEOUT_MS`: maximum S3 connection setup time (defaults to 5000)
- `S3_REQUEST_TIMEOUT_MS`: maximum S3 socket inactivity time (defaults to 60000)
- `S3_SUMMARY_WAIT_TIMEOUT_MS`: maximum content-manager wait for an S3 summary refresh (defaults to 2000)
- `MAX_AUDIO_BATCH_UPLOAD_MB`: maximum aggregate multipart request size for bulk audio uploads (defaults to 1024)
- `MAX_VIDEO_UPLOAD_MB`: maximum focused MediaTrack MP4 upload size in MiB
  (defaults to 512 and is hard-capped at 1024)
- `MAX_IMAGE_UPLOAD_MB`: maximum cover-art upload size in MiB (defaults to 10
  and is hard-capped at 25 so public derivative work remains byte-bounded)
- `MAX_VIDEO_STREAM_CHUNK_MB`: largest byte range on the deprecated GridFS
  `/video` route (defaults to 4); it does not apply to MediaTrack S3 video
- `MAX_MEDIA_REQUESTS_PER_IP`: concurrent public media requests allowed per client IP (defaults to 8)
- `MAX_MEDIA_REQUESTS_GLOBAL`: concurrent public media requests allowed per server process (defaults to 40)
- `MEDIA_PLAYBACK_RESERVED_PER_IP`: slots within the per-client media limit
  reserved from artwork, avatar, and download traffic for audio/video playback
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

Audio/Video playback GETs may wait up to two seconds when an older stream still
occupies a media slot. This fixed pending pool allows 32 requests per process and
eight per IP without raising active limits. HEAD and non-playback requests do not
wait; a full or expired queue returns 429 with `Retry-After: 2`. Admission retains
its slot until the response and tracked storage work both finish. Disconnecting a
queued request cancels it before source validation or storage access.

<!-- @catalog -->
**Contents**

- [Verify refresh-token rotation locally](#verify-refresh-token-rotation-locally)
<!-- @end-catalog -->

## Verify refresh-token rotation locally

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
  [`docs/deployment/todos.md`](../deployment/todos.md).
