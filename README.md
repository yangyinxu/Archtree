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
- `GET /content/manage/search`
- Create/update/delete forms for artists, albums, and audio tracks
- Audio file upload form for a selected track
- S3 bucket storage usage and an estimated monthly storage-only charge (requires the S3 `ListBucket` permission)

Session behavior:
- Browser and API login tokens last 30 days by default. Set `SESSION_DAYS` to a whole number from 1 to 90 to override it. `WEB_SESSION_DAYS` remains supported as a backwards-compatible fallback.
- Web login sets an HttpOnly `session_token` cookie with the same lifetime.
- Protected web pages redirect to login if unauthenticated.

## Audio Upload and Delete Lifecycle

Upload:

- API: `POST /content/audioTrack/:audioTrackId/upload`
- Form field for file: `audioFile`
- Authorization required; owner/admin enforced

Delete:

- API: `DELETE /content/audioTrack/:audioTrackId`
- Web: content manager delete action
- On delete, backend attempts S3 cleanup for matching key (`audioTrackId`).
- If S3 cleanup fails, metadata deletion still succeeds and a warning is returned/logged.

## Troubleshooting

- `EADDRINUSE`: another process is already using the chosen port.
- Buildspec path errors (`buildspect.yml` not found): check AWS buildspec override settings in CodeBuild/CodePipeline and set path to `buildspec.yml`.
- S3 upload/delete errors: verify IAM permissions and required S3 environment variables.
- `413 Request Entity Too Large`: increase upload limits in both places:
  - Nginx proxy limit via `.platform/nginx/conf.d/upload_size.conf` (`client_max_body_size`, currently 1 GB total per request)
  - App multer per-file limit via `MAX_AUDIO_UPLOAD_MB` (defaults to 200 MB)
