# t4g.micro capacity screen — 2026-09-07

## Decision

This is the historical first-stage capacity screen. For the subsequent constrained
trial, completed release gates, and live production outcome, see the
[production deployment report](low-cost-production-deployment.md).

The local screen was followed by an isolated, real AWS trial. A single 1 GiB
`t4g.micro` served HTTPS, real MongoDB/S3 media, artwork and a 511 MiB replacement
upload. It remains a small-traffic candidate, **not a production capacity
certification**. Production data, DNS and business rules were unchanged.

The tested source is commit `46c5ed6`. Durable state remains in MongoDB and
S3. Moving to serverless is not required to try the smaller instance.

## Method and limits

`scripts/capacity-screen.ts` exercises the existing application imports and
Express composition, real cover-art validation/transformation/scheduling,
Multer disk uploads, file-based audio metadata parsing, and the media stream
pipeline. Synthetic lookup functions and local file streams substitute for
MongoDB and S3. A sink consumes uploaded bytes without creating cloud objects.
It does not exercise live database connections, transactions, S3 SDK network
delivery, authentication, or the complete production media controller chain.

- Windows x64, Node `v24.19.0`, restricted to two logical CPUs by process affinity.
- Each scenario starts a fresh process with a 384 MiB V8 old-space ceiling.
  **This does not cap native allocations or enforce a 1 GiB machine limit.**
- RSS samples are taken every 10 ms, supplemented by the process lifetime
  high-water mark. Client and server share the measured process; fixture
  generation runs separately. Reported RSS excludes Windows, Nginx, EB agents,
  MongoDB server memory, and the parent runner.
- The image is a deterministic 4000 × 4000 PNG, 7,396,626 bytes, below the
  existing 10 MiB byte limit and at the 16-million-pixel limit. It is one
  representative encoding, not an exhaustive image-format corpus.
- Image scenarios run three bursts of 16 requests, producing 48 validated
  1280 px WebP derivatives. Four-way concurrency matches today's scheduler;
  one-way concurrency is injected only into the benchmark for comparison.
- Uploads send a synthetic 511 MiB PCM WAV through multipart decoding,
  metadata parsing, and streaming consumption. Temporary-file removal is
  checked. This is not a test of every accepted audio/video format or four
  simultaneous administrator uploads.
- Mixed scenarios concurrently run image work, one upload, one full image
  validation, and 128 loopback byte-range transfers (16 at a time), totaling
  1 GiB. Clients consume bytes incrementally. These are transfer workloads,
  not evidence of 16 real listeners or a sustained listening-duration soak.
- The initial harness attempted exactly 512 MiB and received an error at
  Multer's file-size boundary. The successful scenarios use 511 MiB to remain
  strictly below that boundary; the initial harness failure is not counted
  as a successful upload or evidence of an out-of-memory event.

Do not derive ARM latency or sustained CPU capacity from these Windows times.
Allocator, Sharp, OS caching, and CPU-credit behavior differ on AWS.

## Results

All six profiles completed successfully in the final runner. MiB values below
use the process lifetime high-water mark; elapsed time covers workload execution
after application initialization.

| Profile | Peak RSS (MiB) | Elapsed (s) | Image p95 (s) | Verified work |
| --- | ---: | ---: | ---: | --- |
| Idle application composition | 150.8 | 1.02 | — | Loaded routes; no database connection |
| Images, default 4 concurrent | 335.5 | 8.67 | 2.88 | 48 derivatives |
| Images, 1 concurrent | 214.1 | 13.19 | 4.32 | 48 derivatives |
| Multipart upload | 216.5 | 2.23 | — | 511 MiB plus metadata and cleanup |
| Mixed, default 4 image tasks | 340.5 | 12.65 | 4.16 | 48 derivatives, 511 MiB upload, 1 GiB transfer |
| Mixed, 1 image task | 277.2 | 15.99 | 7.28 | Same mixed workload |

The first completed mixed run peaked at 355.8 MiB with default four-way image
work and 289.2 MiB with one-way image work. Its image-request p95 was 4.56 s
versus 7.38 s respectively. Lowering concurrency trades memory for longer
queues; these observations do not justify changing the current default yet.

## Reproduce locally

Use Node 24 and the repository's installed dependencies. Run from the repository
root, with no other CPU-heavy tasks running:

```powershell
# In a disposable PowerShell process: this affinity applies to this shell and children.
[System.Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity = 3
node --max-old-space-size=384 --import tsx scripts/capacity-screen.ts
```

The runner prints JSON, avoids `.env` auto-loading, binds only to loopback, and
creates synthetic files in an invocation-owned temporary directory. The
directory is removed after the workers exit. A comma-separated subset is
supported, for example `scripts/capacity-screen.ts upload,mixed-4`.
On Linux, use `taskset` with two CPUs allowed by that host if an equivalent
affinity is wanted; it still does not enforce a total-memory limit.

## Existing checks

- In the original Windows checkout, `npm test` and `npm run build` stop at
  the canonical JSON check because checked-out localization files use CRLF.
  The Git blob is canonical LF; this is a checkout issue, not a capacity failure.
- An isolated worktree at the same commit was normalized to LF without
  changing the user's checkout or Git configuration. Dependencies were reused
  through a temporary junction. Cleanup is complete: the junction was removed
  without recursion, then the isolated worktree was removed after confirming
  it had no tracked content differences or untracked non-ignored files.
  The original project's dependency directory remains intact.
- In that LF copy, `npm run build` passes, including backend and frontend
  TypeScript checks, Vite, and asset budgets.
- `npm test` in that copy reaches the backend suite: **339 pass, 10 fail**.
  Eight failures involve Windows-incompatible `/bin/bash`/path assumptions in
  `httpsPlatformHooks.test.ts`; two involve POSIX executable-mode checks in
  `stageEbArtifact.test.ts`. The full test command is therefore not green.
- Separately, `npm run test:web` passes **238 tests in 42 files**.
- All four platform shell hooks pass `bash -n` using installed Git Bash against
  the LF copy. This is syntax validation, not a replacement for Linux hook tests.
- The new runner passes standalone TypeScript checking with the repository's
  strict, ES2020, ESNext/Bundler settings plus `esModuleInterop`.
- `git diff --check` passes; the final changes are the synthetic runner, this
  report, and its README entry. No dependency or production-code changes.
- MongoDB integration tests were not run: no local `mongod` was available.
  Listener E2E and ARM/Linux deployment gates were not run. No product routes,
  authentication behavior, or UI were changed in this verification.

## Concrete cloud candidate and acceptance gate

### AWS console preflight — 2026-09-07

Read-only inspection found the previous deployment under `Archtree-2024`,
not the empty `Archtree-2026` application. `Archtree-2024-env` was terminated
on September 6 at 14:05:14 EDT. Its saved configuration was retained from
14:00:52 EDT, together with 48 application versions. The last deployed version
was created on August 29. Subsequent release-metadata verification established
its source equivalence to the locally screened commit.

Opening the saved configuration in the unsubmitted environment wizard confirmed
single-instance topology, ARM64, `m7g.medium` (1 vCPU, 4 GiB), and Node.js 24
on Amazon Linux 2023 platform 6.11.7. `t4g.micro` (2 vCPU, 1 GiB) is available
in the same wizard. The template retains runtime variable names for database,
S3, authentication and HTTPS; secret values were not emitted or copied into
this report. This preflight preceded the separately authorized isolated trial.

Further inspection confirmed that CodePipeline's last successful source commit
`f1db187c324d0f4276e52640ea0d2723f3832718` and local `46c5ed6` share Git tree
`3ba60cdfd8cb5e10caadff8db5d987fdc929b8b5`. This establishes source equivalence;
the trial also downloaded the retained artifact and verified its RELEASE.json
commit against that pipeline commit.
Atlas shows a free, three-node replica set in us-east-1 with about 63 MB of its
512 MB allowance used. There is no existing test database. Route 53 hosts
`kashewt.com`, allowing a separate temporary subdomain.

The original template has no SSH key, and its
instance role has only the three EB managed policies and no inline policies.
A separately authorized temporary SSM-enabled role was used for the trial,
without altering the original role. Its additional S3 policy was scoped to the
dedicated private trial bucket. The trial used a separate database, JWT secret
and hostname; inherited static AWS credentials and the OpenAI key were blanked.

Candidate: `us-east-1`, one `t4g.micro` (1 GiB, ARM64), Node 24 on Amazon
Linux 2023, single-instance EB with the existing Nginx/HTTPS approach, one
public IPv4, and external MongoDB/S3. Build in CI, as the existing buildspec
already does. Install dependencies on the target rather than shipping Windows
`node_modules`; the lockfile includes Linux ARM64 Sharp and esbuild packages.
The retained release successfully installed dependencies and started on ARM64
Node 24.19.0 in the trial.

The trial kept application concurrency defaults and used
`NODE_OPTIONS=--max-old-space-size=384`. This limits V8 old space, not total RSS.
Set `TMPDIR=/var/tmp`: the actual `/tmp` was a 459 MiB memory-backed filesystem,
too small for the default 512 MiB audio limit. `/var/tmp` used the 20 GiB gp3 root
disk. Do not place MongoDB or load-generation clients on the application host.

With 730 hours, an 8 GiB gp3 root disk, one IPv4, and the current small DNS/S3/CI
spend, the estimate is **$11.26/month before tax**, excluding database charges,
domain renewal, traffic growth, and surplus CPU credits. A 20 GiB root disk
would raise that estimate to **$12.22**. Do not choose disk size on price alone:
Nginx can buffer uploads and Multer separately spools them, so the real trial
must measure temporary-disk use, including concurrent uploads.

Production acceptance still needs:

1. Clean ARM dependency installation, restart, health checks, HTTPS and renewal
   setup; run the repository's required Linux tests and deployment checks.
2. Peak **total instance** memory, available memory, swap activity, OOM events,
   temporary-disk free space, and recovery after the mixed workload. A provisional
   trial target is at least 200 MiB available memory and no growing retained RSS;
   this is an operational screening criterion, not a product guarantee.
3. Real MongoDB/S3 latency, Range/seek/disconnect behavior, signed-in browsing,
   upload cleanup, and image-heavy Home traffic. Use an isolated staging database
   and tracked synthetic storage lifecycle, preserving production data and DNS.
4. `CPUCreditBalance`, `CPUSurplusCreditBalance`, and
   `CPUSurplusCreditsCharged`. T4g.micro has two vCPUs with a 10% baseline per
   vCPU; Unlimited can charge for sustained excess, and Standard can throttle
   when credits run out. A short burst is not proof of all-day affordability.

The authorized cloud trial started at 2026-09-07 14:26:15 UTC, with a two-hour
deadline and estimated budget below $1. This is an estimate, not an AWS-enforced
spending cap. Aggregate trial evidence and cleanup verification follow below.

Sources: [AWS T4g specifications and credit behavior](https://aws.amazon.com/ec2/instance-types/t4/),
[AWS regional EC2 price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.csv),
[AWS IPv4 pricing](https://aws.amazon.com/vpc/pricing/), and
[Nginx request buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering).

## Real AWS trial results

The disposable environment used one ARM64 `t4g.micro`, 20 GiB gp3, no load
balancer, Node 24.19.0 and the source-equivalent retained EB release. MongoDB
Atlas remained external and free. The isolated hostname had a valid public TLS
certificate; `/health`, `/finitude`, and the referenced JS/CSS assets returned
200. The certificate renewal timer was enabled. Authentication, upload,
replacement and cleanup used the actual production routes with synthetic data.

| External-client workload | Outcome |
| --- | --- |
| 24 artwork requests at four client requests in flight, plus 16 concurrent-batched 8 MiB ranges | Passed in 12.63 s; image p95 3.58 s; server peak sampled RSS 426.4 MiB; 12 health samples, zero failures |
| 511 MiB replacement upload, then HEAD size verification | Passed in 17.14 s; server peak sampled RSS 177.1 MiB |
| Same replacement concurrently with another 24 artwork requests and 128 MiB of ranges | Upload passed in 21.71 s; image/range workload in 22.63 s; image p95 7.24 s; server peak sampled RSS 398.6 MiB; independent health probe had 21 samples and zero failures |
| Seek, invalid Range and client disconnect | HEAD 200, valid Range 206 with exact byte count, invalid Range 416; client abort exercised |

The four-minute server sampler spanning both external upload runs and the
concurrent workload recorded **186.9 MiB minimum available memory**, **15,861.5
MiB minimum free root-disk space**, and zero swap use over 480 samples. This
falls slightly below the provisional 200 MiB memory-headroom target. Functional
checks passed, but the conservative capacity acceptance gate did not fully
pass; treat 1 GiB as a low-traffic compromise requiring observation, not a
release-readiness certification.

Each upload process's own five-second health sampler recorded one timeout.
During the concurrent run, the separate image/range process's health sampler
recorded none. This does not establish the cause of the uploader's timeout or
provide a production latency guarantee. The image fixture was a deliberately
large 16-megapixel PNG; this short burst is not a user-count capacity estimate.

### Invalid co-located load generation and recovery

Two earlier runs put the load client on the 1 GiB server. They are **not valid
server-only capacity measurements**. The first lost responsiveness and required
a trial-instance reboot; the second reached 10 MiB available memory, recorded
OOM events and an automatic application restart. Moving upload generation to
the Windows client measured **617–619 MiB client RSS**, explaining why this
harness could overwhelm a 1 GiB host even when application RSS was modest.
Durable test media survived recovery and remained readable.

After the external-client tests, the application was healthy, its restart count
remained one, and the four matching OOM log lines had not increased. Recovery
RSS was about 374 MiB, so artwork-related native memory was not immediately
returned to the initial 145 MiB level. No swap was configured. Longer sustained
traffic and repeated-cycle memory behavior remain unverified.

The runtime contains production dependencies, not a full Linux development
test installation. Real-service checks supplement the local checks above;
they do not replace `npm run test:integration` or the Listener release E2E matrix.

The instance used Unlimited CPU credits. CloudWatch data retrieved at 15:04 UTC
showed surplus-credit balance reaching about 2.14 credits, with the latest
available point about 1.98 credits and charged-credit points still zero. These
lagging, short-trial metrics are not a final bill: outstanding surplus can be
charged on termination, and sustained workload can exceed the base monthly
estimate. The trial does not establish a hard $10 monthly cap.

## Cleanup and handoff

On 2026-09-07, media deletion ran through the application lifecycle before any
database removal. S3 then had zero objects and zero unfinished multipart uploads;
both media collections and the external synthetic account were confirmed empty.
The cleanup client initially tried to parse the successful account endpoint's
204 response as JSON; the subsequent database check verified account removal.
The runtime MongoDB user could not drop the database, so the exact disposable
`archtree_capacity_20260907` database was dropped through Atlas and its absence
was verified again from the instance.

The EB environment `archtree-capacity-20260907` was terminated within the
two-hour window. Cleanup checked that its EC2 instance was terminated, its EBS
volume no longer existed and its Elastic IP was released, then removed the
temporary hostname, empty S3 bucket, instance profile, dedicated IAM role and
its attached policies. No trial CloudWatch log groups were present. Temporary
local credentials and the CloudShell password-hash seed file were removed.
At the end of this first trial, the original production environment remained
stopped; no production data or
apex DNS record was changed, and the retained release artifact was preserved.

Review the 186.9 MiB headroom result before treating this as a production sizing
decision. The approximately $12.22/month configuration meets the relaxed cost
direction, while its small memory margin and the unrun full release gates are
explicit limits of that first-stage handoff, addressed by the subsequent trial
and production deployment report linked above.
