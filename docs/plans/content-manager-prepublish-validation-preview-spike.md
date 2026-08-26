# Content Manager Pre-Publish Validation and Preview Plan

Spike status: **Complete**

Implementation status: **Not started**

## Decision summary

The smallest safe first slice is an administrator-only, read-only validation
report and contract preview for one proposed Page Layout mutation. The request
describes one ephemeral attach, detach, reorder, or title-change intent against
`home` or `library`; the server applies it in memory, validates the resulting
Page → Carousel/Grid/List → content graph, and renders the same allowlisted
ready-content projection used by public expanded pages. It does not persist the
candidate, upload files, change public state, or claim that a later save is
atomic with the preview.

This slice should precede server-side drafts. It exercises the validation,
projection, authorization, evidence, storage-verification, and observability
contracts without inventing a second source of truth. A later phase may add
immutable server revisions and bounded MongoDB-atomic publication only after
the shared rules are approved in `docs/business-rules.md`.

## Scope and non-goals

This plan covers:

- the current Content Manager, guided Artist release, Page/Carousel/Grid/List,
  catalog readiness, upload, S3 ownership, transaction, reconciliation,
  authorization, account, and provenance boundaries;
- an implementation-ready first slice for Page Layout validation and preview;
- the lifecycle and data-contract requirements for later immutable drafts,
  atomic database publication, retry, and rollback;
- unit, integration, browser E2E, rollout, rollback, and operational evidence.

The first slice does **not**:

- create a server-side draft, changeset, approval workflow, publish scheduler,
  public preview URL, or shareable preview token;
- accept multipart bytes, validate selected local file contents, or reserve S3
  objects;
- make a batch of existing Content Manager mutations atomic;
- change public Listener DTOs, Finitude behavior, catalog readiness rules, or
  any existing create/update/delete endpoint;
- treat a successful preview as a write authorization or publication lock.

## Current-state evidence

| Area | Current boundary | Primary implementation evidence |
| --- | --- | --- |
| Content Manager authorization | The complete `/content/manage` surface authenticates and requires the current database-backed `admin` role before parsing or uploads; controllers also reject non-admin mutation calls. | `src/app.ts`, `src/routes/content/contentManagerRoutes.ts`, `src/middleware/authMiddleware.ts`, `test/adminContentRouteGuards.test.ts`, `test/adminContentApplicationGuards.test.ts` |
| Manager state | Inventory is global, bounded, and audit-oriented. Most forms write immediately. | `src/controllers/contentController.ts`, `src/controllers/pageController.ts`, `src/views/contentManager/pageItemsView.ts`, `test/contentManagerInventory.test.ts` |
| Browser recovery | `archtree.artistReleaseDraft` is best-effort per-tab `sessionStorage`; it excludes files and the idempotency token, is cleared after completion, and is not authoritative. Bulk results also use `sessionStorage` only to survive navigation. | `src/public/content-manager.js`, `test/contentManagerClient.test.ts` |
| Guided release | A retained `contentWorkflowOperations` record holds immutable intent, step status, created IDs, a lease, attempt count, and bounded errors. It resumes incomplete work; it is a publication saga/recovery log, not an editable draft. | `src/services/artistReleaseWorkflowService.ts`, `src/views/contentManager/releaseOperationsView.ts`, `test/artistReleaseWorkflow.integration.ts` |
| Pages | `home` and `library` are live documents. A Page write is visible after commit. Attach/reorder operations use MongoDB transactions and touch exact targets to race safely with deletion. | `src/models/page.ts`, `src/services/pageReferenceLifecycleService.ts`, `test/pageReferenceLifecycle.integration.ts` |
| Carousels | Manual, Artist, and personalized definitions are stored live. Manual references are fenced to existing ready catalog items; dynamic modes resolve at read time. | `src/models/carousel.ts`, `src/controllers/pageController.ts` |
| Grid/List | A `contentCollections` row has a fixed `grid` or `list` presentation and `manual` or `dynamic` mode. Manual references are ready-fenced; dynamic device-local sources remain unresolved by the server. | `src/models/contentCollection.ts`, `src/controllers/contentCollectionController.ts` |
| Public composition | Public DTOs explicitly allowlist Page, Carousel, Grid/List, Album, ready MediaTrack, and Post fields. Invalid, dangling, or non-ready items are omitted and order is normalized. | `src/services/publicPageService.ts`, `src/services/publicCatalogService.ts`, `test/publicPageService.test.ts` |
| Native contract | iOS decodes the expanded Page DTO and its three item types. Native dynamic download sources remain client-resolved. Preview must preserve that DTO contract rather than add preview-only fields to public responses. | `Finitude_iOS/Finitude_iOS/Networking/Data/Page.swift`, `Finitude_iOS/docs/api.md` |
| Catalog create | New Artist/Album artwork is ready in S3 and has an `imageAssets` record before the ready owner is inserted. A definite insert failure removes the uploaded image; uncertainty preserves evidence. | `src/controllers/artistController.ts`, `src/controllers/albumController.ts`, `src/services/imageStorageService.ts`, `test/catalogCreatePublication.integration.ts` |
| MediaTrack publication | A MediaTrack begins with storage and publication pending. Storage may become ready first; publication and canonical Album membership commit in one MongoDB transaction. Public reads require ready publication and an identity-bound active key. | `src/models/audioTrack.ts`, `src/services/audioStorageService.ts`, `src/services/albumTrackLinkService.ts`, `src/services/audioPublicationRecoveryService.ts` |
| Replacement | A replacement object is recorded and uploaded before a compare-and-set attachment. The old object remains active until attachment; cleanup failure remains explicit and retryable. | `src/services/audioStorageService.ts`, `src/services/imageStorageService.ts`, `test/audioStorageService.test.ts`, `test/imageLifecycleService.test.ts` |
| Deletion | Artist, Album, MediaTrack, Carousel, and Grid/List deletion fence new references and retain metadata/evidence until required storage/reference cleanup is safe. | `src/services/artistLifecycleService.ts`, `src/services/albumLifecycleService.ts`, `src/services/audioStorageService.ts`, `src/services/pageReferenceLifecycleService.ts` |
| Reconciliation | Audio/video, image, and content-reference reports are bounded, administrator-only, and read-only. Remediation is a separate exact, revalidated action. | `src/services/audioReconciliationService.ts`, `src/services/imageReconciliationService.ts`, `src/services/contentReferenceReconciliationService.ts`, `src/routes/adminRoutes.ts` |
| Account/provenance | `createdBy` is provenance, not authorization. Shared writes touch the active account in the same transaction; account deletion cannot remove the only creator evidence for live shared catalog records. | `src/services/accountReferenceFenceService.ts`, `docs/business-rules.md` |

## Current lifecycle map

| Lifecycle | Current behavior and boundary | Consequence for the proposal |
| --- | --- | --- |
| Create | Artist/Album can publish immediately after optional artwork is ready. MediaTracks persist pending evidence before S3 upload and become public only after publication. Page/Carousel/Grid/List writes are immediately live after commit. | Validation must model entity-specific readiness; it cannot assume every Content Manager form has a draft phase. |
| Replace | Image/media replacement is S3-first, database-attach second, old-object cleanup last, with compare-and-set ownership fences. Metadata and composition edits generally update live rows directly. | A draft cannot own an untracked uploaded object or delete the old object before the publication commit. |
| Preview | No administrator contract preview exists. Public endpoints can only render committed state. | Preview must use a separate admin route and an ephemeral candidate; never add `preview=true` to public routes. |
| Validate | Controllers validate individual shapes/references and reconciliation audits persisted discrepancies. There is no reusable whole-Page preflight report. | Extract pure validators that can be called by preview now and by future publish later. |
| Publish | MongoDB transactions cover bounded related database writes. S3 is outside MongoDB. Guided release intentionally publishes steps independently and retains completed work when optional steps fail. | “Atomic” may mean atomic public MongoDB projection after assets are ready, never atomic MongoDB + S3. Existing guided release semantics must not be relabeled atomic. |
| Partial failure | Upload, finalization, cleanup, and guided-release failures preserve statuses, exact keys/IDs, and bounded errors. Batch upload isolates outcomes. | Reports must distinguish blocked, warning, unknown, and omitted content without asking operators to repeat successful uploads. |
| Retry | Guided release resumes retained intent; MediaTrack publication retries the database transaction without re-uploading; deletion and cleanup use exact recorded identity. | Retry must use the original immutable intent/revision and exact lifecycle records, not resubmitted mutable form data. |
| Rollback | There is no catalog revision rollback. Existing recovery is retry or forward compensation; successful guided-release content is not automatically deleted. | The first slice offers no rollback. Later rollback must be a newly validated forward changeset and cannot promise restored S3 bytes that were deleted. |
| Reconciliation | Reports find storage, lifecycle, relationship, Credit, Page-presentation, and workflow discrepancies; audits never auto-delete unknown data. | The validator should reuse finding concepts, while exact remediation remains in existing audits. |
| Concurrency | Reference touches, lifecycle states, leases, and compare-and-set filters fence many races. There is no uniform revision on every shared entity and Page writes currently do not accept a preview token. | Preview is advisory. Future publish requires a uniform observed-revision set and transaction-time compare-and-set checks. |
| Account | Each provenance-bearing write requires an existing account. `admin` authorizes global mutation; `createdBy` does not confer ownership. | Preview authorization is request-time admin only. A future draft whose author disappears must be adopted by another admin or remain unpublishable. |
| Provenance | Existing rows retain their creator while update fields identify the editor on some composition models. Guided operations retain `adminUserId`. | Publishing a draft must not rewrite existing `createdBy`; new rows use the approved draft author/adopter and retain publication-operation evidence. |

## Three distinct recovery concepts

Browser form recovery, operation recovery evidence, and a future immutable
server revision must remain distinct in UI, code, and documentation:

| Property | Browser form recovery | Guided operation recovery | Immutable server revision |
| --- | --- | --- | --- |
| Storage | One tab's `sessionStorage` | `contentWorkflowOperations` | Future changeset/revision collections |
| Authority | None; progressive enhancement | Authoritative evidence for an already-started publication saga | Authoritative unpublished intent |
| Editability | Local fields are overwritten in place | Retained intent is not edited during retry | Editing appends a new immutable revision |
| Files | File inputs are deliberately not restored | Successful uploaded assets/created IDs are retained; missing local files may need reselection | Every staged object has an exact lifecycle record and reserved owner |
| Concurrency | Last browser value wins locally | Idempotency token, intent hash, lease, and attempt count | Base revisions, immutable hash, publish lease, transaction compare-and-set |
| Retry | Resubmit current form | Resume first incomplete step without duplicating completed work | Retry the exact validated revision/operation ID |
| Public effect | None until the normal form posts | Earlier completed steps may already be public | None until explicit publication commits |

The existing browser key may keep user-facing “draft” wording only if help text
says **Saved in this tab, not published or stored on the server**. Code and
contracts should call it `formRecovery`.

## First implementation slice: ephemeral Page Layout preflight

### Supported intent

Add one administrator-only endpoint:

`POST /content/manage/prepublish/page/validate`

The request is JSON or URL-encoded form data, never multipart, and is limited
to 64 KiB before parsing. It contains exactly:

```text
schemaVersion: 1
subject.kind: "pageLayout"
subject.slug: "home" | "library"
operation:
  { type: "setTitle", title }
  | { type: "attachCarousel", carouselId, position? }
  | { type: "detachCarousel", carouselId }
  | { type: "reorderSection", fromIndex, toIndex }
storageVerification: "exactReferences"
```

These four intents map exactly to the existing Web Page save, Carousel attach,
Carousel detach, and Page reorder actions. Carousel IDs are canonical
24-character ObjectIds; positions and indexes are bounded by the current
100-Page-item limit. Existing Grid/List references remain in the resulting
graph and are fully validated/previewed, but the first slice does not add a new
Grid/List placement form. Unknown fields, arrays where scalars are required,
conflicting fields, and multiple operations are rejected. The server loads the
current Page and applies only this allowlisted operation in memory. It does not
accept a client-supplied Page document or nested definitions.

The route returns JSON when requested by the Content Manager client and escaped
HTML for the no-JavaScript `formtarget="_blank"` fallback. The HTML is a
contract preview, not a pixel-perfect Web/iOS simulator. It must be keyboard
operable, announce status/findings, preserve section order, label omissions,
and never render untrusted text as HTML.

### Validation algorithm

1. Recheck authenticated `admin` context in the controller even though the
   router is guarded before body parsing.
2. Parse and normalize the allowlisted intent; load the Page and apply the one
   operation in memory without calling model mutation methods.
3. Enforce Page item count and presentation discriminators.
4. Load every exact Carousel/ContentCollection in bounded queries. Validate
   existence, Page item/presentation match, supported mode/config, limits, and
   contiguous projected order.
5. Resolve dynamic Artist Carousels with ready Artist/Credit rules. Resolve
   personalized Home content as signed-out (empty) with an informational
   finding. Leave device-local Download Grid/List sources unresolved with an
   informational placeholder.
6. Load exact manual Album, MediaTrack, and Post references. Validate lifecycle,
   Credits/attribution, relationship shape, and identity-bound ready media key.
   Missing artwork is a warning because clients have a placeholder;
   unavailable media is an error and is omitted from preview.
7. `HEAD` only exact referenced ready media/artwork keys with bounded
   concurrency and a short timeout. Missing or owner/key-mismatched media is an
   error. Missing artwork remains a warning. An unavailable storage check makes
   the report `blocked` but never invokes remediation.
8. Project through `toPublicExpandedPage`, `projectPublicAlbums`,
   `projectPublicAudioTracks`, and `toPublicFeedPost` so preview and public
   allowlists cannot drift.
9. Compute canonical candidate and observed-snapshot SHA-256 hashes, assign an
   ephemeral evidence ID, emit bounded telemetry, and return report + preview.
   Do not insert or update any database record.

Use pure helpers instead of fabricating a public Express request. Public and
preview controllers share projectors, never authorization behavior.

### Stable findings

Every finding has `code`, `severity`, `path`, `subjectType`, optional
`subjectId`, bounded `message`, and bounded `recommendedAction`. Severities are
`error`, `warning`, or `info`; report status is `blocked` when any error exists,
`warnings` when only warnings exist, and `ready` otherwise.

| Severity | Initial stable codes |
| --- | --- |
| Error | `page_not_found`, `page_operation_invalid`, `page_item_limit_exceeded`, `page_item_unsupported`, `page_reference_malformed`, `page_reference_missing`, `page_presentation_mismatch`, `section_config_invalid`, `section_reference_missing`, `catalog_reference_missing`, `catalog_lifecycle_unavailable`, `media_upload_incomplete`, `media_publication_incomplete`, `media_storage_identity_invalid`, `media_object_missing`, `attribution_invalid`, `storage_verification_unavailable` |
| Warning | `artwork_missing`, `artwork_lifecycle_unavailable`, `artwork_object_missing`, `attribution_unknown`, `section_empty`, `duplicate_section_reference`, `legacy_lifecycle_fallback` |
| Info | `personalized_signed_out_preview_empty`, `device_local_source_not_resolved`, `preview_is_advisory`, `public_projection_omitted_item` |

Codes, not English messages, are the test/audit contract. Do not return raw
MongoDB/S3 errors, object keys, filenames, internal lifecycle errors, or private
account data.

### Allowlisted response DTO

```text
PrepublishPageValidationResponse
  schemaVersion: 1
  report
    evidenceId, validatorVersion, generatedAt
    status: "ready" | "warnings" | "blocked"
    subject: { kind: "pageLayout", slug }
    operationType, candidateHash, observedSnapshotHash
    storageVerification: { requested, outcome, checkedObjectCount }
    summary: { errorCount, warningCount, infoCount, omittedItemCount }
    findings[]: { code, severity, path, subjectType, subjectId?, message, recommendedAction }
  preview
    audience: "publicSignedOut" | "libraryContractOnly"
    page
      slug, title
      items[]
        itemType, carouselId?, collectionId?, order
        carousel?: { _id?, name, items, mode, artistConfig?, personalizedConfig? }
        contentCollection?: { _id?, name, presentation, mode, contentType, dynamicSource?, items }
    included
      albums[]: { _id, title, coverArtUrl, audioTrackIds, releaseDate, credits?, displayByline?, attributionStatus? }
      audioTracks[]: { _id, title, coverArtUrl, displayCoverArtUrl, albumId, artistIds, genres, releaseDate, duration, format, mediaType, streamUrl, credits?, displayByline?, attributionStatus? }
      posts[]: { _id, title, description, mainImageUrl, imageUrls, userId, createdAt }
    omissions[]: { path, contentType, contentId, findingCode }
```

The `page` and `included` shapes match the existing expanded public response.
Preview metadata stays outside those objects. Forbidden fields include
`createdBy`, `updatedBy`, emails, roles, sessions, raw `coverArtId`, `s3Key`,
pending/cleanup keys, upload/publication errors, reference revisions, leases,
internal audit fields, and exception details.

### Authorization and security

- Keep the route under `/content/manage`, after existing Web auth/admin and
  same-origin cookie-mutation guards and before its dedicated 64 KiB parser.
- Anonymous requests follow existing login behavior. Authenticated users get
  `403` before body parsing. Controller/service require an explicit admin actor;
  `createdBy` never authorizes preview.
- Do not add a Bearer/public preview route, public token, iframe bypass, query
  override on `/content/pages/:slug/expanded`, or public evidence lookup.
- Bound Page items to 100, section items to 500, exact object checks to
  deduplicated keys, and S3 `HEAD` concurrency separately from uploads.
- Escape all HTML; schema-shape JSON; set `Cache-Control: no-store`; retain the
  Content Manager CSP, framing, and browser-session privacy headers.

### Evidence and observability

The first slice has no durable preview or audit collection. Its evidence is the
returned `evidenceId`, validator version, candidate/snapshot hashes, stable
finding codes, and a matching bounded structured operational event. This does
not authorize a later write and cannot reconstruct or publish the candidate.

Emit one `content_validation` event with the evidence ID, operation type,
status/counts, storage outcome, and duration bucket. Measure request count,
outcome ratio, finding-code count, duration, and S3 verification failure. Logs
exclude actor/content IDs, candidate payloads, names, keys, raw errors,
credentials, cookies, and private listener data. Whether later immutable-draft
publication requires durable audit records is a separate skipped decision.

### First-slice concurrency truth

The response is a snapshot, not a lock. `observedSnapshotHash` covers normalized
Page, referenced definitions, catalog lifecycle identities, and validator
version. UI copy says **Previewed at …; saving will revalidate current state**.

The existing mutation endpoint stays authoritative and fences references in its
own transaction. It does not accept report ID as proof or weaken validation
when JavaScript is bypassed. A changed snapshot may make the save differ/fail;
the first slice must not claim preview/publish atomicity.

## Deferred immutable drafts and atomic database publishing

### Required data model

Do not overload `contentWorkflowOperations` or `sessionStorage`. Add:

- `contentChangeSets`: global admin-authored container with `open`,
  `publishing`, `published`, `publishFailed`, `abandoned`, or `superseded`
  state; current revision; author/adopter; lease; operation ID; timestamps;
- `contentChangeSetRevisions`: append-only intent, parent/revision IDs, payload
  hash, base entity revisions, reserved new IDs, validation report/summary,
  author, timestamp;
- `contentDraftAssets`: exact reserved owner ID, kind, identity-bound final S3
  key, creator, upload/cleanup lifecycle, size/type metadata, revision owner;
- `contentPublicationOperations`: idempotency, changeset/revision/hash, lease,
  attempts, before/after revisions, status, bounded error, commit readback, and
  reconciliation state;
- `contentRevisionHistory`: bounded before/after public projections and
  operation provenance sufficient to propose a forward rollback changeset.

All require bounded indexes, reconciliation, retention, and account-deletion
behavior.

### Draft asset lifecycle

1. Reserve final catalog owner IDs in an immutable revision before bytes.
2. Insert pending draft-asset evidence with exact owner/key/kind/creator.
3. Validate/decode and upload the private identity-bound object. It stays
   non-public because no ready owner references it.
4. Mark ready after exact S3 confirmation; failure/uncertainty retains key and
   evidence for retry/reconciliation.
5. Publication moves ownership evidence in the same MongoDB transaction that
   creates/updates the public owner. Draft or catalog evidence always exists.
6. Replacement attaches new key before old-key cleanup. Failed cleanup remains
   recorded on the winning public lifecycle.
7. Abandonment deletes exact staged objects before lifecycle rows. Failure is
   `deleteFailed`; unknown data is never guessed or auto-deleted.

Bulk uploads remain independent per-file lifecycles even when grouped by a
future changeset.

### Publish transaction and limits

Atomic publication means one bounded MongoDB transaction makes the complete
approved public database projection visible after all assets are ready. It
cannot include S3 calls.

The publisher claims one revision with lease/idempotency; revalidates current
state/assets; compares base revisions inside the transaction; writes owners,
Credits, Album membership, Carousel/Grid/List, Page placement, asset ownership,
provenance, revision history, and operation state; increments a uniform
`contentRevision`; and confirms unknown commit results by exact operation/hash,
entity revision, relationship, and asset readback. Old-object cleanup occurs
only after confirmed commit and retains failure evidence.

Recommended initial caps: 100 mutated entities, 500 embedded reference writes,
100 Page items, 500 section items, and no destructive S3 asset change in the
first atomic-draft release. Oversized work is rejected/split, never silently
downgraded to a partially atomic saga. Validate caps under load before approval.

Guided Artist release remains its current resumable saga unless later rebuilt
as a bounded changeset. Successful steps must not be auto-deleted after an
optional failure.

### Retry, conflict, reconciliation, and rollback

- Retry uses the same immutable revision/operation ID; edits append a revision
  and invalidate prior validation.
- A base mismatch returns `409 draft_conflict`; never auto-merge Credits,
  ordering, deletion, or assets.
- A lease prevents concurrent publishers. Reclaim an expired lease only after
  commit readback.
- Reconciliation covers draft assets, invalid owner keys, stalled
  upload/cleanup, expired leases, operation/entity mismatch, orphan revisions,
  and history gaps; remediation remains explicit.
- Rollback is a newly validated forward changeset from a published before
  projection. It never rewinds history or overwrites later work.
- Metadata/relationship rollback can work while referenced entities exist.
  Asset rollback cannot promise bytes after deletion without approved retention
  or a new upload.

### Account and provenance lifecycle

- Drafts/reports are global admin work, not owner-private content. ID possession
  never grants access.
- Existing entities keep original `createdBy`; publication records the acting
  admin separately. New entities use revision author or audited adopter.
- `touchActiveAccount` remains in publication. A missing author fails closed
  until a current admin adopts a new immutable revision.
- Adoption records old/new actors and does not rewrite published provenance.
  Account deletion must abandon/adopt open drafts and finish or retain staged
  asset cleanup evidence.
- First-slice validation creates no account-linked row. A future durable
  publication audit must define bounded retention and account-reference policy.

## Implementation stages

### Stage 0 — Approve shared contract

Status: **Not started**

- Resolve skipped decisions below.
- Add approved behavior to `docs/business-rules.md` before/with implementation;
  keep route/schema details in README/operational docs.
- Confirm first slice stays Page Layout only and advisory.

### Stage 1 — Pure candidate and validator services

Status: **Not started**

- Add strict intent schema, in-memory operation, bounded graph loader, stable
  findings, storage checks, hashes, and allowlisted DTO.
- Refactor only enough to share pure public projectors; do not fork readiness.
- Unit-test every operation, finding, bound, and forbidden field.

### Stage 2 — Administrator route, evidence, and preview UI

Status: **Not started**

- Add pre-body admin/same-origin protection and 64 KiB parser.
- Add bounded structured evidence events and accessible JSON-enhanced + no-JS
  preview without adding database persistence.
- Keep existing mutations and form recovery intact.

### Stage 3 — Integration, E2E, and rollout

Status: **Not started**

- Run replica-set, S3, authorization, zero-persistence, concurrency, and browser
  tests.
- Add feature flag, README, runbook, dashboards/alerts, rollout, and rollback.
- Run `npm test`, `npm run test:integration`, `npm run build`, relevant Content
  Manager/Listener E2E, and `git diff --check`.

### Stage 4 — Immutable draft implementation

Status: **Not started**

- Revalidate plan against current rules/code.
- Implement metadata/relationship-only changesets first.
- Add atomic publication, history, forward rollback, asset staging,
  reconciliation, and adoption only in approved increments.

## Required test coverage

### Unit and component

- Reject unknown fields, malformed IDs, multiple operations, invalid indexes,
  limits, wrong types, and oversized bodies.
- In-memory operations do not mutate loaded documents.
- Hash stability/key-order independence and sensitivity to order/lifecycle/
  validator version.
- Every finding code/count/order/deduplication/bound.
- Target/presentation mismatch; manual/dynamic modes; personalized signed-out;
  device-local placeholders.
- Ready/legacy/pending/failed/deleting catalog, image, Credit, publication,
  active-key, missing-object, and timeout cases.
- Public projector parity and absence of forbidden fields.
- Escaped HTML, dialog/focus/`aria-live`, omissions, and labels.
- Structured evidence event contains only allowlisted ID, versions,
  outcome/counts, storage outcome, and duration bucket.

### Integration on Mongo replica set

- Anonymous redirect, non-admin `403`, role downgrade, admin success, and guards
  before parser/database/S3 work.
- Valid/missing/mismatched/malformed/unsupported/concurrently deleted graph.
- Ready/non-ready manual items; Album/MediaTrack mismatch; attribution; artwork;
  exact S3 outcomes.
- Preview performs no database or S3 mutation and creates no durable server
  state.
- Concurrent changes alter snapshot hash; existing saves keep current fences.
- Evidence-ID uniqueness, log allowlist, duplicate isolation, and bounded
  concurrency.
- Public expanded responses remain compatible and expose no preview fields.

### Browser E2E

- Admin previews every operation and ready/warning/blocked states; cancel never
  mutates; separate valid save still works.
- Anonymous/user direct access denied; back/refresh cannot publish/replay.
- Home unchanged during/after preview cancellation.
- Keyboard/screen-reader, focus, responsive, long CJK, empty Page, omissions.
- `sessionStorage` recovery survives same-tab navigation, never restores files,
  and is not presented as server draft.
- Home signed-out semantics and Library placeholders read no private activity.

### Deferred draft gates

- Immutable revision/adoption, stale conflicts, concurrent publishers, leases,
  idempotent retry, unknown commit, exact readback.
- Create/replace/abandon/publish/cleanup for every asset failure ordering.
- Atomic two-sided relationships, limits, forward rollback, later conflicts,
  missing bytes, account deletion, provenance adoption, and durable-audit policy.

## Rollout and rollback

1. Ship behind `CONTENT_MANAGER_PREPUBLISH_PREVIEW=false`; verify no public diff.
2. Enable non-production; exercise valid, blocked, storage failure, concurrency,
   and logging degradation with representative graphs.
3. Enable for production admins; monitor latency, outcomes, S3 failures,
   and server errors.
4. Keep advisory through first release; no evidence-ID requirement on writes.

Rollback disables the flag, hides control, and returns bounded disabled/404.
No database, public-data, or S3 rollback is needed because the slice persists
nothing and performs no mutation.

## Documentation and dependencies

Implementation updates:

- `docs/business-rules.md` for approved behavior;
- `README.md` for endpoint, flag, evidence/log allowlist, limits, troubleshooting;
- an operations runbook for health, exact S3 checks, disablement, log/metric gaps,
  and later draft reconciliation;
- affected tests and Content Manager accessibility/operations documentation.

No iOS change is needed for the first slice because the public expanded DTO and
ready projection do not change. Preview fixtures must remain compatible with
the sibling iOS `Page.swift` decoder. Later draft work needs Finitude regression
fixtures only if public contracts change.

## Skipped decisions with safe defaults

| Decision | Recommended safe default |
| --- | --- |
| Does first-slice validation block writes? | **Skipped** — advisory only; existing endpoint validation stays authoritative. |
| First-slice breadth | **Skipped** — Page Layout single-operation intents only; guided release/catalog later. |
| Durable validation/publication audit | **Skipped** — none in the first slice; before immutable drafts, approve a minimal schema with 90-day default retention. |
| Storage verification outage | **Skipped** — report blocked; never claim verified readiness. |
| Missing artwork | **Skipped** — warning; placeholder makes content usable. |
| Unknown attribution | **Skipped** — warning when valid; error only for invalid state. |
| Personalized preview identity | **Skipped** — signed-out only; never impersonate a listener. |
| Duplicate Page section | **Skipped** — warning, preserving current behavior. |
| Draft collaboration | **Skipped** — one author + explicit audited adoption; no merge. |
| Draft publish approval | **Skipped** — one current admin; four-eyes is separate. |
| Atomic draft size | **Skipped** — conservative caps above, validated under load. |
| Destructive asset changes in atomic v1 | **Skipped** — exclude until retention/rollback approved. |
| Revision retention/rollback window | **Skipped** — 20 revisions or 90 days; no S3-byte promise. |
| Scheduling | **Skipped** — exclude until manual lifecycle is proven. |
| Public/shareable preview | **Skipped** — none; administrator session only. |

## First-slice acceptance criteria

- Preview changes no Page, section, catalog, relationship, lifecycle, S3,
  public Listener, or private listener state.
- Anonymous/users cannot access route/report/HTML; authorization precedes
  body parsing/external work.
- Stable findings cover artwork, unavailable/incomplete media, dangling refs,
  attribution, presentation mismatch, unsupported items, storage failure, and
  client-only sources.
- Existing public allowlists/readiness project preview; internal fields never
  cross the DTO boundary.
- UI/report distinguish `sessionStorage`, operation recovery evidence, and
  future immutable revisions, and call preview advisory rather than atomic.
- Evidence/telemetry are bounded and contain no raw payload/key/private data.
- Required repository gates pass and public Web/iOS fixtures remain unchanged
  unless separately approved.
