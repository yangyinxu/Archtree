# Troubleshooting

- `EADDRINUSE`: another process is already using the chosen port.
- Authentication email not arriving: look for the security events
  `auth_email_domain_rejected` (the request was answered with
  `422 email_domain_undeliverable`), `auth_email_undeliverable_domain` (the
  recipient domain has no usable MX record, so nothing was sent) and
  `auth_email_domain_check_failed` (the DNS lookup failed and the email was
  sent anyway); see the recipient-domain check in
  [Browser Auth and Content Management](../features/auth-and-content-management.md).
- Buildspec path errors (`buildspect.yml` not found): check AWS buildspec override settings in CodeBuild/CodePipeline and set path to `buildspec.yml`.
- S3 upload/delete errors: verify IAM permissions and required S3 environment variables.
- `413 Request Entity Too Large`: increase upload limits in both places:
  - Nginx proxy limit via `.platform/nginx/conf.d/upload_size.conf` (`client_max_body_size`, currently 1 GB total per request)
  - App multer per-file limit via `MAX_AUDIO_UPLOAD_MB` (defaults to 512 MB)
  - Cover-art limit via `MAX_IMAGE_UPLOAD_MB` (defaults to 10 MB; maximum 25 MB)
  - Content Manager accepts up to 100 files per bulk selection and uploads
    them sequentially, one file per request. The 1 GiB proxy limit therefore
    applies to each request rather than the combined selected batch and remains
    above the default 512 MiB per-file limit.
- Catalog Credit migration is dry-run-first and bounded:
  `npm run migrate:catalog-credits -- --limit=100`. Continue with the returned
  `--after-album` and `--after-track` checkpoints. Apply only after reviewing
  findings: `npm run migrate:catalog-credits -- --apply --confirm=APPLY_CATALOG_CREDITS --limit=100`.
  `--mark-unattributed-unknown` is an explicit policy choice and is never the
  default. The command reports bounded samples and never logs credentials.
- `429 Too many concurrent requests`: administrator shared-catalog uploads do
  not have an hourly request-count quota, but uploads retain a one-per-client
  concurrency boundary and expose `Retry-After`; wait for the active upload to
  finish before retrying. Account-owned avatar mutations retain a per-client
  budget of 20 requests per hour with `RateLimit-Limit`,
  `RateLimit-Remaining`, and `RateLimit-Reset`. Bulk Audio uploads stop before
  sending the remaining selected files after a server-wide failure and identify
  those files as not attempted.
- If a bulk upload reports a gateway or unconfirmed response, check MediaTrack
  Operations and the Audio Storage Audit before retrying so a delayed success is
  not duplicated. Album promotion is available only when the batch has both a
  selected Album and an explicitly selected Primary Artist.
