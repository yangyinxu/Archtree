Product behavior remains defined in [business-rules.md](../business-rules.md).

# Runtime reliability and capacity

<!-- @catalog -->
**Contents**

- [Database constraints and additive migrations](#database-constraints-and-additive-migrations)
- [Startup and shutdown](#startup-and-shutdown)
- [Privacy-preserving diagnostics](#privacy-preserving-diagnostics)
- [Single-process capacity contract](#single-process-capacity-contract)
- [Substring candidate index rollout](#substring-candidate-index-rollout)
- [Verification boundaries](#verification-boundaries)
<!-- @end-catalog -->

## Database constraints and additive migrations

MongoDB must be a writable replica set or a mongos deployment with logical-session
and transaction support; a standalone daemon is not a supported application
database. Before index writes or publishing the connection, startup reads `hello`
(legacy `isMaster` only when `hello` is unsupported), checks the writable topology,
session capability and required wire version, and rejects incompatible responses.
MongoDB 4.2 or newer (`maxWireVersion >= 8`) is a feature prerequisite for the
catalog lease update pipelines on both replica sets and mongos. Integration
verification uses MongoDB 8.0.12; the prerequisite check does not certify complete
compatibility with every older server release.
Failure closes the unpublished client and prevents HTTP startup. This is a
read-only prerequisite check, not a transaction or a certificate that every future
commit will succeed. See MongoDB's [transaction requirements](https://github.com/mongodb/specifications/blob/master/source/transactions/transactions.md).

Before any deletion transaction, startup explicitly creates
`catalogDeletionOperations` outside a transaction. Only numeric error code 48
(`NamespaceExists`) is accepted as an existing collection; any other creation
failure produces a fixed safe error, closes the unpublished connection, and
prevents HTTP startup. Repeated initialization preserves existing receipts.
This avoids transactional collection creation restrictions, including when a
mongos deletion writes across shards.

`src/infrastructure/databaseIndexes.ts` owns the index catalog. Unique indexes
are correctness requirements; ordinary performance indexes are best effort.
Startup creates missing indexes additively, verifies their exact key order and
uniqueness, and rejects sparse, partial, or incompatible-collation substitutes.
An existing correct index is reused. Indexes and duplicate records are never
automatically dropped or rewritten.

After verification, startup upserts the static receipt named by
`requiredIndexRevision` (now `required-indexes-v11-musicbrainz-ids`) in
`schemaMigrations`. It records only the revision and application time. A new
required constraint must receive a new reviewed revision. A partially failed
attempt is retried using the same additive definitions; a prior receipt is never
used to skip verification. Permission, duplicate-data, definition-conflict, or
receipt failures prevent the application from listening. The database connection
is published to Models only after initialization succeeds.

The deployment account needs the existing collection/index creation permissions,
index-metadata read access, and insert/update access to `schemaMigrations` in the
application database. Investigate duplicate data separately through the product's
normal lifecycle; do not remove evidence to make a migration pass. Optional-index
failure emits a fixed index identifier and category, without the original database
error or account values. This change does not inspect or modify production data
until the updated application is deliberately deployed.

Artist/Album deletion also requires read/insert/update/delete access to
`catalogDeletionOperations`, including permission for the startup create-collection
command. Accounts with collection-specific permissions must provision this
collection and its grants before deployment. Its lifecycle and recovery contract
are described in [Catalog deletion recovery](catalog.md#catalog-deletion-recovery).

`/health` requires a database ping, transaction-capable topology, and verified
required indexes. Successful topology/index checks are cached for 30 seconds;
after expiry, read-only metadata checks run concurrently and are coalesced per
process. No health request creates collections, builds indexes, starts a
transaction, or changes data.
A failed metadata read retains its diagnostic slot until all sibling reads settle.

Both successful and unavailable health responses include a `rooms` snapshot
with `scope: "process"`, `enabled`, `authorityState`, `authorityChanges`,
`lastSuccessfulSweepAgeMs`, `openSockets`, `openRooms`, and `failures`.
`openSockets` counts this process's realtime sockets; `openRooms` is the open-room
count read by this process's latest sweep, null before one. `authorityChanges`
counts state changes since start, and each change also writes one `room_authority`
log line. `enabled` reflects both social and
room rollout flags; authority state is independently `inactive` while nothing in
the process holds authority, `starting` during acquisition, `ready` while an
admitting gateway holds it, `windingDown` while a process started with rooms
disabled holds it to pause and end rooms left open, `unavailable` after
acquisition/lease failure, or `stopped` after shutdown. A disabled process returns
to `inactive` once no room is open. A runtime flag change (tests only; deployments
restart) can leave an installed gateway holding its lease. The sweep age is null
until a sweep succeeds, then a nonnegative millisecond age. Failure
counters use only `authorityAcquisition`, `sweep`, `refresh`, `report`, and
`disconnect`, saturate at `Number.MAX_SAFE_INTEGER`, and reset on process restart.
No account/room/session identifiers, raw exceptions, URLs, or caller-defined
labels enter these diagnostics. A room failure remains observable without
marking unrelated HTTP catalog and account routes unready. Monitor successive
snapshots per process; they are not durable or cluster-wide totals.
The `requests` snapshot groups routes into `auth`, `content`, `listener`, `media`,
`social` (`/api/social/v1`) and `other`; per group, `failed` counts 5xx responses
and `limited` counts 429 admission refusals.

Every process also writes one `ops_summary` JSON line a minute to stdout for
CloudWatch metric filters: configured room capacity, the room gauges above, the
interval's socket opens/closes (by close class), upgrade refusals by reason, ticket
failures, capacity refusals, fanout passes and maximum lag, room creations,
suspensions and closures, per-interval room failure deltas, social/room 429/503
codes, and 429 counts per request limiter (media admission refusals appear under
`media-delivery`). Room lifecycle transitions (`room_lifecycle`, with the opaque room
ID and a fixed close reason), the first refusal per minute at a capacity limit
(`social_capacity`) and the effective capacity at startup (`social_capacity_config`)
are immediate lines. The field reference and suggested alarms are in the
[social rollout runbook](../deployment/social-rollout-runbook.md#signals).

One database health probe per application handler combines those checks and ping
under a shared 1-second response deadline. Successful and failed results have a
1-second cache, so repeated probes do not immediately retry an unavailable
dependency. Readiness is a sampled check: the cached topology/index snapshot can
also age while the bounded probe runs and its final result is cached. If the
driver operation outlives the HTTP deadline, it retains
the single probe slot until it actually settles; later callers reuse the failed
response, including after a database identity change. They cannot enqueue more
Mongo commands or retain additional waiters on the unfinished operation. Expired
schema checks do not dispatch a late ping, and late success is not cached as ready.
MongoDB's configured network/queue timeouts still govern the underlying operation;
the HTTP deadline does not claim to cancel a command that the driver cannot cancel.

A replaced or disconnected database cannot inherit the old connection's ready
result. Slow capacity diagnostics become `null` after 250 ms. Draining and database
identity are checked again immediately before success is sent, so an overlapping
request cannot report stale readiness after shutdown or connection replacement.

## Startup and shutdown

Startup resolves only after the HTTP listener opens. Invalid configuration,
application construction failure, and an occupied port release the database and
reject startup. Node 24 is the supported server runtime.

SIGTERM and SIGINT start one shutdown operation. Repeated signals remain handled
until that operation finishes. The server marks itself draining, reports 503 on
health, refuses new requests with 503/Retry-After, and disables keep-alive on
admitted responses. It then waits for HTTP connections, transport completion of
every admitted response, and tracked business Promises. Node can report the server
closed before a disconnected response emits `close`, so the response wait keeps a
late dispatch for that request classified as cancellation. A client disconnect
does not mean its upload, transaction, or publication has finished. Every
asynchronous Controller uses `asyncHandler`; async authentication middleware
participates in the same tracker. The route-boundary test prevents new untracked
asynchronous Controllers and duplicate wrappers.

Before database teardown, admission for business work is closed atomically. A late
multipart/parser/auth callback cannot start a new Controller against the closing
database. Already-running operations may finish within the grace period. If the
period expires, remaining HTTP connections are destroyed, aborting their attached
media sources, and the outcome is `forced`; it is never described as successful
completion of an unfinished upload. Existing pending/replacement/deletion records
retain the database/S3 evidence needed by normal retry and reconciliation.

Work dispatch refused only because its original response has ended is an internal
cancellation. The application consumes that exact cancellation after recorded
transport completion, without logging a false server failure or writing another
response. Actual service failures and shutdown admission failures retain their
normal error handling; already-admitted business work remains tracked until it settles.

After the listener opens, startup starts the administrator background workers:
Luna analysis, import publication (which also cleans up automatic cover
candidates of completed imports and stages and cleans up lookup covers),
existing-catalog covers and metadata lookup. Each polls every two seconds and
runs at most one pass at a time through the lifecycle tracker, so that pass
counts as admitted business work. Draining aborts each worker's signal, which
cancels an in-flight metadata lookup request, stops new passes, and waits for
the admitted pass before MongoDB closes. Tests replace each worker through the
`startServer` dependencies.

- `SERVER_SHUTDOWN_GRACE_MS`: default 30000, maximum 120000.
- `SERVER_SHUTDOWN_CLEANUP_MS`: default 5000, maximum 30000.
- A maximum additional 100 ms allows socket-close hooks to run after a forced
  disconnect. Database cleanup has its own deadline. Graceful exit uses code 0;
  a forced or failed cleanup uses code 1.

Set the platform's termination allowance above both configured periods plus the
socket-close margin. The lifecycle uses Node's documented
[HTTP close APIs](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html).
No production shutdown or deployment was performed as part of the local remediation.

## Privacy-preserving diagnostics

Each request receives a newly generated `X-Request-Id`. Caller-provided IDs are
ignored. Unexpected-error logs include that random ID, a fixed request area,
method/status/time, and a controlled error category. No raw error message, stack,
URL, content identity, account identity, cookie, credential, or request payload is
added. This is a per-request debugging identifier, not a stored visitor identity.
Catalog failures use the same bounded categorization.

Unexpected errors after response headers or transport completion retain the same
bounded diagnostic, then close the response without a second JSON/header write or
forwarding a raw exception to Express's default logger. Error statuses must be
integer HTTP errors from 400 through 599; invalid values fall back to a generic
500. The internal completed-request cancellation described above remains silent.
Room and Social route adapters also forward known errors to this boundary when
the response has started, ended, or been destroyed; an already disconnected
socket cannot silently bypass genuine server-failure diagnostics.

Legacy Audio/Video upload, probe, stream, download, deletion, metadata, and artwork
cleanup failures use `mediaDiagnosticsService.ts` with fixed failure categories.
HTTP handlers retain only their generated request ID and controlled error category;
storage lifecycle recovery uses fixed categories without an HTTP identity. Logs
never include filenames, database IDs, S3 keys, decoded service errors, or stacks.
Storage success, deferred cleanup, and retry semantics remain in the lifecycle
records and response contracts rather than private diagnostic payloads.

Health includes process-scoped request counters and fixed latency buckets, artwork
scheduler occupancy and limits, available/total temporary-disk bytes, existing
media admission/stream counters, and memory. Client keys and filesystem paths are
never returned. Disk values are cached for 30 seconds and report unknown on read
failure; failed diagnostics do not fabricate free space. The artwork scheduler is
now independent of S3 lifecycle code and reads configuration lazily after startup
loads the environment. Its existing fair queue and cancellation rules remain.

## Single-process capacity contract

These counters, rate windows, upload/transform limits, and media admission limits
protect one process. They are not a deployment-wide quota. The current architecture
remains a single application process per instance. The per-account room and social
request windows and concurrency slots are kept in that process's memory on purpose:
on the single Elastic Beanstalk instance they are complete per-account budgets, and a
restart only resets the current window. A second process or instance would give
every account and IP another full budget. Before multiple replicas are
introduced, explicitly design shared abuse limits and measure the aggregate media
and provider budget. A shared cache, queue, CDN, or worker service is not introduced
without a measured requirement and a compatible ready/deletion/revocation contract.

Administrator metadata lookup is the one deployment-wide bound that the
confirmed rules require: each source's request spacing and concurrency apply
across every instance. The gates live in the MongoDB collection
`adminMetadataLookupGates`, one `_id`-keyed document per source (`musicbrainz`,
`itunes`, `coverartarchive`) with its next allowed start and expiring leases,
decided on the database clock and written outside transactions. The gate
collection holds no account data and needs no secondary index; a lease that is
never released expires after 30 seconds. Startup does not create
`adminMetadataLookupGates`; the first acquisition upserts each source document
by `_id`, so the application account needs insert/update on that collection. The
lookup response cache stays process-local: each lookup worker keeps its own.

Metadata lookup jobs live in `adminImportLookups`, one record per import project
or existing-Album review (`_id` is the project's `_id`; a new run replaces the
previous one). A record
holds its run number, state (`queued`, `running`, `retrying`, `complete`,
`unavailable`, `stopped` or `superseded`), the granting administrator and a
one-hour grant, the bound file set, the planned queries and progress, at most 25
candidates (MusicBrainz releases or iTunes collections, 4 MiB of JSON
together) and whether its searches were complete, the ranking (candidates plus
ranking stay within 12 MiB, well under MongoDB's 16 MiB document limit), the
applied candidate (or none) with its values, conflicts and flagged values (at
most one of each per draft value) and a 180-second worker lease. The lookup
worker (`startMetadataLookupWorker` in
`src/administration/lookup/metadataLookupService.ts`) starts after listen with
the other administrator workers, polls every 2 seconds, is tracked by the server
lifecycle and is stopped before database teardown; a stop aborts the request in
flight and releases the lease, so the next claim resumes at the stored step. It
is idle while imports are disabled. The required index
`admin_import_lookup_worker` (`{ state: 1, leaseUntil: 1, retryAt: 1 }`) also
creates the collection at startup, so no transaction ever creates it, and
`requiredIndexRevision` was then `required-indexes-v10-metadata-lookups`. The
application account needs insert/update on `adminImportLookups`. Import and
review documents gain `lookupGate`, a never-projected fence written in the same
transaction as every lookup run started, every lookup state change and every
re-rank of stored candidates, which never changes the project's `revision`. It
conflicts only with transactions that also write the import document, so the
publish gate, which reads it with the lookup record, also writes it. The step
that completes a run, a re-rank of stored candidates and a choice or conflict
answer write applied values to the import document in the same transaction as
the record (and, for the worker and a re-rank, the gate). Automatic writes
bump only `valueRevision`; a choice or an answer also takes its receipt's
`revision`. File-tag automation reads the record's applied values in its own
transaction, so it never replaces them; no index is added.

An application whose release reports front artwork, or whose iTunes-only
candidate has an allowlisted iTunes artwork address, also records the import's
lookup cover job, `media.lookupCover`, in the same transaction; it is never
projected and never changes `revision`. The publication worker runs the lookup
cover pass (`runLookupCoverPassOnce` in
`src/administration/import/adminImportLookupCover.ts`) on ticks that publish
and sweep nothing, because it owns private storage: one import whose job is
due, under a five-minute lease that a stopped pass leaves to expire. The
optional index `admin_import_lookup_cover_worker`
(`{ 'media.lookupCover.due': 1, 'media.lookupCover.leaseUntil': 1 }`) serves
its claim; it is no constraint, so its failure is only a startup diagnostic and
`requiredIndexRevision` does not change. Candidate artwork previews are
read-only apart from the shared gate's bookkeeping in
`adminMetadataLookupGates`: they write no import, lookup or catalog document
and no storage object.

The iTunes fallback adds no collection, index or `requiredIndexRevision`
change. A lookup record may hold `itunesStage` (the stage's requests, at most
four results with their storefront names, and its bridge searches),
`exhausted` (sources whose retries ran out) and `attempts.itunes`, and an
iTunes-only candidate (`itunes:<collection ID>`) keeps its storefront, check
and validated mzstatic artwork address under `itunes`, never projected; the
lookup cover job keeps that address as `artworkUrl`. Import documents gain
`localizedNames` (at most 21 groups of 4 iTunes localized artist names),
written only by lookup value application in the same transaction as the
applied values, and a format-3 approval freezes the groups that hold a current
Artist entry's name as `media.publication.localizedNames` (only when there are
some), which the worker's preselection recheck reads. The lookup worker's
MusicBrainz and iTunes clients share one gate client and one response cache;
iTunes requests and an iTunes-only candidate's artwork go through the `itunes`
gate document (one request at a time, 3 seconds apart). The release before the
fallback ignores these fields (see
[Rollback floors](../features/admin-workbench.md#rollback-floors)).

MusicBrainz IDs add two required unique partial indexes, `artist_musicbrainz_id`
on `artists` and `organization_musicbrainz_id` on `organizations`, each
`{ musicBrainzId: 1 }` with the partial filter
`{ musicBrainzId: { $type: 'string' } }`, so any number of records without an ID
coexist and an Artist and an Organization may share one ID.
`requiredIndexRevision` is now `required-indexes-v11-musicbrainz-ids`. Existing
duplicate string IDs fail startup closed
(`DatabaseIndexInitializationError('artists:musicBrainzId')` or the
`organizations` equivalent); nothing is dropped. Before deploying, list
duplicates with an aggregate such as `[{ $match: { musicBrainzId: { $type:
'string' } } }, { $group: { _id: '$musicBrainzId', count: { $sum: 1 } } },
{ $match: { count: { $gt: 1 } } }]` on each collection and clear the extra IDs
through the admin catalog editor. A write that would duplicate an ID fails
inside its transaction (see [MusicBrainz IDs](catalog.md#musicbrainz-ids)): an
Admin catalog edit returns `409 ADMIN_CATALOG_MUSICBRAINZ_ID_IN_USE`, and an
import commit becomes needs attention (`identityConflict`). Once IDs are
stored, the release before them is the rollback floor (see
[Rollback floors](../features/admin-workbench.md#rollback-floors)); it keeps
the indexes (harmless: its writers never set the field, and listener DTOs were
already allowlisted) and ignores the alias phase of lookup records (they complete
through the details-done branch). It ignores `musicBrainzIdWrite` and
`musicBrainzNames`: it publishes a format-3 approval that creates records, or
reuses records without an ID, without writing any ID, while one that reuses an
Artist or Organization holding an ID (an exact-ID reuse, a kept ID or a
replace) becomes needs attention there, because its reviewed revisions include
the ID and that release never preselects by ID; roll back only while no such
publication is preparing or in needs attention (the Rollback floors bullet has
the `mongosh` check), or cancel them first. It refuses the `musicBrainzIds`
this Web sends with its approvals as invalid input, and an unanswered Artist or
label conflict whose lookup value carries IDs is not shown there but still
holds publication (choose the candidate again or none to clear it). Decisions
saved while rolled back for an entry or label carrying an ID bind none after
rolling forward and are cleared. The lookup worker sends at most 16 extra
artist or label alias lookups per run, through the same deployment-wide
MusicBrainz gate, and a source failure ends that alias phase at once.

Playback Audio/Video GETs that briefly overlap an older stream may wait up to two
seconds for an existing admission slot. The pending pool is bounded to 32 per
process and eight per client; active limits and playback reserves do not increase.
A blocked client cannot hold up another client's available slot. HEAD and
non-playback requests retain immediate rejection. Queue cancellation removes all
timer/response hooks; expiration or queue overflow retains 429 with Retry-After.
Source and lifecycle validation happen after waiting, before storage access.
An admitted slot releases only after transport completion and all tracked handler
or storage work settle, so an aborted stream cannot free capacity prematurely.
While motion previews are disabled, a Web card hover preview of a Video
MediaTrack reads the same public stream and is admitted as playback. Once they
are enabled it reads `/content/mediaTrack/motion-preview/:id`, admitted as the
`motionPreview` class: rejected at once when full, never queued, and never
given the playback reserve. A tab runs at most one preview, and clearing its source
when the preview stops aborts the request, so it holds at most one slot.

Catalog substring searches now share a dedicated per-process limit of eight active
requests and two per client across both public search surfaces. Rejection returns
429/Retry-After. A slot releases only after both the response has finished/closed
and all admitted asynchronous work has settled. Client disconnect is a cancellation
signal, not proof that a query, transaction, provider request, or password operation
has stopped. A late middleware callback cannot start a new asynchronous Controller
after the response has closed. This rule also applies to the shared authentication,
upload, Playlist-mutation, and reconciliation limiters. New asynchronous work must
participate through `asyncHandler` or `runRequestWork`; detached background jobs
need their own resource ownership. Search does not consume upload capacity.
Name/title + ID indexes support deterministic catalog ordering and can
reduce document reads, while current query/result/time limits remain in place.

Run this isolated, bounded query-plan probe:

```sh
npm run profile:search
```

It creates 10000 synthetic records in a disposable loopback MongoDB replica set,
then compares the original regex, title/ID index, and substring candidate index.
It never reads an application database or prints titles or target URLs. A local
MongoDB 7.0.11 run returned the same 20 rows with 10000 keys examined by the
ordering index versus 21 keys and 40 document examinations by the candidate
index. `test/catalog/catalogSearch.integration.ts` enforces a candidate-work bound for
that workload. This is a selective-query regression guard, not a latency SLO for
all queries or all catalog sizes.

## Substring candidate index rollout

`CATALOG_SEARCH_INDEX_ENABLED` defaults to false and enables indexed candidate
filtering only when exactly `true`. Every supported Artist, Organization, Album,
and MediaTrack create/rename path writes derived `catalogSearchVersion` and
`catalogSearchGrams` in the same document mutation as its name/title, regardless
of the read flag. These internal fields never enter public DTOs. They contain
unique lower-case ASCII one-, two-, and three-character grams for source strings
up to 512 characters (at most 1533 entries). Non-ASCII or longer sources use
version 0; missing/unsupported versions remain on the original regex path.
Non-ASCII queries also use that path, preserving MongoDB Unicode case matching.
The original escaped, case-insensitive substring regex always verifies candidates;
ordering, limits and ready-content predicates do not change.

The additive indexes are `{catalogSearchVersion: 1}` and
`{catalogSearchGrams: 1, catalogSearchVersion: 1}` on each of the four collections.
They increase write/storage work; measure representative text lengths, common
short queries, Unicode share and catalog sizes before enabling broadly. Broad
matches and unsupported/legacy sources can still require linear work. Existing
search admission and query-time bounds remain mandatory.

Deploy the new writers to every process with indexed reads disabled, then run
bounded backfill pages on the intended configured database:

```sh
npm run backfill:catalog-search -- --collection=albums --limit=100
npm run backfill:catalog-search -- --collection=albums --limit=100 --apply --confirm=APPLY_CATALOG_SEARCH
```

Repeat separately for `artists`, `organizations`, and `audioTracks`. Pass the
returned `nextCursor` as `--after=<cursor>` until it is null. The default is a
read-only report; apply requires the explicit confirmation value. The script
verifies existing required schema without creating indexes or collections. It
prints only counts and a checkpoint, never source text. Each update compares the
exact observed source, so a concurrent rename or deletion cannot be overwritten.
A failed/uncertain page is safely rerun with the same cursor; a changed source is
reported separately and can be rechecked on a new pass. Retain checkpoints until
completion and confirm the two candidate indexes exist before enabling the flag.

Disable indexed reads before rolling back to a binary that does not maintain the
projection. Keep them disabled across any mixed-version writer period. Before
re-enabling after such a rollback, rerun the full backfill from the first page:
old writers can leave an otherwise valid version-1 projection stale. Normal
query reads never perform migrations or mutate catalog records.

Use the existing `npm run test:media-load` only against an explicitly authorized
target. Before a capacity change, compare rejected playback, API latency buckets,
artwork occupancy, memory and disk headroom under real workload. The synthetic
query profile is not an AWS capacity or cost claim.

## Verification boundaries

Unit coverage includes required/optional index failures, schema mismatch, dropped
constraints, bounded/hung readiness dependencies, overlapping drain, sensitive-log
redaction, repeated signals, in-flight and disconnected mutations, late parser/auth
callbacks, forced streams, and startup failure. Mongo integration checks actual
unique-index enforcement and proves that failed initialization does not delete
synthetic duplicate rows. Existing lifecycle/transaction suites remain required.
Linux platform hooks and the complete browser release gate remain mandatory for a
release; see [development environments](../development/environment.md). Windows
checks do not substitute for Linux executable-bit or systemd verification.
