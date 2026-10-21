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
  - [Phrase successors](#phrase-successors)
  - [Verification](#verification-3)
- [Album track order](#album-track-order)
  - [Disc Number storage](#disc-number-storage)
  - [Sort key](#sort-key)
  - [Verification](#verification-4)
- [Album expected tracklists](#album-expected-tracklists)
  - [Expected tracklist storage](#expected-tracklist-storage)
  - [Expected tracklist revision](#expected-tracklist-revision)
  - [Expected tracklist writers and privacy](#expected-tracklist-writers-and-privacy)
  - [Expected tracklist verification](#expected-tracklist-verification)
- [MusicBrainz IDs](#musicbrainz-ids)
  - [Storage and format](#storage-and-format)
  - [Writers and privacy](#writers-and-privacy)
  - [Verification](#verification-5)
- [Import publication](#import-publication)
  - [Credits and identities](#credits-and-identities)
  - [Appending to an Album](#appending-to-an-album)
  - [Verification](#verification-6)
- [Existing-Album completion](#existing-album-completion)
  - [Credits](#credits)
  - [Member Credits](#member-credits)
  - [Identities](#identities)
  - [Verification](#verification-7)
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
  provenance account, establishes Album membership in Disc Number, then Track
  Number order, and inserts the owner. `Artist.save()` / `Album.save()` retain
  their existing calling contract by delegating to those repositories.
  Read/update/delete Model APIs stay intact; this is not a migration of every
  Model to a new abstraction.
- `services/catalog/albumTrackLinkService.ts` derives every persisted
  `Album.audioTrackIds` list by Disc Number, then Track Number, then MediaTrack
  ID; see [Album track order](#album-track-order).
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

`test/catalog/catalogCreditAudit.test.ts` covers shared target budgeting,
deduplication, complete/known windows, malformed Credit state, invalid join
phrases, and exhausted budgets. `test/catalog/catalogCreditAudit.integration.ts`
exercises the actual Mongo queries with one-record windows, subjects outside the
window, real missing/unavailable subjects, mixed-case/ObjectId membership forms,
subject/target/row truncation, per-Album completeness, report-wide output
limits, and read-only fixture preservation. It also preserves orphaned
failed/expired deletion receipts and prevents legacy deletion guesses when the
receipt window is incomplete. Existing Catalog Credit and content-reference
cleanup integration suites remain required compatibility checks.

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
- Two writers store phrases explicitly. The administrator catalog `PATCH`
  replaces the whole Credit list and stores exactly the phrases it carries,
  rejecting a present but invalid one before any transaction. The Content
  Manager phrase form (`POST /content/manage/credits/update-join-phrase`) sets
  or clears one Credit's phrase and keeps the others. Every other rebuild of an
  existing list applies the [successor rule](#phrase-successors). Album
  publication, the Credit migration and new MediaTrack saves build new lists,
  whose only phrases are inherited ones (see
  [Content Manager inheritance](#content-manager-inheritance)). Import
  publication builds a new Album's lists from the reviewed Artist entries and
  stores their phrases, while an append inherits (see
  [Import publication](#import-publication)). Outcome-unknown confirmation
  compares phrases, so retrying the same intent stays idempotent.
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
   `unknown` attribution yields `Attribution not documented`. When no credited
   subject is visible the byline is empty, and listener v1 and legacy
   responses omit `displayByline` instead of sending `''`, which native
   collection-page decoders reject; see
   [Native client compatibility](listener.md#native-client-compatibility).
3. A repeated name is shown once, at its first position.
4. A name is followed by its Credit's phrase only when the next shown name
   belongs to the next Credit in the full list; otherwise `, ` joins the two
   names. The last name has no trailing phrase.
5. A byline is at most 500 UTF-16 code units, including its trailing `…`. A
   byline that fits is never shortened. A longer one ends after the last whole
   name that fits, followed by `…`. When even the first name followed by `…`
   does not fit, that name is cut at a grapheme boundary and followed by `…`,
   so a first name of exactly 500 units followed by more names keeps 499 units.

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
changes keep each phrase; other rebuilds follow
[Phrase successors](#phrase-successors).

### Phrase successors

A phrase joins its name to the next one, so a rebuild keeps a Credit's phrase
only while the same Credit still follows it. For Album Credits `A` (phrase
`feat.`), featured `X` and primary `B`, removing `X` gives `A, B`, not
`A feat. B`.

- `keepJoinPhrasesWithSuccessors` in `models/catalogCredit.ts` compares each
  rebuilt Credit's next `creditId` with its next `creditId` in the stored list
  and clears the phrase when they differ. A Credit that stays last keeps its
  phrase, and a Credit new to the list keeps the phrase it was given.
- `services/catalog/catalogCreditService.ts` applies it to additions (the
  previous last Credit loses its phrase), MediaTrack additions and their
  Album promotion, removals, reordering, primary-Album membership edits and
  Album primary-Artist removal. `mergeLegacyArtistIdsIntoCredits` applies it
  to legacy artist-ID rebuilds, which can move a label to the end.
- Artist deletion (`services/content/contentReferenceService.ts`) removes the
  Artist's Credits in an update pipeline whose first stage clears the phrase of
  every Credit whose next element is being removed. The stage filters the key
  through `$objectToArray`, because `$unsetField` needs MongoDB 5.0. Both it
  and the final renumbering stage pass non-object elements through untouched.
- Role changes keep `creditId` and order, so every phrase stays. The explicit
  replacements, the administrator `PATCH` and the Content Manager phrase form,
  store exactly the phrases they are given.
- An applied existing-Album review rebuilds the Album's or a member's list
  through `keepJoinPhrasesWithSuccessors`: every Credit keeps its stored phrase
  only while the same Credit still follows it, and an entry's own phrase
  replaces it only where the next Credit is the next entry (see
  [Existing-Album completion](#existing-album-completion)).
- The Web catalog editor mirrors the rule locally: it shows no phrase input
  for the last Credit, removing a Credit clears the phrase before it, and adding
  one clears the previous last Credit's phrase.

### Verification

`test/catalog/catalogCredit.test.ts` covers phrase validation, NFC
normalization, byte-identical JSON without a phrase and the successor rule.
`test/administration/adminCatalogCredits.test.ts` covers editable phrases,
their revisions and synchronous `PATCH` validation, and
`test/content/contentManagerCreditEditor.test.ts` covers the Content Manager
phrase forms.
`test/catalog/catalogByline.test.ts` covers selection, omission, repeated
names and the length cap, and replays its results through the native
validator ports. `test/catalog/soundtrackCreditProposal.test.ts` covers the
Content Manager upload proposal and its byline.
`test/catalog/publicCatalogService.test.ts` pins the five-field legacy
Credit and the omitted empty byline. The MongoDB suites
`test/catalog/catalogCredit.integration.ts`,
`test/listener/listenerContent.integration.ts` and
`test/listener/artistFollows.integration.ts` cover phrase writes and
successors (including Artist deletion and the Content Manager phrase form),
inheritance, lenient reads and Follow eligibility;
`test/administration/adminCatalog.integration.ts` covers administrator phrase
writes, label phrases and receipt replay after an unknown commit.

## Album track order

Product behavior is defined in [business-rules.md](../business-rules.md) under
Catalog Visibility and Administration and Album and MediaTrack Playback. This
section records how the server implements it.

### Disc Number storage

`AudioTrack.discNumber` is an optional whole number from 1 to 999, and
`discNumberSource` records where it came from. A MediaTrack without a Disc
Number stores neither key, so existing records and their administrator catalog
revisions stay unchanged.

- Content Manager single and bulk uploads and the legacy `/content/audioTrack`
  upload read `common.disk.no` through `AudioTrack.setEmbeddedDiscNumber`, which
  keeps only a value that `embeddedDiscNumber` in
  `services/audio/audioMetadataService.ts` accepts. A missing, non-integer or
  out-of-range value is ignored for that file only, and the upload continues
  without a Disc Number. The number is stored with the upload record, so a
  publication retry keeps it.
- Import publication stores each new MediaTrack's reviewed draft Disc Number
  with `discNumberSource: 'admin-import'`; an unknown one, and every track of
  a format-1 approval, stores neither key. An appended MediaTrack stores its
  reviewed Disc and Track Numbers the same way, and an append to an existing
  Album re-derives the whole order from the stored numbers of every member.
- An applied existing-Album review writes a selected Disc Number as a catalog
  edit does (`discNumberSource: 'admin-catalog'`, or neither key for a cleared
  one) and re-derives the Album order in the same transaction. Only a Track
  whose review captured its Disc Number can receive one.
- Replacing a MediaTrack's media keeps its stored Disc and Track Numbers.
- Listener v1, including Search, and legacy public responses never carry
  `discNumber`, `discNumberSource` or `trackNumber`. Clients see disc order
  only as the order of `Album.audioTrackIds`.

### Sort key

`sortTrackIdsByDiscAndTrackNumber` in
`services/catalog/albumTrackLinkService.ts` is the one comparator for every
persisted `Album.audioTrackIds` order:

1. Disc Number ascending; a missing or invalid Disc Number counts as disc 1.
2. Track Number ascending within a disc; a missing or invalid Track Number
   follows every numbered track on the same disc.
3. MediaTrack ID ascending, so duplicates and request order never change the
   result.

`orderedAlbumTrackIds` reads `discNumber` and `trackNumber` inside the
membership transaction for Album creation, membership links and replacements,
and applied existing-Album reviews. Import publication orders a new Album by
its draft Disc and Track Numbers and an append by the stored numbers it reads,
both with the same comparator, and outcome-unknown confirmation of an Album
replacement compares the stored list with that exact order. Because a missing
Disc Number counts as disc 1, an Album without Disc Numbers keeps its earlier
Track Number order; `sortTrackIdsByEmbeddedTrackNumber` remains as the
comparator's single-disc view for callers that know only Track Numbers. An
administrator Disc or Track Number edit reorders the parent Album with it in
the same transaction.

### Verification

`test/catalog/albumTrackNumberOrder.test.ts` replays the frozen pre-disc
orders and covers disc-then-track order, a missing disc as disc 1, missing
Track Numbers at the end of their disc and duplicate request IDs.
`test/audio/audioMetadataService.test.ts` bounds the tag, and
`test/audio/audioDiscNumberCapture.integration.ts` covers single, bulk and
legacy uploads, ignored tags and publication retry. The MongoDB suites
`test/catalog/albumLifecycle.integration.ts` and
`test/administration/adminImportMedia.integration.ts` cover multi-disc
membership writes, outcome-unknown confirmation, an import append and a
Draft v2 import's Disc Numbers, and `test/listener/listenerDtoShape.test.ts`
keeps both numbers out of listener and legacy public responses.
`test/administration/adminCatalogReview.integration.ts` covers an applied
review's Disc Numbers and Album order committing with its receipt.

## Album expected tracklists

An Album may keep one expected tracklist (`expectedTracklist`): the audio
tracklist of the release that an applied existing-Album review used. It is
administrator information, shown on the Web Album page, in existing-Album
reviews and in an append's summary and confirmation.
`src/services/catalog/albumExpectedTracklist.ts` validates it and derives its
rows; an existing-Album review admitted to
metadata lookup captures a private copy of its rows, applying such a review
sets or replaces it (see
[Existing-Album completion](#existing-album-completion)), and an import that
appends to the Album reads it for its Review and publish summary (see
[Appending to an Album](#appending-to-an-album)). Its product rules are under
Catalog Visibility and Administration in
[business-rules.md](../business-rules.md).

### Expected tracklist storage

The stored value is `{source, appliedAt, rows}`: `source` is `musicbrainz` or
`itunes`, `appliedAt` is a date, and each row is
`{discNumber, trackNumber, title, durationMs}`. `parseExpectedTracklistRows`
validates the rows, which are also a review's draft value (two container
levels):

- 1 to 100 rows at distinct Disc and Track Number positions; Disc Numbers
  1-999 and Track Numbers 1-9999, as in the [sort key](#sort-key).
- Titles are NFC-normalized and trimmed, required, at most 300 UTF-16 units,
  and refused when they contain a control, invisible formatting character or
  lone surrogate (the lookup automatic-text rule).
- `durationMs` is a positive whole number, or `null` when unknown. Writers
  store an unknown duration, including the iTunes 0, as `null`.
- At most 32,768 UTF-8 bytes of the normalized, sorted rows JSON.
- Rows are stored sorted by Disc then Track Number with a fixed key order, so
  parsing them again returns them unchanged; writers store only parser output.

It keeps no release, recording or iTunes ID and no MediaTrack reference, and it
has no index. An Album without one has no key. `storedExpectedTracklist` reads
a malformed stored value (a wrong source, an invalid date or refused rows) as
none and ignores unknown top-level keys.

### Expected tracklist revision

A stored value enters the admin catalog revision as raw metadata only when one
is stored, malformed values included, so Albums without one (or with `null`)
keep their revisions byte for byte and no captured review, conversion intent,
catalog cover operation or create retry goes stale. It is never an editable
field and never part of a catalog snapshot. The import candidate projection
does not read it, so import duplicate decisions and an append's reviewed target
revision are unaffected; an append's summary reads it apart from candidates.

### Expected tracklist writers and privacy

- Only an applied existing-Album review sets or replaces it
  (`src/administration/catalog/adminCatalogReviewApply.ts`): the rows its
  applied release offers, with `source` from the application (`itunes` for an
  iTunes-only candidate) and `appliedAt` the apply time, built by
  `expectedTracklistForStorage` and `$set` in the Album update of the apply
  transaction, after the placement check (`expectedTracklistPlaced` against the
  stored pairing). An explicit catalog edit clears it: `editAdminCatalogItem`
  accepts a top-level `clearExpectedTracklist: true` on an Album only, compares
  the full Album revision first, refuses with
  `409 ADMIN_CATALOG_EXPECTED_TRACKLIST_ABSENT` when nothing (or `null`) is
  stored, and otherwise `$unset`s the key, a malformed value included, in the
  same update and transaction as its receipt. A failed receipt aborts the
  clear, and nothing else needs cleanup.
- An existing-Album review stored as format 3 for metadata lookup copies the
  rows `storedExpectedTracklist` reads into its private draft
  (`album.expectedTracklist`, `null` without a valid one) and its server-only
  capture, and never writes the Album. Metadata lookup may fill that draft
  value (when it is `null`) or propose another as a conflict, only in the
  review's private draft, through a single pairing of the members with the
  applied release; only applying the review writes it to the Album (see the
  catalog review routes and Value application in
  [admin-workbench.md](../features/admin-workbench.md)).
- Import publication, appends, Credit edits and catalog edits `$set` only
  named keys. `Album.updateById` and `Album.updateCoverArtById` refuse the key
  and any dotted path under it, including their member-replacement branch,
  with `409 catalog_expected_tracklist_operation_required` before writing
  anything. The legacy and Content Manager Album routes build their updates
  from named body fields and never forward it, so they cannot set or clear it
  either.
- Deleting the Album deletes it. An existing-Album review stored as format 3
  keeps its private copies (its draft's `album.expectedTracklist` and its
  server-only capture), visible only to administrators, after the Album is
  deleted; nothing reads them back into an Album, and the review then reads as
  unavailable.
- Listener v1 and legacy public DTOs are allowlisted. The listener reads that
  load whole Album documents also exclude it: the expanded Page's placed and
  linked Albums (`getExpandedPageBySlug` in
  `src/controllers/pageController.ts`), the Library page's saved and linked
  Albums (`UserLibrary.list`) and the artist carousel's Album cursor
  (`src/models/carousel.ts`) with `withoutExpectedTracklistProjection`, and the
  followed-release Album pipeline with `withoutExpectedTracklistStage` right
  after its `$match`, which keeps the release-date index bounds.
- The administrator Tracks read (`getAdminCatalogAlbumTracks` in
  `src/administration/catalog/adminCatalogAlbumTracks.ts`) is the only response
  that carries rows; catalog snapshots, lists and receipts never do.
- Rows are matched to members by position whenever they are read
  (`expectedTrackRows`): a member's missing or invalid Disc Number counts as
  disc 1, every member at a row's position fills it whatever its lifecycle
  state or visibility, a row without one is a missing-file row, and a member at
  no row's position is outside the tracklist. `expectedTracklistPlaced` checks
  that each paired member keeps a row's position after selected number changes.
  The administrator Tracks read matches the members it lists: the declared
  member records, or for a legacy Album without declared IDs its listed ready
  linked MediaTracks, at most 500, so a linked upload that is not ready leaves
  its row without a file there.

Rollback: older releases ignore the field (explicit DTOs and `$set`-only
writers), so a tracklist an applied review stored stays, unread, after a
rollback past its writer. A release before the Album Tracks list shows it
neither returns its rows nor accepts a clear.

### Expected tracklist verification

`test/catalog/albumExpectedTracklist.test.ts` covers the bounds, size,
normalization, positions, the stored reader, derived rows and placement.
`test/administration/revisionStability.test.ts` pins the revision of an Album
with a stored tracklist and shows that one without it, its editable fields and
its import candidate revision are unchanged.
`test/listener/listenerDtoShape.test.ts` stores one on its fixture Album while
every listener v1 and legacy public key set stays frozen.
`test/catalog/albumLifecycle.integration.ts` shows that model updates naming
the key or a dotted path under it are refused and write nothing, that other
model updates (member replacement and cover updates included), the legacy Album
route and the Content Manager form keep a tracklist, that an Album without one
gains none, and that deleting the Album removes it.
`test/administration/adminCatalog.integration.ts` shows that a stored tracklist
changes the revision but no catalog item, list, PATCH or cover response, that
only the track list shows its rows, that a title PATCH and a cover change keep
it, that a PATCH naming it is invalid input that writes nothing, and that
`null` and a removed key give one revision. It also shows that a clear removes
only the key at the captured revision, leaves the members and the listener
Album unchanged and replays its receipt; that a stale, absent, invalid,
non-Album or unauthorized clear writes nothing; that two concurrent clears
commit once; and that a refused receipt keeps the tracklist.
`test/administration/adminCatalogAlbumTracks.integration.ts` shows the rows
matched to members of every state and visibility, rows without a file, members
outside the tracklist and missing records in neither list, renumbered, unlinked
and deleted members changing only which rows have a file, iTunes, malformed (an
applied instant outside years 0000-9999 included), empty, hidden, legacy and
oversized Albums, and that only administrators read rows.
`web/src/features/admin/catalogAlbumTracksApi.test.ts`,
`CatalogAlbumTracks.test.tsx` and `AdminCatalog.test.tsx` cover the strict
schema, the rows, the summary and notes, and the clear and its confirmation.
`test/administration/adminCatalogReview.integration.ts` shows that an external
tracklist change makes a review's source changed and its apply write nothing.
`test/administration/adminImportSummary.test.ts` covers an append's
`appendTracklist`: rows filled by members at their position whatever their
state, file durations and files appended by saved decisions and
preselections, forced numbering with an extra bonus file and ambiguous
durations, automatic lookup numbers replaced while file-tag numbers
constrain, the administrator's own numbers kept, no file proposed for a
position an unmoved appended file keeps, row titles, the draft size cap, and
no `appendTracklist` for an import that is no Album reuse, a target without a
tracklist or a malformed one, or a complete publication.
`test/administration/adminImportMedia.integration.ts` shows an append to an
Album with a tracklist numbered in one field save, the tracklist unchanged
after publishing, the order re-derived, the appended member filling its row
with exactly the Album's primary Credit (not the applied release track's
credit), no rows once the publication is complete, and no rows for a target
that is not ready, holds a malformed tracklist or none, or exceeds 5000
members. It also shows that member IDs are read whatever their case, padding
or stored type, that a legacy Album without declared IDs has no members, that
an undecided file follows its identity preselection, and that the numbering
save is all or nothing: a number another administrator saved refuses it, and
its lost response replays even after the approval locks the draft.
`test/listener/expectedTracklistPrivacy.integration.ts` scans listener, legacy,
Search, Page, Follow, Library and Playlist responses for anonymous callers,
listeners and an administrator in User view, shows that row titles never match
Search or add listener tracks, and profiles the four whole-document readers to
show each one excludes the field;
`test/social/musicShareLifecycle.integration.ts`,
`test/social/listeningLifecycle.integration.ts` and
`test/rooms/roomMediaDiscovery.integration.ts` scan share cards, friend
listening status, Room media (service and HTTP routes) and a Room's state.

## MusicBrainz IDs

An Artist or Organization may keep one MusicBrainz ID (`musicBrainzId`) as
private provenance for administrator imports and existing-Album reviews.
Product rules are in [business-rules.md](../business-rules.md) (Catalog
Visibility and Administration; Administrator Album Imports).

### Storage and format

The field is a lowercase 8-4-4-4-12 hex UUID of any version (real MusicBrainz
IDs include version-3 UUIDs); the nil UUID is refused, and writers accept
uppercase input and store lowercase (`src/utils/musicBrainzId.ts`). A record
without an ID has no key; clearing an ID removes the key. Placeholder identities
are never kept: every documented special purpose artist
(<https://musicbrainz.org/doc/Style/Unknown_and_untitled/Special_purpose_artist>:
Various Artists, [unknown], [anonymous], [traditional], [data], [dialogue],
[no artist], MusicBrainz Test Artist and the subsets with their own ID,
[Disney], [theatre], [church chimes] and [language instruction]) and special
purpose label
(<https://musicbrainz.org/doc/Style/Unknown_and_untitled/Special_purpose_label>:
[no label], [unknown] and MusicBrainz Test Label) forms one blocklist for both
kinds, which metadata lookup also uses to drop placeholder credits.

Two required unique partial indexes, `artist_musicbrainz_id` and
`organization_musicbrainz_id` on `{ musicBrainzId: 1 }` with the filter
`{ musicBrainzId: { $type: 'string' } }`, keep one ID per Artist and one per
Organization; an Artist and an Organization may share an ID, and deleting a
record frees its ID. Startup with existing duplicates fails closed
([runtime.md](runtime.md)).

### Writers and privacy

Only three writers set the field: an explicit existing-catalog edit
(`src/administration/catalog/adminCatalogService.ts`, which refuses an ID
another record of the kind holds in any lifecycle state with
`409 ADMIN_CATALOG_MUSICBRAINZ_ID_IN_USE`, also when the unique index refuses a
concurrent setter), import publication (below) and an applied existing-Album
review (see [Existing-Album completion](#existing-album-completion)).
`Artist.updateById` and `Artist.updateCoverArtById` drop the key silently, and
`Organization.updateById` writes only its allowlisted fields, so legacy and
Content Manager updates cannot set it. Every listener v1, legacy content,
Search, Follow, Page, Library, Playlist, social and Room projection is
allowlisted and never includes it.

The admin catalog revision counts a stored ID (malformed ones included, which
the editor shows as an empty, repairable field) only when one is stored, so
records without an ID keep their earlier revisions byte for byte. The import
candidate projection reads `musicBrainzId` too; MongoDB returns it only when it
is stored, so candidate revisions of records without one are unchanged. An
existing-Album review stored as format 3 for metadata lookup records, privately
for administrators, the ID that each Artist and Organization its captured
Credits name keeps, and never writes one. Metadata lookup may add a release's
IDs to that review's Artist entries and label, or propose other ones as
conflicts, only in the review's private draft; only applying the review records
or replaces an ID on an Artist or Organization.

### Verification

`test/catalog/musicBrainzId.test.ts`,
`test/administration/adminCatalogMusicBrainzId.test.ts` and
`test/platform/databaseIndexes.test.ts` cover the format, the placeholder
blocklist, catalog revisions and the indexes.
`test/catalog/musicBrainzId.integration.ts` shows that model updates, the legacy
Artist route and the Content Manager forms never set or clear an ID.
`test/administration/adminCatalog.integration.ts` sets, replaces and clears
IDs, keeps the revision of a record without one, refuses a same-kind duplicate
in any lifecycle state and the loser of two concurrent setters, allows one ID
across kinds, refuses non-administrators and frees an ID when its record is
deleted. `test/platform/databaseIndexes.integration.ts` shows the indexes
refuse a same-kind duplicate and admit records without an ID.
`test/listener/musicBrainzIdPrivacy.integration.ts` scans listener, legacy,
Search, Page, Follow, Library and Playlist responses for anonymous callers,
listeners and an administrator in User view;
`test/social/musicShareLifecycle.integration.ts` and
`test/rooms/roomMediaDiscovery.integration.ts` scan share cards, Room media
(service and HTTP routes) and a Room's state, for a listener and an
administrator in User view. Import cases are listed under
[Import publication](#import-publication), and applied review cases (the third
writer, and listener pages of the records it creates or records an ID on)
under [Existing-Album completion](#existing-album-completion).

## Import publication

Product behavior is defined in [business-rules.md](../business-rules.md) under
Administrator Album Imports. This section records how an approved import
writes the catalog; its routes are described in
[admin-workbench.md](../features/admin-workbench.md).

### Credits and identities

`src/administration/import/adminImportCatalogCommit.ts` writes the graph of an
approval frozen with `schemaVersion` 3 in one MongoDB transaction with the
publication receipt; format-1 and format-2 approvals keep their one-Artist
commit. The commit never resolves names or MusicBrainz IDs to identities; it
only rechecks that the preselections the approval froze still hold, and writes
the MusicBrainz IDs it froze (see [MusicBrainz IDs](#musicbrainz-ids)).

- The approval freezes one identity for each Artist entry and the label: the
  reviewed record to reuse, bound to its revision, or an ID reserved for a new
  record, whether an administrator chose it or the import preselected it
  (`preselected: true` on its frozen decision). Retries and resumes reuse those
  IDs, so they never mint another record, and two entries never share one
  Artist.
- A new Album's Credits follow the draft: each Artist entry in order as a
  `primary` or `featured` Artist Credit with its join phrase and the
  `creditId` `import_<role>_<artistId>`, then the label as an Organization
  Credit with role `label` and the `creditId` `import_label_<organizationId>`.
  An empty label adds no Credit. A single primary entry without a label writes
  the same Album Credits as a format-2 approval.
- Each new MediaTrack of a new Album receives the Album's primary Credits in
  order, with the same `creditId`s; featured entries and the label stay on the
  Album. As in [Content Manager inheritance](#content-manager-inheritance), a
  primary Credit keeps its join phrase only while the next Album Credit is
  also a primary, so a phrase that led into a featured Artist or the label is
  not stored on the MediaTrack (a format-2 approval still copies its single
  Credit's phrase). The MediaTrack's legacy `artistIds` come from
  `legacyTrackArtistIdsFromCredits`.
- A new Artist or label Organization takes the draft's visibility and gets its
  catalog search projection; a new Organization has `organizationType`
  `label` and an empty description. The helpers that build them
  (`src/administration/catalog/adminNewCatalogRecords.ts`) also build the
  records an applied existing-Album review creates. A reused Artist or
  Organization is fenced
  with `touchReadyArtistReferences` or `touchReadyOrganizationReferences` and
  keeps its type, metadata, artwork and visibility; it gains only a MusicBrainz
  ID the approval froze for it. A new record stores its frozen ID, if any.
- Only primary Artists, new or reused, gain the Album in their legacy
  `albumIds`. Discography, Collaborations and Organization Releases derive
  from the Credits as for any Album.
- New MediaTracks of a new Album are stored public, and the Album's own
  visibility hides them while it is hidden.
- The worker checks that every reused Artist, Organization and Track, and an
  append's target Album, is still ready before its first copy; a reused Track
  must also still belong to the target Album with ready, published storage. The
  commit reads each of them again before its first write, at its reviewed
  revision where one was reviewed, and fences it. A record that is no longer
  ready or has changed turns the publication into needs attention
  (`catalogConflict`) without minting identities.
- An approval freezes, with each identity of a new Album, the MusicBrainz ID it
  records or replaces (`musicBrainzIdWrite`: `{ musicBrainzId, replaces }` or
  null; `src/administration/import/adminImportMusicBrainzIds.ts`): a new Artist
  or label Organization keeps its entry's ID unless a ready record of its kind
  holds it; a reused record without an ID records it while no other record holds
  it; a reused record holding another ID keeps it unless the administrator chose
  `replace`. Two Artists recording one ID need review again. The commit
  inserts new records with their ID and sets a reused record's ID only while it
  still holds what the review saw (none, which includes a stored value that is
  no keepable ID, such as a placeholder's, or the ID it replaces; its revision
  check already proved it unchanged). An append and formats 1 and 2 write no
  ID. A duplicate key on a MusicBrainz ID index (another publication, an
  existing-catalog edit, or a holder that was not ready at review) aborts the
  transaction and becomes needs attention (`identityConflict`), minting nothing.
- An approval freezes the identities the review preselected (a new record where
  no name, alias or same-ID candidate exists, the ready record holding an
  entry's MusicBrainz ID, or an append member with identical bytes) marked
  `preselected`, and only when they are the ones its confirmation showed. The
  worker recomputes them before its first copy and inside the commit
  transaction, which every format-3 import commit serializes on one fence
  document (format-1 and format-2 commits are not fenced); a preselection that
  no longer holds, because a candidate appeared meanwhile, turns the
  publication into needs attention (`identityConflict`) without minting
  identities, and its copies stay recorded for cleanup. An existing-Album
  review apply that resolves identities serializes on the same fence document
  (see [Existing-Album completion](#existing-album-completion)). The fence
  serializes only these writers: a record another editor creates concurrently
  with them is not rechecked, but the unique indexes still refuse a second
  record of the kind with one MusicBrainz ID.

### Appending to an Album

An append writes no Album value or Credit, creates no Artist or Organization
and adds the Album to no Artist's `albumIds`. Its target Album must hold a
primary Artist Credit whose Artists are ready; the commit reads it at its
reviewed revision and fences it with `touchReadyAlbumReferences`. Appended
MediaTracks inherit that Album's ordered primary Credits through
`inheritedAlbumPrimaryCredits`, as in
[Content Manager inheritance](#content-manager-inheritance), so a phrase is
kept only before another inherited Credit. They take the Album's release date,
reduced to a simple date of valid integer parts, and are stored public, so the
Album's own visibility hides them while it is hidden, as for a new Album's
MediaTracks, and reveals them with its other MediaTracks once it is public.
They store their reviewed Disc and Track Numbers, and join its order by Disc
Number, Track Number and MediaTrack ID ([Sort key](#sort-key)). A selected cover
is not copied, and no MusicBrainz ID is recorded.

An append never writes the target Album's
[expected tracklist](#album-expected-tracklists), and the commit is the same
with or without one: rows are matched to members by position when read
(`expectedTrackRows`), so the new MediaTracks fill the missing-file rows at
their Disc and Track Numbers. They still take the Album's primary Credits,
never a release track's credit, which the tracklist does not store. The import's
Review and publish summary reads the target's stored tracklist
(`storedExpectedTracklist`, a malformed value reading as none) and the Disc and
Track Numbers of its members in the same read to show the rows, and computes
the numbering proposal with `lookupForcedPairs` from
`src/administration/lookup/lookupSubset.ts`; nothing it shows is frozen by the
approval, and numbering is an ordinary draft field save.

### Verification

`test/administration/adminImportCatalogCommit.test.ts` covers the Credit
builders: draft order, roles and phrases, primary-only MediaTrack Credits, the
format-2 equivalence, append inheritance and mismatched frozen Artists.
`test/administration/adminImportCatalogCommit.integration.ts` publishes two
primary Artists, a featured Artist and a new label and checks Credit order,
roles and phrases, primary-only `albumIds`, MediaTrack Credits, Organization
Releases, Discography, Collaborations, Follow eligibility, the frozen listener
fixture, hidden imports and untouched reused records. It also covers decision
binding, appends, a target without a primary Credit, same-intent retries, a
crash between copy and commit, unknown copies, permission loss, cancellation
with independent identities and reused records that change. It also covers
identity preselection: an import with no candidates, a name candidate created
after review (a fresh review at approval) or after approval, before or after the
copy (needs attention with `identityConflict`, minting nothing and keeping the
copy until cancellation and cleanup, then a new approval), same-intent retries,
resumes, two approvals that preselect one new Artist, a malformed same-name
record that holds its row, and a recheck over its time budget.
`test/administration/adminImportIdentity.test.ts` covers the preselection
matrix, exact-ID and alias candidates, locale-independent names, the
shown-preselection comparison and which approvals the worker rechecks.
`test/administration/adminImportMusicBrainzIds.test.ts` covers the ID write
matrix, the shown-write comparison and the found names.
`test/administration/adminImportCatalogCommit.integration.ts` also records the
entries' IDs on new records and the label, preselects and credits the record
holding an entry's ID (a create despite it, or another reuse, records none),
keeps or replaces another ID (replace refused while another record holds the
new one), lets one of two publications recording one ID commit while the
other needs attention with `identityConflict` and mints nothing, records none
for an append, makes a reused record changed after approval a catalog
conflict that records none, surfaces a holder that was not ready at review as
`identityConflict`, rechecks alias candidates from the names the approval
froze, replaces a placeholder's ID stored on a reused record, and refuses an
approval in which two entries would record one ID.
`test/administration/adminImportMedia.integration.ts` covers append
preselections and their recheck, approvals bound to the preselections they
showed, byte matches read apart from title matches, a byte match on another
Album that needs no answer, append visibility and the sixteen-approval bound
with a new import of the same files, an append to an Album with an expected
tracklist (its new members fill missing-file rows, the tracklist is unchanged,
the order is re-derived and the appended MediaTracks take the Album's primary
Credits), and
`web/src/api/listenerContractCompatibility.test.ts` parses
`contracts/listener/v1/fixtures/album-multi-artist-label.json`.

## Existing-Album completion

Product behavior is defined in [business-rules.md](../business-rules.md) under
Catalog Visibility and Administration. This section records how an applied
existing-Album review writes Credits, identities and the expected tracklist;
its routes are described in
[admin-workbench.md](../features/admin-workbench.md).

### Credits

`src/administration/catalog/adminCatalogReviewCredits.ts` rebuilds an owner's
Credits from the list the review captured (`capturedCatalogCredits`, which must
still equal the stored list as the canonical Credit lifecycle reads it), and
`replaceCatalogCreditsWithinTransaction` writes it with documented attribution
in the apply transaction, which also keeps `Artist.albumIds` in step with the
Album's primary Credits.

- Selected entries take the positions of the Credits they replace in entry
  order; extra entries follow the last of them, and they lead a list that had
  none. The Album's entries replace its primary and featured Artist Credits; a
  member's replace those and its legacy unspecified Credits of the Artists its
  entries name. Every other Credit keeps its subject, role and relative order,
  and orders are renumbered by position.
- A label replaces the subject of the first label Credit (a new Credit keeping
  that Credit's join phrase) or follows the last Artist Credit when the Album
  has none; a label already naming that Organization changes nothing.
- Join phrases follow `keepJoinPhrasesWithSuccessors`: an entry Credit that
  keeps a captured Credit ID starts from that Credit's phrase, which stays while
  its successor is unchanged; an entry's own phrase is stored only before the
  next entry.
- An entry showing a captured Credit keeps that Credit's ID and Artist; every
  other new Credit ID is `review_` plus 40 hex digits of a digest of the
  review, the apply's operation, the owner and the entry (`label` for the
  label), so a retried transaction writes the same Credits.
- A list that differs only in MusicBrainz IDs writes no Credit. More than 50
  Credits, or one Artist in one role twice, refuse the apply before any write.

### Member Credits

A member's entries come only from the artist credit of its own paired release
track (value application); the apply writes them only for members the request
lists, each a whole list. Album Credits are never copied to members:
`inheritedAlbumPrimaryCredits`, which appends use, is never called, a member
whose track has no usable credit keeps its Credits, and a member Credit never
promotes its Artist to the Album.

### Identities

`src/administration/catalog/adminCatalogReviewIdentity.ts` groups the entries
of the Album and every member into identities (by MusicBrainz ID, else by name
compared case-insensitively) and binds an entry to a captured record (an Album
entry by the captured Credit showing it; a member entry to one of that member's
captured Artists by Credit, kept ID, or name or found name). Unbound identities
and a new label are resolved through `importIdentityCandidates` and
`importIdentityPreselections` on a synthetic Draft v2 holding one entry per
identity, with every bound record an explicit reuse so no other identity is
preselected onto it. The apply recomputes candidates, preselections and ID
holders inside its transaction and refuses a confirmation that showed others.

- New Artists (`newArtistRecord`) and label Organizations
  (`newLabelOrganizationRecord`,
  `src/administration/catalog/adminNewCatalogRecords.ts`, shared with import
  publication) take the Album's visibility; their IDs derive from the review,
  the operation and the identity key, so an identity shared by the Album and
  members creates one record, once across retries.
- MusicBrainz IDs follow `musicBrainzIdWriteFor`: inserted with a new record, or
  set on a reused one only while it still holds what was reviewed. A
  conflicting identity records none, and neither do two colliding writes (two
  IDs on one record, or one ID on two records) that no decision made (no answer
  could change them). Identities are resolved over the default selection and
  then narrowed, so an apply deselecting a list computes the confirmation's
  items narrowed by identity and never records an ID the confirmation dropped.
  The unique index refusing an insert or set aborts the apply with
  `409 ADMIN_CATALOG_REVIEW_IDENTITY_CHANGED`.
- Every identity refusal an apply makes shows on a row needing an answer in
  `GET /catalog-reviews/:id/candidates`: an unanswered row, a decided replace
  another record's ID now blocks, a decided write colliding with another, an
  Artist repeated within one list, and a decided target that changed. A list
  two of whose entries name one Artist whatever is decided is never
  applicable, so no such refusal lacks a row. The decisions route refuses a set
  that would collide or replace into a held ID. An apply binds the
  `valueRevision` its confirmation read, since lookup applications change
  values, and a review's found and localized names, without changing
  `revision`.
- An apply that resolves identities writes the identity fence
  (`serializeImportIdentityCommits`), so it serializes with format-3 import
  commits and other review applies.
- The review is stale when any record its captured Credits name changed
  (`readCatalogReviewSource`), so an entry bound to a captured record always
  writes that record as reviewed.

### Verification

`test/administration/adminCatalogReviewCredits.test.ts` covers positions,
phrases, Credit IDs, the label, member legacy Credits and the Credit rules.
`test/administration/adminCatalogReviewIdentity.test.ts` covers grouping,
binding, conflicting identities, the default selection, decisions and shown
lists, preselections, the ID write matrix, colliding and invalid writes and
the rows they mark, created records and Credit views.
`test/administration/adminCatalogReviewApply.integration.ts` covers the routes
and their limits, creates and reuses with IDs, name and alias candidates that
need a decision, a candidate or ID holder that appears after the confirmation
read, stale captured or decided records, positions and phrases among other
roles, the label replaced or read-only, a name repeated in another letter
case, placement of paired members, member Credits from their own tracks (never
the Album's), an empty Album's all-missing tracklist, listener pages without
MusicBrainz IDs (Discography, Collaborations, Organization releases and
followed releases included), a late failure and Credit writes turned off
writing nothing, a run completing after the confirmation read, an apply racing
another identity writer on the fence, the receipt kept for applying, and
same-intent retries minting nothing twice.
