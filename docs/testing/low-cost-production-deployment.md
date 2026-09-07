# Low-cost production deployment

Production was restored on 2026-09-07. The live listener is
[kashewt.com/finitude](https://kashewt.com/finitude).

## Candidate and release identity

Use one `t4g.micro` in `us-east-1`, a 20 GiB gp3 root volume, public IPv4,
single-instance Elastic Beanstalk, and the existing external MongoDB and S3.
The earlier cost screen estimated approximately $12.22/month before tax and
variable usage; this is not a spending cap. See
[the capacity screen](t4g-micro-capacity-screen.md) for assumptions and limits.

The candidate source is commit
`7bedef15180629902d59780766c32ae5f1c0e1ea` on the local isolated branch
`codex/low-cost-deployment`. It adds the bounded cover-art concurrency setting
and updates one stale Album visual golden to match existing product behavior.
The deployed production runtime settings are:

```text
COVER_ART_MAX_TRANSFORMS=1
NODE_OPTIONS=--max-old-space-size=384
TMPDIR=/var/tmp
MALLOC_ARENA_MAX=2
```

The V8 limit does not bound total process memory. `/var/tmp` uses the root disk;
the previous trial's `/tmp` was a 459 MiB memory-backed filesystem, insufficient
for the 512 MiB upload limit. Generate load outside the application instance.

## Linux verification environment

The isolated CodeBuild invocation uses Ubuntu 24.04
(`aws/codebuild/standard:8.0`), Node 24, MongoDB 8.0.12, and the lockfile's
Playwright browsers. It does not alter the saved CodeBuild project.

On Windows, produce the source archive with both Git settings to avoid converting
canonical localization JSON to CRLF:

```sh
git -c core.autocrlf=false -c core.eol=lf archive --format=zip --output=source.zip HEAD
```

The candidate source ZIP SHA-256 is
`2bdd11835d77a29d4c8dc605834a46ef894a7ce87a978fb71e59c96247336565`.

CodeBuild's headless container needs an audio output for Firefox's real WAV
playback. The initial independent trace reported
`NS_ERROR_DOM_MEDIA_MEDIASINK_ERR` / `OnMediaSinkAudioError`. Install PulseAudio
in the disposable build container and initialize a local null sink before the
browser gate:

```sh
apt-get install -y pulseaudio
pulseaudio --start --exit-idle-time=-1 --log-target=file:/tmp/archtree-pulse.log
pactl load-module module-null-sink sink_name=archtree_ci
pactl set-default-sink archtree_ci
pactl list short sinks
```

These commands apply to the isolated CodeBuild container, not the EB application
host. A null sink supplies the audio output clock without a speaker; it does not
mock playback state or relax assertions. See the
[PulseAudio module documentation](https://wiki.freedesktop.org/www/Software/PulseAudio/Documentation/User/Modules/#module-null-sink).
The repository's GitHub Actions release gate now initializes the same null sink
for its Ubuntu runner. Its rollback ZIP also includes `localization`, alongside
the runtime source, Web bundle, and platform hooks validated by artifact staging.

## Verification and rollout results

The complete corrected Linux gate succeeded at 2026-09-07 16:18:58 UTC:
CodeBuild `Archtree-build-project:9203f966-6486-45e7-a9d1-167275aa80e8`.
This includes `npm test`, `npm run test:integration`, `npm run build`, E2E
type checking, the Chromium/Firefox/WebKit matrix, and `npm run stage:eb-artifact`.
Results: 351 backend tests and 150 integration tests passed; all 42 Web test files
passed; the browser matrix had 215 passes, 10 intentional skips, and no failures.
The staged runtime archive contains 246 files. The original Firefox audio-sink
error and obsolete golden no longer block the gate.

Registered EB version: `lowcost-20260907-7bedef1`. Runtime archive SHA-256:
`baa1c7d017b9c8013c35effa33d080e17d2367748ae0832c0034b6b041a5bb74`.

The first constrained trial created `archtree-lowcost-check-20260907`
(`e-pyam4piikf`) at 16:22:16 UTC, with an isolated database and private bucket.
HTTPS, release identity, runtime settings, and both certificate timers verified.
The initial workload passed 48 artwork requests, 256 MiB of ranged reads,
HEAD/invalid-Range/disconnect checks, a 511 MiB replacement upload, and 111
independent health samples with zero failures. Upload completed in 17.90 seconds;
the mixed artwork/range phase took 23.48 seconds with image p95 4.12 seconds.
Maximum observed application RSS was 356.3 MiB. No OOM or automatic restart occurred.

However, the 480-sample, four-minute monitor recorded only 187.5 MiB minimum
available memory (15,871.4 MiB minimum disk free, no swap). This remains below the
provisional 200 MiB target. The next isolated configuration trial adds
`MALLOC_ARENA_MAX=2`, following [Sharp's glibc memory-fragmentation guidance](https://sharp.pixelplumbing.com/performance/#parallelism-and-concurrency),
and repeats the workload before production rollout.

Allocator verification, temporary-resource cleanup, and production HTTPS/DNS
smoke checks remain in progress.

At 16:30:54 UTC the allocator environment update stalled. Public HTTPS timed out
and SSM stopped reporting, while EC2 instance/system/EBS checks passed and the
security group retained ports 80/443 plus outbound access. Console output did not
establish an OOM cause. A requested instance reboot did not restore service.
Recovery now uses a stop/start of the isolated instance, retaining its EBS disk;
only this environment's ASG HealthCheck/ReplaceUnhealthy processes are temporarily
suspended and must be resumed after recovery. Production remains unchanged.

Stop/start restored HTTPS at approximately 16:46 UTC; both temporarily suspended
ASG processes were resumed. EB reported the first update timed out and reverted
its configuration. The previous boot's journal was not persistent, so its OOM
status cannot be reconstructed. The retained EB engine log stopped at dependency
installation. A repeat update on the recovered idle instance succeeded; during
that update `npm install` alone used approximately 291 MiB RSS alongside the old
application. This supports deployment-time memory pressure as a concern without
proving the cause of the first stall.

The second workload confirmed `MALLOC_ARENA_MAX=2`. Standalone image/range load
finished in 20.40 seconds, image p95 3.74 seconds, peak application RSS 261.0 MiB,
20 healthy samples. The mixed 511 MiB upload finished in 19.10 seconds; image/range
load finished in 29.80 seconds, image p95 4.13 seconds, peak application RSS
273.6 MiB and 29 healthy samples. The upload client's own health sampler recorded
one failure; the independent probe and complete system-memory monitor are still
being checked. No automatic application restart was observed.

The allocator trial's four-minute monitor completed: 480 samples, minimum
available memory 288.5 MiB, minimum disk free 15,862.9 MiB, no swap. The independent
Windows probe also recorded one timeout. A repeat mixed workload preserved normal
application behavior (511 MiB replacement in 18.44 seconds, artwork/range in
29.50 seconds, image p95 4.71 seconds, peak RSS 245.8 MiB), but again one Windows
probe hit its five-second timeout. In parallel, all 90 server-local health checks
returned HTTP 200 with maximum latency 0.443 seconds and no application restarts.
This supports an external client/network-path issue rather than a server-local
health outage; it does not establish the exact external cause. Do not describe
the external probes as zero-failure.

A subsequent real EB environment-variable update after load completed successfully
(instance deployment completed at 16:56:16 UTC). Final inspection confirmed the
same release, active application and certificate timers, zero automatic restarts,
zero current-boot OOM lines, and 423 MiB available memory. The synthetic media and
account were deleted through normal application endpoints; S3 objects, versions,
delete markers, and multipart uploads were empty before the disposable Atlas
database was dropped. A separate SSM check verified zero remaining collections.
Trial infrastructure cleanup completed and was independently verified: no trial
environment, instance, root volume, Elastic IP, bucket, DNS record, or trial IAM
role/profile remains. Synthetic password/seed files and their helper archives
were removed after account deletion.

## Production outcome

`Archtree-2024-env` (`e-qeb3ekat4i`) launched successfully at 17:02:26 UTC on
2026-09-07. EB reports Ready/Green/Ok, version `lowcost-20260907-7bedef1`, one
ARM64 `t4g.micro` (`i-0dc5fd100a352b2ef`), 20 GiB gp3, and zero load balancers.
The retained production database `archtree`, bucket `archtree-bucket`, credentials,
and existing instance profile were reused. Production data was not edited by the
smoke checks. Runtime settings match the four values above.

Route 53's apex A alias now targets
`Archtree-2024-env.us-east-1.elasticbeanstalk.com`, with hosted-zone target
`Z117KPS5GTRQ2G` and the existing `EvaluateTargetHealth=true`. The change is INSYNC;
the environment's current Elastic IP is `100.59.137.244`. Keep the alias pointed
to the environment rather than relying on this IP remaining permanent.

Read-only production verification passed for `/health`, landing/login pages,
`/finitude` and its search deep link, hashed JS/CSS assets and immutable caching,
public Home/capabilities/localization APIs, the anonymous Library 401 guard,
and a real catalog track's HEAD, 1 KiB Range response, and listener DTO. HTTPS
certificate verification was enabled throughout. Its SAN is `kashewt.com` and
current expiry is 2026-12-06 16:03:38 UTC. The certificate timer implementation
was verified on the identical isolated release; no new production SSM permission
was added solely to inspect its local timers.

AWS-side normal DNS and HTTPS returned 200 for health, listener, Home, and
localizations; Cloudflare's public DNS also resolved the new IP. The Windows
default recursive resolver initially retained a negative answer from environment
startup. Windows smoke checks therefore used the verified EB IP while preserving
the requested hostname, SNI, and certificate validation. Ordinary browser access
on that resolver initially had to wait for its negative cache to expire; this
was not bypassed by weakening TLS or changing the user's DNS settings.

The user's follow-up confirmed the browser still failed. Diagnostics isolated the
negative answer to the active router resolver `192.168.1.1`; Google and Cloudflare
already returned the current IP. Its remaining negative TTL counted down to zero.
At approximately 17:14:30 UTC, default Windows DNS resolved the correct address.
The entire production read-only smoke suite then passed with no IP override, and
the same independent Chrome tab loaded Finitude Home and its real album sections.
Ordinary browser connectivity is now verified; no DNS settings or hosts file were
changed and no server restart was needed for this recovery.

This is a bounded small-traffic deployment check, not a sustained capacity or
availability guarantee. The estimated baseline remains approximately $12.22/month;
CPU-credit overage, data transfer, storage growth, CI usage, and tax can add charges.
Single-instance deployments involve brief downtime during application restart.

## Recovery and future releases

The retained pre-change apex alias target was
`archtree-2024-env.eba-pc7apgbb.us-east-1.elasticbeanstalk.com.` with the same
hosted-zone target and health setting. That old environment was terminated;
restoring that DNS target alone is not a working rollback.

For an application rollback, redeploy a verified EB application version to the
current named environment, retain the production database/bucket, and recheck
HTTPS and public media. The retained earlier version is
`code-pipeline-1787980176259-ArchtreeBuildArtifacts-e7f43f4a-8b5a-47fb-b1f3-21867f36166c`.
It predates the constrained artwork scheduler, so do not assume its capacity is
equivalent on 1 GiB. Never replace the production environment with a test template
or point it at a disposable database/bucket.

The original deployment used local commits on `codex/low-cost-deployment`,
uploaded as a source archive without a GitHub push. The same runtime code and
reviewed visual golden are now consolidated on `develop`, with the capacity
runner, reports, and CI packaging/audio fixes. This consolidation does not change
the already-deployed EB version. Future production releases must include these
changes and retain the four EB environment settings above; pushing Git alone
does not configure an environment's memory limits.

Final `git diff --check` passed; the implementation and documentation diffs were
reviewed for unrelated changes. Manual production playback inspection remains a
user handoff check; the DNS-cache failure has been resolved and browser-verified.

For Git consolidation, the runtime source, dependencies, hooks, and reviewed Web
golden were compared with `7bedef1` and were unchanged. The six artwork-concurrency
tests passed again. Windows artifact tests had 17 passes and two failures at the
POSIX executable-bit check; the same artifact implementation passed the complete
Linux gate above. The updated GitHub workflow parsed successfully and its rollback
ZIP entry list includes localization and all platform/runtime roots. The audio
setup commands were exercised in the successful Linux CodeBuild gate; the updated
GitHub job itself will run on a pull request or a push to main.
