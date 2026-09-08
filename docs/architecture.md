# Architecture and operational contracts

This document describes implementation boundaries and recovery contracts. Product
behavior remains defined in [business-rules.md](business-rules.md).

## Catalog application and presentation boundaries

The canonical product contract remains [business-rules.md](business-rules.md).
This refactor preserves HTTP routes, response shapes, administrator guards,
ready-content visibility, and the existing MongoDB/S3 lifecycle. It introduces
no new client behavior or native-client requirement.

### Responsibility map

- `controllers/artistController.ts` and `controllers/albumController.ts` adapt
  JSON requests. `controllers/contentManager/` separates page queries, Artist,
  Album, Credits/Organizations, guided release, and MediaTrack HTTP adapters.
  Adapters own authentication checks, request decoding, and JSON/redirect
  responses. `controllers/contentController.ts` is a compatibility export
  facade for existing route consumers.
- `application/catalog/publishNewArtist.ts` and `publishNewAlbum.ts` publish an
  owner with already-uploaded artwork and compensate a definite failed insert.
  JSON, form, and guided-release callers use these same functions; no service
  imports business functions from an HTTP Controller.
- `repositories/catalog/` owns each creation transaction and confirmation of an
  uncertain insert. A transaction fences ready referenced content and the active
  provenance account, establishes Album membership in Track Number order, and
  inserts the owner. `Artist.save()` / `Album.save()` retain their existing
  calling contract by delegating to those repositories. Read/update/delete Model
  APIs stay intact; this is not a migration of every Model to a new abstraction.
- Existing lifecycle and relationship services continue to own replacement,
  deletion, reference fences, Credits, and guided-release operation recovery.
  An atomic operation stays in one transaction instead of being split among
  new HTTP modules.
- `views/contentManager/managePageView.ts` renders supplied page data;
  `src/public/content-manager-base.css` owns the extracted styles and loads before
  the existing `content-manager.css` visual overrides. Rendering does not
  query or mutate the database. Inventory loading belongs to the query adapter.
- Catalog adapters log only a fixed operation category, a controlled error
  category, and the server-generated request ID when available. Uploaded
  filenames, content identifiers, raw exception messages, and exception stacks
  are excluded from these diagnostics.

### Lifecycle responsibilities preserved

| Operation | Required ordering and failure outcome | Owner |
| --- | --- | --- |
| Create artwork | Persist pending image lifecycle evidence before upload; mark ready after storage succeeds, preserving an incomplete record on uncertainty | Image storage service |
| Publish Artist/Album | Attach the ready artwork to the insert candidate; validate/fence references and account, then commit the owner transaction | Publication use case and repository |
| Definite insert failure | Delete only that candidate's exact uploaded artwork; failed cleanup reports `*_creation_cleanup_pending` and retains reconciliation evidence | Publication use case and image lifecycle service |
| Uncertain insert | Confirm only an exact ready owner, provenance, title/name, and artwork identity; unavailable confirmation or uncertain commit without a matching owner remains `outcomeUnknown`; never compensate its artwork | Publication repository and use case |
| Replace artwork/media | Upload and attach the replacement before cleaning the prior object; conditional reference updates preserve a concurrent winner and expose incomplete cleanup | Existing image/audio lifecycle services |
| Delete | Fence lifecycle state, delete owned storage, idempotently remove references, then remove final metadata; failure retains traceable retry state | Existing Artist/Album/MediaTrack lifecycle services |
| Partial guided release | Keep published Artist/Album records and persisted step results when optional Carousel/Page work fails | Artist release workflow service |
| Retry/reconcile | Resume the recorded operation or publication state; do not repeat uploads or delete unknown assets; reconciliation remains read-only unless the administrator explicitly selects supported remediation | Existing workflow/publication recovery/reconciliation services |

### Verification

`test/catalogCreatePublication.test.ts` exercises artwork attachment, definite
failure compensation, cleanup failure, unknown commit handling, and both JSON
and form response adapters. Catalog boundary checks ensure services cannot
depend on HTTP Controllers and the Content Manager view cannot perform database
work. The stylesheet regression preserves the existing CSS cascade. Existing
Content Manager inventory/client and administrator authorization
tests continue to check the rendered controls and route behavior. Artist/Album
lifecycle, guided-release, Credit, and relationship integration tests remain the
regression gates for transaction and retry semantics.

## Listener public contracts and browser boundaries

`src/contracts/listenerV1.ts` is the canonical TypeScript DTO source for the
public `/api/listener/v1` catalog and composition responses. It imports neither
database models nor HTTP, storage, or browser libraries. The service imports these
types and annotates its response envelopes; existing service type exports remain
available for server callers.

The Web schemas in `web/src/api/contentSchemas.ts` and `collectionSchemas.ts`
validate wire data. `contentContractAlignment.ts` is compiled with the Web build
and checks both assignability and complete top-level keys against the canonical
DTOs. Each nested public DTO is also checked independently. Updating only one side
therefore fails type checking even when the difference is an optional field.

### Compatibility policy

- Public catalog and collection response objects discard unknown additive fields
  recursively before returning the parsed result to a query cache or UI.
- Known fields still validate their requiredness, value type, bounds, enum, and
  reference relationships. A new discriminator or enum variant is not an additive
  field and requires a negotiated capability or a new major API contract.
- Missing `mediaType` defaults to Audio for the existing legacy wire contract;
  missing Search `organizations` defaults to an empty collection. These are the
  existing compatibility defaults, not general permission to invent missing data.
- Request schemas remain strict. Account/session responses retain their separate
  strict policy. Owner-scoped Library, saved-state, and Playlist responses retain
  their existing validation rules; shared public summaries use the public policy.
- The server must continue to construct allowlisted DTOs from database-confirmed
  ready content. Client stripping is compatibility handling, not authorization or
  permission for the server to send private fields. Existing server projection and
  lifecycle integration tests remain required security checks.

`contracts/listener/v1/fixtures/album-legacy.json` and `album-current.json` are
credential-free, database-independent JSON examples that native consumers can
load unchanged. The compatibility test reads both through the current parser and
reads the current fixture through an independent frozen baseline parser.

The frozen parser establishes the forward-compatible reader introduced by this
change. It does not retroactively change already-open historical Web clients
whose schemas used `.strict()`. Deploy this reader before introducing new wire
fields, and retain the existing response shape until those clients can refresh;
use a versioned endpoint or capability negotiation if an immediate incompatible
change is necessary. The fixtures must be extended with every wire addition, and
the frozen baseline reader must not be silently updated to make a test pass.

The sibling `D:\Documents\GitHub\Finitude_iOS` repository was unavailable during
this change, so native decoding could not be verified. No native product behavior
or server response field was changed. Native adoption should run the same fixtures
against its decoder before shipping.

### Browser module boundaries

`playerStore.ts` continues to own the single media element, immutable queue,
history, and transport state. `queueOrder.ts` contains only pure ordering and
queue-copy functions. `mediaSessionAdapter.ts` owns optional browser system-control
registration, snapshot publication, and cleanup; every system action delegates to
that same store. It does not create a player or queue, and browser integration
errors cannot escape into transport.

Persistent browser-session schemas remain in `schemas.ts`. Account-route request
and response validators live in `accountSchemas.ts`, so public browsing does not
eagerly initialize password-recovery and account-management validation chains.
This split preserves the validation policy and requires no dependency changes.

### Verification

Run `npm run typecheck --workspace @archtree/finitude-web` for cross-boundary type
alignment. From `web/`, run `npx vitest run src/api/contentSchemas.test.ts
src/api/listenerContractCompatibility.test.ts src/player/playerStore.test.ts
src/player/queueOrder.test.ts` for the focused wire and transport checks, followed
by the normal full test/build and Listener playback/release gates for a release.
The existing build measures every emitted entry's transitive gzip JavaScript
against the unchanged 150 KiB limit; architectural splitting must not raise that
limit merely to make the gate pass. Inspect future eager dependencies before adding them; the current budget has little spare capacity.


The deterministic presentation-test media helper now wraps the shared `video`
element as well as legacy `Audio` construction. Keyboard editing is tested with
an Audio track, because active Video intentionally hides the browse workspace.
Real stream/seek and media-continuity tests still exercise the browser media
pipeline; those gates are not replaced by this presentation test double.

## Runtime reliability and capacity

### Database constraints and additive migrations

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

After verification, startup upserts the static `required-indexes-v1` receipt in
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
are described in [Catalog deletion recovery](#catalog-deletion-recovery).

`/health` requires a database ping, transaction-capable topology, and verified
required indexes. Successful topology/index checks are cached for 30 seconds;
after expiry, read-only metadata checks run concurrently and are coalesced per
process. No health request creates collections, builds indexes, starts a
transaction, or changes data.
A failed metadata read retains its diagnostic slot until all sibling reads settle.

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

### Startup and shutdown

Startup resolves only after the HTTP listener opens. Invalid configuration,
application construction failure, and an occupied port release the database and
reject startup. Node 24 is the supported server runtime.

SIGTERM and SIGINT start one shutdown operation. Repeated signals remain handled
until that operation finishes. The server marks itself draining, reports 503 on
health, refuses new requests with 503/Retry-After, and disables keep-alive on
admitted responses. It then waits for both HTTP connections and tracked business
Promises. A client disconnect does not mean its upload, transaction, or publication
has finished. Every asynchronous Controller uses `asyncHandler`; async authentication
middleware participates in the same tracker. The route-boundary test prevents new
untracked asynchronous Controllers and duplicate wrappers.

Before database teardown, admission for business work is closed atomically. A late
multipart/parser/auth callback cannot start a new Controller against the closing
database. Already-running operations may finish within the grace period. If the
period expires, remaining HTTP connections are destroyed, aborting their attached
media sources, and the outcome is `forced`; it is never described as successful
completion of an unfinished upload. Existing pending/replacement/deletion records
retain the database/S3 evidence needed by normal retry and reconciliation.

- `SERVER_SHUTDOWN_GRACE_MS`: default 30000, maximum 120000.
- `SERVER_SHUTDOWN_CLEANUP_MS`: default 5000, maximum 30000.
- A maximum additional 100 ms allows socket-close hooks to run after a forced
  disconnect. Database cleanup has its own deadline. Graceful exit uses code 0;
  a forced or failed cleanup uses code 1.

Set the platform's termination allowance above both configured periods plus the
socket-close margin. The lifecycle uses Node's documented
[HTTP close APIs](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html).
No production shutdown or deployment was performed as part of the local remediation.

### Privacy-preserving diagnostics

Each request receives a newly generated `X-Request-Id`. Caller-provided IDs are
ignored. Unexpected-error logs include that random ID, a fixed request area,
method/status/time, and a controlled error category. No raw error message, stack,
URL, content identity, account identity, cookie, credential, or request payload is
added. This is a per-request debugging identifier, not a stored visitor identity.
Catalog failures use the same bounded categorization.

Health includes process-scoped request counters and fixed latency buckets, artwork
scheduler occupancy and limits, available/total temporary-disk bytes, existing
media admission/stream counters, and memory. Client keys and filesystem paths are
never returned. Disk values are cached for 30 seconds and report unknown on read
failure; failed diagnostics do not fabricate free space. The artwork scheduler is
now independent of S3 lifecycle code and reads configuration lazily after startup
loads the environment. Its existing fair queue and cancellation rules remain.

### Single-process capacity contract

These counters, rate windows, upload/transform limits, and media admission limits
protect one process. They are not a deployment-wide quota. The current architecture
remains a single application process per instance. Before multiple replicas are
introduced, explicitly design shared abuse limits and measure the aggregate media
and provider budget. A shared cache, queue, CDN, or worker service is not introduced
without a measured requirement and a compatible ready/deletion/revocation contract.

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

It creates only 10000 synthetic records in a disposable loopback MongoDB replica
set and removes that database afterward. It does not read application `.env` values
for its target or query an existing catalog. It reports counts and execution time,
never titles, content IDs, or a target URL. In the local Windows/MongoDB 8.0.12 run,
a substring query returning the final 20 sorted items examined 10000 documents
without the title/ID index. With the index it examined 20 documents but still
10000 index keys (4 ms vs 6 ms in this small run). This proves lower document
fetching, not a general latency improvement or sublinear substring search. Large
catalog search remains a capacity measurement item, with bounded admission and
query time; changing search semantics requires a separate product decision.

Use the existing `npm run test:media-load` only against an explicitly authorized
target. Before a capacity change, compare rejected playback, API latency buckets,
artwork occupancy, memory and disk headroom under real workload. The synthetic
query profile is not an AWS capacity or cost claim.

### Verification boundaries

Unit coverage includes required/optional index failures, schema mismatch, dropped
constraints, bounded/hung readiness dependencies, overlapping drain, sensitive-log
redaction, repeated signals, in-flight and disconnected mutations, late parser/auth
callbacks, forced streams, and startup failure. Mongo integration checks actual
unique-index enforcement and proves that failed initialization does not delete
synthetic duplicate rows. Existing lifecycle/transaction suites remain required.
Linux platform hooks and the complete browser release gate remain mandatory for a
release; see [development environments](development-environment.md). Windows
checks do not substitute for Linux executable-bit or systemd verification.

## Browser session recovery

Cookie-changing operations remain serialized by the same origin-wide Web Lock.
`runBrowserSessionTransition` gives its callback an active scope. An account
mutation that already owns this lock passes the scope to the API client, which
refreshes inside that scope instead of queuing another transition or joining a
refresh waiting behind it. Scopes expire when their callback returns; an identity
transition also invalidates an older scope's reserved account generation.

Logout-all and account deletion retain their sequence: authenticated server
mutation, best-effort browser cookie cleanup, then account-state notification.
An expired access cookie can refresh once inside the existing lock. A failed
refresh releases the lock and returns a retryable failure to the confirmation UI.
Storage-fallback cleanup never receives permission to install or rotate cookies.

Every automatic recovery retains the initiating account epoch and viewer. The
client checks this guard before recovery, after acquiring the lock, after each
session read or rotation, before conflict cleanup, and before retrying the
original request. A late 401 from an earlier account cannot clear the current
session. The same guard runs before processing a response and after decoding its
error body, so a late 409 cannot publish an account-mismatch reconciliation event.
Genuine conflicting access/refresh identities still use the existing
locked signed-out recovery. Refresh coalescing is scoped to the epoch, viewer,
and bootstrap mode; an operation in a replacement epoch cannot join stale work.
An aborted request does not retry its mutation after shared recovery completes.

Verification from `web/`:

```sh
npx vitest run src/api/client.test.ts src/api/session.test.ts src/api/sessionTransition.test.ts src/api/sessionRecovery.test.ts src/features/account/AccountLifecyclePanel.test.tsx
npm run typecheck
npm run typecheck:e2e
npm run build
npx playwright test e2e/session-recovery.spec.ts e2e/account-isolation.spec.ts --workers=1
```

The browser tests exercise the built production bundle with isolated mocked
credentials and real browser Web Locks. Chromium, Firefox, and WebKit remain
separate validation targets; an unavailable local browser dependency is an
environment limitation, not permission to skip that browser's release gate.

## Catalog deletion recovery

Artist and Album deletion uses a durable `catalogDeletionOperations` receipt.
The receipt has the deterministic `_id` `artist:<id>` or `album:<id>`; the
collection's ordinary unique `_id` index is sufficient. The receipt contains
only the owner identity, reference revision, lease token and expiry, current
cover ID, prepared image IDs, status, and update time. It contains no account
credentials or private request payloads.

Startup explicitly creates the receipt collection outside a transaction before
publishing the database connection. Only numeric error code 48 (`NamespaceExists`)
is accepted as an existing collection; other creation or permission failures
prevent startup with a fixed safe error. Repeated initialization preserves all
existing receipts, and readiness never creates collections.

The application database role needs read, insert, update, and delete access to
this collection, alongside its existing Artist, Album, and image lifecycle
permissions and permission for the startup create-collection command.
Deployments with collection-specific permissions should provision the
collection and grant those permissions before starting this version. A writable
replica set or mongos with logical sessions and MongoDB 4.2 or newer (wire version
8 or newer) is a feature prerequisite for transaction and update-pipeline support.
Integration verification uses MongoDB 8.0.12; this is not a certification of
complete compatibility with every older release. Pre-creating the receipt
collection also avoids cross-shard transactional collection creation restrictions.
See the [MongoDB transaction limitations](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).
S3 permissions are unchanged.

### Deletion stages

1. A MongoDB transaction claims the receipt and moves its owner to `deleting`,
   increments `referenceRevision`, and records a new lease token. Ready and
   failed owners can be claimed immediately. An existing live receipt rejects
   another request with the existing `artist_deletion_in_progress` or
   `album_deletion_in_progress` conflict.
2. The service enumerates every owned cover-art lifecycle record, including
   detached replacements, using the existing 1,000-asset bound. It validates
   exact owner and storage identity, records `deleting`, and deletes the
   recorded S3 objects. Pending uploads continue to block owner removal.
   These network operations run outside database transactions.
3. The complete set of successfully prepared image IDs is persisted in the
   receipt. Shared references are removed idempotently. The owner is deleted
   in a transaction that also touches the current, unexpired receipt token.
4. Each prepared image record is removed with its receipt entry in one fenced
   transaction. The exact image ID, owner, key, and `deleting` status must still
   match. Missing image records are treated as already finalized. The receipt
   is removed only after a transaction confirms that the owner is absent and
   its prepared-image list is empty.

### Interruption and retry

The lease lasts two minutes, measured with MongoDB `$$NOW`, and a serial
heartbeat renews it every forty seconds. The heartbeat does not keep Node
alive and is stopped when the operation settles. A heartbeat failure stops
that worker from advancing. The next stage also verifies ownership directly.
Every terminal database write and image lifecycle update touches the receipt
inside the same transaction, so a superseded worker cannot change the
successor's owner, receipt, or image evidence. A late S3 failure therefore
cannot change a successor's prepared image back to `deleteFailed`.

An ordinary failure retains the receipt and marks the owner, when present,
and receipt as failed for an immediate administrator retry. If the failure
write also fails, or the process terminates, the lease expires and the same
delete endpoint can reclaim it. A pre-receipt `deleting` owner is reclaimable
after its lifecycle timestamp is at least two minutes old; an old record
without that timestamp can be reclaimed immediately. New references remain
blocked throughout recovery.

If the owner has already disappeared, retry uses the receipt's remaining
prepared IDs and finishes image cleanup. It does not recreate the owner or
repeat a confirmed S3 deletion. A historical image record left in
`deleteFailed` is an exception: retry validates its exact identity and confirms
S3 deletion again before removing its evidence. An unexpected identity or
other lifecycle state is retained as an unresolved failure.

Administrator reference reconciliation exposes `catalogDeletionFindings` for
failed receipts, expired leases, and recoverable legacy owner states. Reports
remain read-only, and truncated scans never infer that an unseen receipt is
absent. Retry uses the existing authenticated administrator delete endpoint;
there is no background data deletion or manual status reset requirement.

### Verification

Run `node --import tsx --test --test-concurrency=1
test/catalogDeletionRecovery.integration.ts` with the configured local MongoDB
test runtime. The suite uses isolated replica-set data and injected S3 calls.
It covers live claims, lease takeover, stale workers, late S3 failures, failed
database failure-state writes, old lifecycle records, ownerless recovery,
receipt completion guards, and heartbeat failure. The existing Artist and
Album lifecycle integration suites cover reference fencing and publication
compatibility.

## Bounded Catalog reference audits

`reconcileContentReferences()` produces an administrator-only, read-only report.
An incomplete scan establishes neither a missing Credit subject nor a mismatched
Album compatibility projection. It must not be used as automatic repair authority.

### Credit evidence and completeness

The initial Artist and Organization reads obey `MAX_RECONCILIATION_OBJECTS` per
collection and retain one lookahead record to detect truncation. A subject in that
window can be checked directly. A subject absent from a complete window is missing;
absence from a truncated window requires an exact `_id` lookup before declaring it
missing. Supplementary queries project only identity and lifecycle state. A known
subject whose lifecycle is neither legacy-ready nor `ready` remains unavailable.

Credit subject lookup IDs are deduplicated across Album/MediaTrack owners and
roles; Artist and Organization targets share the remaining
`MAX_RECONCILIATION_REFERENCES` budget with previously scanned embedded references.
If no budget remains for a required target, the report records unverified evidence.
It does not turn the unknown state into `missingSubject` or `unavailableSubject`.
An actual database query failure fails the audit instead of producing an empty
successful lookup.

Album compatibility checks derive the complete set of Artists that reference the
Album through legacy `albumIds`. A complete initial Artist/reference scan can
establish this set. Otherwise, a supplementary Mongo aggregation filters the
requested Album IDs across Artists and bounds emitted membership rows. Legacy
ObjectId values and lowercase, uppercase, or mixed-case hexadecimal strings are
normalized consistently before comparison. Only Albums whose complete membership
query fits the budget may produce `legacyProjectionMismatch`. Successfully checked
Albums retain that result even if other Album targets could not be queried.

Requested Album IDs and accepted membership rows consume the same remaining
reference budget. One additional result row is used only to detect truncation,
matching the existing embedded-reference scans. Query work is bounded by
`maxTimeMS: 10000`; the supplemental search may scan beyond the initial source
window and is not a full-catalog capacity guarantee.

### Report fields

- `catalogCreditFindings`: confirmed Credit defects. Entries contain `ownerType`
  (`album` or the compatibility name `audioTrack`), `ownerId`, `reason`, and where
  applicable `creditId` / `subjectId`. Reasons remain `invalidOrder`,
  `invalidCreditState`, `missingSubject`, `unavailableSubject`, and
  `legacyProjectionMismatch`.
- `catalogCreditUnverified`: Credit checks that could not establish completeness.
  Entries contain `ownerType`, `ownerId`, `reason`, and optional `subjectId`.
  Reasons are `subjectLookupBudgetExceeded` and
  `legacyProjectionLookupBudgetExceeded`.
- `truncated`: true when a source, reference, query-target, or output budget
  prevents a complete report. The unverified field sets this flag even if the
  report-wide findings budget prevents retaining that particular entry. Empty
  arrays with `truncated: true` must not be interpreted as a clean catalog.

Confirmed findings, unverified entries, and the other report sections all share
the existing output limit; the new field does not provide a separate unlimited
channel. Configured limits remain positive integers; zero/invalid environment
values retain the existing defaults. An exhausted *remaining* budget is handled
explicitly as unknown.

The separate `catalogDeletionFindings` field retains the deletion receipt audit:
failed or expired operations remain visible after owner removal, and legacy
deleting owners are inferred only when the receipt source scan is complete.
Credit checks do not mutate or complete deletion receipts.

### Verification

`test/catalogCreditAudit.test.ts` covers shared target budgeting, deduplication,
complete/known windows, malformed Credit state, and exhausted budgets.
`test/catalogCreditAudit.integration.ts` exercises the actual Mongo queries with
one-record windows, subjects outside the window, real missing/unavailable subjects,
mixed-case/ObjectId membership forms, subject/target/row truncation, per-Album
completeness, report-wide output limits, and read-only fixture preservation.
It also preserves orphaned failed/expired deletion receipts and prevents legacy
deletion guesses when the receipt window is incomplete.
Existing Catalog Credit and content-reference cleanup integration suites remain
required compatibility checks.
