# Archtree Backend

Archtree is an Express + TypeScript backend for authentication, content management, and media upload/streaming.

## Tech Stack

- Node.js 24
- Express
- TypeScript (runtime via tsx)
- MongoDB
- AWS S3 (audio object storage)

## Scripts

- `npm run dev`: start development server
- `npm start`: start production-mode server

Notes:
- The previous `prod` alias was removed to keep scripts minimal.
- Runtime startup should be configured in your deployment target (Elastic Beanstalk, ECS, App Runner, etc.).

## Environment Variables

Required variables:

- `DB_CONN_STRING`: MongoDB connection string
- `DB_NAME`: MongoDB database name (required; no runtime fallback)
- `JWT_SECRET`: JWT signing secret
- `AWS_ACCESS_KEY_ID`: AWS access key for S3 operations
- `AWS_SECRET_ACCESS_KEY`: AWS secret key for S3 operations
- `AWS_REGION`: AWS region
- `S3_BUCKET_NAME`: target S3 bucket for audio uploads
- `S3_STORAGE_COST_PER_GB_MONTH`: optional S3 Standard storage rate used for the Content Manager estimate (defaults to `$0.023` per GiB-month)
- `PORT`: optional explicit HTTP port (preferred in cloud environments)

Security:
- Do not commit real credentials.
- Store production secrets in AWS Secrets Manager or SSM Parameter Store.

## Local Run

1. Install dependencies:
   - `npm install`
2. Configure `.env`.
3. Start server:
   - `npm run dev`

## AWS CodeBuild

This repo includes `buildspec.yml` with CI-oriented behavior:

- `install`: `npm ci`
- `build`: `npm run build --if-present`
- `post_build`: removes `node_modules` before artifact packaging

Artifact packaging intentionally excludes `node_modules` so Elastic Beanstalk performs a clean dependency install on each instance.

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

Web content management:

- `GET /content/manage`
- `GET /content/manage/audio-tracks`
- `GET /content/manage/search`
- Create/update/delete forms for artists, albums, and audio tracks
- Single and bulk audio-track creation record filenames and a pending upload state before sending files to S3
- Every newly uploaded track requires at least one owned artist. `audioTrack.artistIds` is the canonical artist-to-track relationship.
- Artist responses no longer expose the legacy `audioTrackIds` field. Clients should find an artist's tracks by querying audio tracks whose `artistIds` contains the artist ID.
- Content Manager reference fields validate IDs against the expected owned content type before saving.
- Existing tracks support replacing their uploaded audio file
- S3 bucket storage usage and an estimated monthly storage-only charge (requires the S3 `ListBucket` permission)

Artist carousels:

- Manual carousels keep an explicitly managed item list.
- Manual carousels can be renamed without changing their items.
- Artist carousels dynamically resolve either albums or audio tracks for one owned artist.
- Album carousels use the artist's `albumIds`; audio-track carousels query `AudioTrack.artistIds`.
- Dynamic results support newest-release or title sorting and a configurable limit from 1 to 100.
- Artist carousel items cannot be manually added, reordered, or moved between carousels.

Session behavior:
- Browser and API login tokens last 30 days by default. Set `SESSION_DAYS` to a whole number from 1 to 90 to override it. `WEB_SESSION_DAYS` remains supported as a backwards-compatible fallback.
- Web login sets an HttpOnly `session_token` cookie with the same lifetime.
- Protected web pages redirect to login if unauthenticated.

## Audio Upload and Delete Lifecycle

Upload:

- API creation: `POST /content/audioTrack` as multipart form data with required `audioFile`
- API: `POST /content/audioTrack/:audioTrackId/upload`
- Form field for file: `audioFile`
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

## Troubleshooting

- `EADDRINUSE`: another process is already using the chosen port.
- Buildspec path errors (`buildspect.yml` not found): check AWS buildspec override settings in CodeBuild/CodePipeline and set path to `buildspec.yml`.
- S3 upload/delete errors: verify IAM permissions and required S3 environment variables.
- `413 Request Entity Too Large`: increase upload limits in both places:
  - Nginx proxy limit via `.platform/nginx/conf.d/upload_size.conf` (`client_max_body_size`, currently 1 GB total per request)
  - App multer per-file limit via `MAX_AUDIO_UPLOAD_MB` (defaults to 512 MB)
  - Content Manager bulk uploads send files sequentially, keeping each request below the proxy limit and avoiding buffering the entire selection in memory at once.
