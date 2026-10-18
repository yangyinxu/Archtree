# Catalog architecture

Product behavior remains defined in [business-rules.md](../business-rules.md).

<!-- @catalog -->
**Contents**

- [Catalog application and presentation boundaries](#catalog-application-and-presentation-boundaries)
  - [Responsibility map](#responsibility-map)
  - [Lifecycle responsibilities preserved](#lifecycle-responsibilities-preserved)
  - [Verification](#verification)
- [Catalog deletion recovery](#catalog-deletion-recovery)
  - [Deletion stages](#deletion-stages)
  - [Interruption and retry](#interruption-and-retry)
  - [Verification](#verification-1)
- [Bounded Catalog reference audits](#bounded-catalog-reference-audits)
  - [Credit evidence and completeness](#credit-evidence-and-completeness)
  - [Report fields](#report-fields)
  - [Verification](#verification-2)
- [Credit join phrases and bylines](#credit-join-phrases-and-bylines)
  - [Join phrase storage](#join-phrase-storage)
  - [Byline composition](#byline-composition)
  - [Content Manager inheritance](#content-manager-inheritance)
  - [Phrase successors before phrase writes](#phrase-successors-before-phrase-writes)
  - [Verification](#verification-3)
<!-- @end-catalog -->

## Catalog application and presentation boundaries

The canonical product contract remains [business-rules.md](../business-rules.md).
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
- `models/catalogCredit.ts` owns Credit and join-phrase validation, and
  `services/catalog/catalogByline.ts` is the only byline composer. Listener v1,
  legacy public catalog and Library projections resolve subject names and call
  it; see [Credit join phrases and bylines](#credit-join-phrases-and-bylines).
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

`test/catalog/catalogCreatePublication.test.ts` exercises artwork attachment, definite
failure compensation, cleanup failure, unknown commit handling, and both JSON
and form response adapters. Catalog boundary checks ensure services cannot
depend on HTTP Controllers and the Content Manager view cannot perform database
work. The stylesheet regression preserves the existing CSS cascade. Existing
Content Manager inventory/client and administrator authorization
tests continue to check the rendered controls and route behavior. Artist/Album
lifecycle, guided-release, Credit, and relationship integration tests remain the
regression gates for transaction and retry semantics.

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
test/catalog/catalogDeletionRecovery.integration.ts` with the configured local MongoDB
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
  applicable `creditId` / `subjectId`. Reasons are `invalidOrder`,
  `invalidCreditState`, `missingSubject`, `unavailableSubject`,
  `legacyProjectionMismatch`, and `invalidJoinPhrase`. An `invalidJoinPhrase`
  entry names the `creditId` whose stored join phrase fails write validation;
  reads present that phrase as `, `, so it never makes the Credit list
  `invalidCreditState`.
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

`test/catalog/catalogCreditAudit.test.ts` covers shared target budgeting, deduplication,
complete/known windows, malformed Credit state, invalid join phrases, and
exhausted budgets.
`test/catalog/catalogCreditAudit.integration.ts` exercises the actual Mongo queries with
one-record windows, subjects outside the window, real missing/unavailable subjects,
mixed-case/ObjectId membership forms, subject/target/row truncation, per-Album
completeness, report-wide output limits, and read-only fixture preservation.
It also preserves orphaned failed/expired deletion receipts and prevents legacy
deletion guesses when the receipt window is incomplete.
Existing Catalog Credit and content-reference cleanup integration suites remain
required compatibility checks.

## Credit join phrases and bylines

Product behavior is defined in [business-rules.md](../business-rules.md) under
Catalog Visibility and Administration and Album and MediaTrack Playback. This
section records how the server implements it.

### Join phrase storage

`CatalogCredit.joinPhrase` is optional. A Credit without a phrase stores no
key, so canonical JSON and the revisions of existing records stay
byte-for-byte unchanged.

- A valid phrase is NFC-normalized, has at least one visible character and at
  most 16 UTF-16 code units, and contains no Cc, Cf, Zl, Zp, private-use or
  unassigned character, no blank-rendering character such as a Hangul filler
  or the braille blank, and no unpaired surrogate. It does not begin with a
  combining mark, variation selector, emoji modifier, regional indicator or
  Hangul medial or final jamo, and does not end with a regional indicator or
  Hangul initial jamo, because those would fuse with the neighboring name into
  one grapheme. Surrounding spaces are kept, so `、`, `&` and `feat.` are
  valid with or without spaces on either side.
- Stored Credits are read leniently. Public and listener reads, Artist page
  classification, the reference audit, the Credit service's reads before a
  rebuild and outcome-unknown confirmation treat an invalid phrase as absent
  and keep the Credit, so the byline shows `, ` in its place and the Credit
  list stays visible. The audit also reports it as `invalidJoinPhrase`.
- Administrator catalog requests still reject `joinPhrase`, and Content
  Manager requests cannot set one, so no stored Credit gains one yet. Every
  rebuild of an existing Credit list (Credit service additions, removal and
  reordering, Content Manager role changes, legacy artist-ID edits and
  administrator Credit edits) keeps each valid phrase with its `creditId`; a
  full replacement stores the phrases its caller supplies. Album publication,
  the Credit migration and new MediaTrack saves build new lists, whose only
  phrases are inherited ones (see
  [Content Manager inheritance](#content-manager-inheritance)). Outcome-unknown
  confirmation compares phrases, so retrying the same intent stays idempotent.
- Listener v1 and legacy public Credits carry neither `joinPhrase` nor
  `creditId`; see
  [Native client compatibility](listener.md#native-client-compatibility).

### Byline composition

`src/services/catalog/catalogByline.ts` builds every server byline: listener
v1 summaries, legacy public projections and Library creators. Library creators
composed from legacy Artist names, for unmigrated owners or while
`CATALOG_CREDIT_READS_ENABLED=false`, keep their earlier comma-joined
presentation, including a repeated name, and apply the same length cap.

1. Credits are taken in Credit order. A Credit whose subject is missing, not
   ready or hidden is omitted but keeps its position.
2. The byline names the primary, featured and performer Credits; without any,
   the Organization Credits; otherwise every remaining Credit. Explicit
   `unknown` attribution yields `Attribution not documented`.
3. A repeated name is shown once, at its first position.
4. A name is followed by its Credit's phrase only when the next shown name
   belongs to the next Credit in the full list; otherwise `, ` joins the two
   names. The last name has no trailing phrase.
5. A byline is at most 500 UTF-16 code units, including its trailing `…`. A
   byline that fits is never shortened. A longer one ends after the last whole
   name that fits, followed by `…`. When even the first name followed by `…`
   does not fit, that name is cut at a grapheme boundary and followed by `…`,
   so a first name of exactly 500 units followed by more names keeps 499
  units.

The legacy byline and the listener byline of the same owner are identical.
Plain-name fields such as `artistNames`, Search projections, Artist page
sections, Organization Releases and Follow eligibility ignore phrases.

### Content Manager inheritance

A MediaTrack that inherits the Album's primary Artist Credits copies them in
Album order. An inherited Credit keeps its join phrase only when the Album
Credit right after it is inherited too; otherwise the phrase is cleared,
because it was written before a name the MediaTrack does not carry. For Album
Credits `A` (phrase `feat.`), featured `X` and primary `B`, the MediaTrack
therefore reads `A, B`, and a performer selected during the upload cannot
render as `A feat. C`. The last inherited Credit never keeps a phrase. Role
changes and reordering in the Content Manager Credit editor keep each phrase
with its Credit.

### Phrase successors before phrase writes

A stored phrase stays with its `creditId`, not with the name it was written
before. No write path stores a phrase yet, so the cases below are latent, but
each can make a phrase introduce a different name and must be settled before
join-phrase writes ship:

- A legacy artist-ID edit rebuilds the list as retained Artists, added
  Artists, then Organizations, so resubmitting the same Artists can move a
  label from between two Artists to the end, and the phrase that introduced
  the label then introduces the second Artist.
- Removing a Credit, directly or by deleting its Artist, leaves the previous
  Credit's phrase before the next remaining Credit. For Album Credits `A`
  (phrase `feat.`), featured `X` and primary `B`, removing `X` gives
  `A feat. B`.
- An addition, an Album promotion or a primary-Artist addition appends after
  the last Credit, whose unused phrase then applies to the new name.

### Verification

`test/catalog/catalogCredit.test.ts` covers phrase validation, NFC
normalization and byte-identical JSON without a phrase.
`test/catalog/catalogByline.test.ts` covers selection, omission, repeated
names and the length cap, and replays its results through the native
validator ports. `test/catalog/soundtrackCreditProposal.test.ts` covers the
Content Manager upload proposal and its byline.
`test/catalog/publicCatalogService.test.ts` pins the five-field legacy
Credit. The MongoDB suites `test/catalog/catalogCredit.integration.ts`,
`test/listener/listenerContent.integration.ts` and
`test/listener/artistFollows.integration.ts` cover phrase preservation,
inheritance, lenient reads and Follow eligibility.
