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
- `DB_NAME`: MongoDB database name (default fallback is `archtreeDb`)
- `JWT_SECRET`: JWT signing secret
- `AWS_ACCESS_KEY_ID`: AWS access key for S3 operations
- `AWS_SECRET_ACCESS_KEY`: AWS secret key for S3 operations
- `AWS_REGION`: AWS region
- `S3_BUCKET_NAME`: target S3 bucket for audio uploads
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

Session behavior:
- Web login sets an HttpOnly `session_token` cookie.
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
