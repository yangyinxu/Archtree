# AWS CodeBuild and Elastic Beanstalk

`buildspec.yml` is a promotion-only bridge from GitHub Actions to Elastic
Beanstalk. It runs on Node 24 and Python 3; it does not run `npm ci`, rebuild the
application, or substitute a bundle produced by a smaller test suite.

The `.github/workflows/finitude-web-release.yml` workflow runs on pull requests
and `main` pushes. Its parallel gate jobs, each with a timeout of 25 minutes or less, are:

- `build`: production build, E2E type check, and the optional pinned Naruto source.
- `unit-integration`: `npm test` and the Mongo-backed `npm run test:integration`.
- `social-e2e`: real MongoDB/media/WebSocket social scenarios in Chromium.
- `browser-e2e`: the listener browser and axe suite in Chromium.

Both browser jobs test the one production build that `build` shares as the
short-lived `finitude-web-release-build` artifact. Playwright retries a failed
test once in CI; a test that passes on retry is reported as flaky, not failed.
`release-artifact` needs every gate, stages those same build bytes without
rebuilding, and binds each gate's outcome into the provenance. If branch
protection is added, require every gate job's check, not only `release-artifact`:
GitHub reports a skipped job as passing. The workflow uploads
`archtree-eb-<commit>-<run-id>-<attempt>` for 30 days, containing the runtime ZIP
and `release-provenance.json` with the bundle SHA-256, exact source/run/attempt,
and all successful gate names. PR artifacts are review evidence only.

CodeBuild runs `node scripts/promote-eb-artifact.mjs`. The promoter requires
`CODEBUILD_RESOLVED_SOURCE_VERSION` to be the full main commit SHA, queries the
fixed `yangyinxu/Archtree` release workflow, and accepts only the latest successful
`push` run on `main` from that repository. It waits for an absent or running gate
for up to 35 minutes, so an existing source-triggered pipeline can run concurrently
with GitHub CI. A completed failed gate stops immediately; no older successful
run is substituted. `ARCHTREE_RELEASE_WAIT_SECONDS` can set a bounded 0–3600 second
wait, with `0` for fail-fast operational checks. Allow the CodeBuild project at
least 45 minutes for the default wait and download/validation.

Supply `GITHUB_ARTIFACT_TOKEN` through CodeBuild Secrets Manager or Parameter
Store when needed. It needs only the repository's **Actions: read** permission;
never put its value in Git, plaintext buildspec variables, or shell commands.
The CodeBuild service role must be allowed to retrieve that one secret. Artifact
downloads use GitHub's [Actions artifact API](https://docs.github.com/en/rest/actions/artifacts),
and the token is never forwarded to signed blob-storage URLs. Private-repository
access, expired credentials, missing/expired artifacts and API failures fail closed.
No AWS or GitHub account configuration is changed by this repository update.

Promotion verifies GitHub's archive digest, the internal bundle checksum, every
required gate, the source/run/attempt in `RELEASE.json`, and the runtime allowlist.
It rejects unsafe ZIP paths, links, duplicate entries, oversized archives,
credentials, unexpected distribution files and missing executable platform hooks.
It rechecks the workflow's success and attempt before installing the verified tree
into the previously absent `elastic-beanstalk-artifact` directory for the existing
CodePipeline/EB artifact handoff. The GitHub build identity remains unchanged;
CodeBuild logs its digest and artifact ID. The pipeline's GitHub source connection
alone does not grant Actions download permission.

The artifact includes only root package/lock/TypeScript files, server source,
localization, the Web runtime package and built distribution, `.platform` and
`.ebextensions`. Elastic Beanstalk still installs locked runtime dependencies on
each instance. Keep the source buildspec override set to `buildspec.yml`, preserve
executable modes in the output archive, and disable any older AWS rebuild override.

Retain the candidate and previous tested ZIP, sidecar, GitHub run identity and
checksum in deployment storage through the observation/rollback window; the
30-day GitHub retention is not a permanent rollback store. An older archive without
the provenance sidecar cannot enter this promotion path. Follow
[`docs/deployment/finitude-web-rollout-runbook.md`](finitude-web-rollout-runbook.md)
for exact-artifact rollout and rollback. Local synthetic promotion tests do not
replace a successful merged-main workflow, configured AWS handoff, production-
equivalent rollout, or rollback rehearsal.

<!-- @catalog -->
**Contents**

- [Single-instance Elastic Beanstalk HTTPS](#single-instance-elastic-beanstalk-https)
- [Deployment swap](#deployment-swap)
- [Co-hosted OOTD preview](#co-hosted-ootd-preview)
- [Room audio decoder on Elastic Beanstalk](#room-audio-decoder-on-elastic-beanstalk)
<!-- @end-catalog -->

## Single-instance Elastic Beanstalk HTTPS

This repository supports direct TLS termination on a single-instance Amazon
Linux 2023 Elastic Beanstalk environment without a load balancer:

1. Point the Route 53 record at the environment and allow it to propagate.
2. Set `HTTPS_DOMAIN`, `ACME_EMAIL`, and `TRUST_PROXY_HOPS=1` in the environment.
3. Deploy with ports 80 and 443 allowed. The included `.ebextensions` resource
   admits port 443 on the instance security group.

On small Amazon Linux 2023 instances, set runtime `TMPDIR=/var/tmp` so Multer's
temporary audio files use the EBS root disk. The capacity trial found `/tmp`
was a memory-backed filesystem with less free space than the default 512 MiB
audio limit. Check `df -m / /tmp /var/tmp` and budget disk space for both Nginx
request buffering and Multer staging, including concurrent uploads. The
[capacity report](t4g-micro-capacity-screen.md) records the tested
instance settings and remaining limits.

For a 1 GiB instance, set `COVER_ART_MAX_TRANSFORMS=1` to serialize native
cover-art variant transforms across clients. The default is 4 globally and
at most 2 per client; accepted values are integers 1–4, and invalid non-empty
values fail startup. Lower limits retain the bounded queue and cancellation
behavior but can increase image latency. Set `NODE_OPTIONS=--max-old-space-size=384`
for the tested V8 old-space ceiling; native image memory remains outside it.
On glibc-based Amazon Linux, also set `MALLOC_ARENA_MAX=2` before Node starts
to reduce native allocator fragmentation. The isolated trial's minimum available
memory improved from 187.5 to 288.5 MiB under the measured workload. EB installs
dependencies alongside the old application during configuration updates, so
reserve memory for deployment as well as requests. See the
[deployment verification report](low-cost-production-deployment.md)
for update/recovery checks and client-network limitations.

The first successful post-deployment run obtains a public Let's Encrypt
certificate through the HTTP-01 challenge, enables port 443, and redirects
requests for `HTTPS_DOMAIN` to HTTPS. If DNS or the certificate authority is
temporarily unavailable, deployment remains healthy over HTTP and a bootstrap
timer starts with a five-minute base delay plus a bounded randomized delay,
then retries on an hourly base interval until a usable certificate is active.
Successful activation writes a readiness marker that gates further bootstrap
work; a separate systemd timer checks renewal twice daily and preserves the
current HTTPS configuration when renewal fails. Certificate files remain on
the instance, so replacing the single instance requires issuance again; the
same bootstrap recovery applies.
The timers retrieve `HTTPS_DOMAIN` and `ACME_EMAIL` from Elastic Beanstalk with
`get-config`, because scheduled services do not inherit the application
process environment directly. Configuration-only deployments also rerun the
same idempotent configurator, so correcting the domain or ACME properties does
not require an unrelated application release.

## Deployment swap

Elastic Beanstalk runs `npm install` on every application and configuration
deployment while Archtree keeps serving, which can exhaust the 1 GiB instance
and end the install with exit 137. `.platform/hooks/prebuild/00_ensure_swap.sh`
(also run by `.platform/confighooks/prebuild/`) therefore enables a 1 GiB swap
file at `/var/swap/archtree.swap` before dependencies install and records it in
`/etc/fstab`.

## Co-hosted OOTD preview

The production instance can also host the separately built OOTD owner preview
at `ootd.kashewt.com` (OOTD repository, ADR 0002). Archtree contains no OOTD
source: `.platform/hooks/postdeploy/03_cohost_ootd.sh` and its configuration
hook only fetch, verify, sandbox, and route a pinned OOTD artifact.

- The deployment hook installs itself as `/usr/local/sbin/ootd-cohost` and
  starts `ootd-cohost-deploy.service` without waiting, so OOTD's download,
  dependency install, migration, and health check never run inside or fail an
  Archtree deployment. Follow it with `journalctl -u ootd-cohost-deploy`.
- OOTD runs as the `ootd` user on `127.0.0.1:3100` (`ootd-web.service`) and as
  bounded `ootd-*.timer` jobs. Every OOTD unit denies EC2 instance metadata and
  has a `MemoryMax` limit, so it cannot use this instance profile or exhaust
  Archtree's memory. It adds its own swap file only when less than
  `OOTD_COHOST_SWAP_MIB` of swap is already active.
- Nginx serves `ootd.kashewt.com` from `/etc/nginx/conf.d/ootd-cohost.conf` with
  its own Let's Encrypt certificate (reusing `ACME_EMAIL`); the Archtree
  renewal timer renews it with the Archtree certificate.
- Non-secret properties: `OOTD_COHOST_ENABLED`, `OOTD_COHOST_DOMAIN`,
  `OOTD_COHOST_ARTIFACT_S3_URI`, `OOTD_COHOST_ARTIFACT_SHA256`,
  `OOTD_COHOST_SECRET_ID`, and optional `OOTD_COHOST_AWS_REGION`,
  `OOTD_COHOST_MEMORY_MAX` (default `320M`), and `OOTD_COHOST_SWAP_MIB`
  (default `1024`). OOTD secrets stay in the named Secrets Manager secret and
  are written only to a root-only systemd environment file; never put them in
  Elastic Beanstalk properties, which the Archtree process receives.
- The instance role needs `s3:GetObject` on the OOTD artifact prefix and
  `secretsmanager:GetSecretValue` on that one secret. With
  `OOTD_COHOST_ENABLED` unset the hook does nothing; `false` stops OOTD and
  removes its route and environment file while keeping releases.

The OOTD repository's `docs/deployment.md` defines the secret contents and the
release procedure: update the artifact URI and digest through a configuration
deployment, and restore the previous pair to roll back.

## Room audio decoder on Elastic Beanstalk

Amazon Linux 2023 has no FFmpeg package, so
`.platform/hooks/prebuild/02_install_ffmpeg.sh` installs one on every deployment
before the new version starts. It downloads a single pinned LGPL static build of
FFmpeg 9.0 from the [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
GitHub releases (linux arm64 for t4g Graviton instances, plus an x86_64 pin so an
instance-type change does not break deployments), checks its exact byte size and
hard-coded SHA-256, extracts only `ffmpeg` and `ffprobe` into
`/opt/archtree-ffmpeg/<build>/`, verifies the decoding capabilities the analyzer
needs, and then atomically links `/usr/local/bin/ffmpeg` and
`/usr/local/bin/ffprobe`. `.ebextensions/room-audio-decoder.config` sets
`ROOM_AUDIO_FFMPEG_PATH=/usr/local/bin/ffmpeg`, so the decoder never depends on
the service PATH; a value set directly on the environment still takes precedence.
Later deployments reuse the verified installation without downloading, and a new
pin replaces the previous directory only after the new build passes.

A failed download, size or digest mismatch, unexpected archive layout or missing
capability fails the deployment loudly (see `/var/log/eb-hooks.log`) before the
new version is activated, rather than leaving compressed uploads without a
decoder. A replacement instance downloads the build again (about 117 MB for
arm64), so GitHub must be reachable, just as the Certbot hook needs PyPI. Upstream
keeps the pinned month-end build until about September 2028; refresh the pin
earlier for FFmpeg security fixes by updating the tag, archive names, sizes and
digests together, checking each digest against the release's `checksums.sha256`
and GitHub's asset digest.

Decoding stays within the 1 GiB instance budget: room analysis remains one job
per process (the administrator page admits one request at a time), each decode is
single-threaded with at most two per process (upload inspection plus analysis),
each FFmpeg allocation is capped at 32 MiB, decodes have a 60-second deadline, and
analysis keeps its 90-second deadline and 512-MiB temporary-file limit. Keep
`TMPDIR=/var/tmp` so temporary analysis files use the EBS disk.

After deploying, run `/usr/local/bin/ffmpeg -hide_banner -version` on the instance,
upload a short MP3 through Content Manager, and confirm the Room audio analysis
page lists it as eligible. Then run the
[room audio catalog backfill](../features/social-and-rooms.md#room-audio-catalog-backfill) for existing tracks.

Important:
- Build phase should not run `npm start`.
- Runtime process startup should happen in the deployment service configuration.
