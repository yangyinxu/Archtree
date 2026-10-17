# Finitude Administrator Workbench

The private administrator API is mounted at `/api/admin/v1`. It uses the current
persisted `admin` role, same-origin cookie mutation protection, bounded parsers,
account-viewer fencing and `no-store` responses. `GET /capabilities` advertises
admission independently of the normal listener DTOs. Existing catalog edits,
cover changes, existing-Album reviews and local MP3 conversion need only that
role and have no deployment flag. The remaining flags below default closed and
accept only the literal `true`:

| Configuration | Purpose |
| --- | --- |
| `FINITUDE_ADMIN_IMPORTS_ENABLED` | Admit new import projects, analysis and publication steps |
| `OPENAI_API_KEY` | Reuse the existing Naruto Mobile server provider configuration for `gpt-6-luna` |
| `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` | Optional existing provider routing; never returned to clients |
| `ADMIN_IMPORT_S3_BUCKET_NAME` | Dedicated private staging bucket, distinct from `S3_BUCKET_NAME` |
| `FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY` | Operator assertion that the staging bucket denies public/CDN access |
| `FINITUDE_ADMIN_VISIBILITY_ENABLED` | Admit explicit public/hidden changes (also requires `FINITUDE_HIDDEN_DELIVERY_ENFORCED`) |
| `FINITUDE_HIDDEN_DELIVERY_ENFORCED` | Operator assertion that historical object URLs, S3 policies and CDN delivery deny hidden access |

An existing Album review needs no staging bucket; starting Luna also requires
the imports flag and configured provider.

For a local administrator session with imports enabled, use the existing ignored
`.env` for provider configuration, then start the application with:

```sh
npx --no-install cross-env FINITUDE_ADMIN_IMPORTS_ENABLED=true npm run dev
```

Restart the running server after configuration changes and refresh the browser's
administrator capabilities. Existing inherited environment values take precedence
over `.env`, so the explicit startup values above also override a closed parent
shell flag. This command does not assert private staging storage or hidden delivery.

A private ACL alone does not override a public bucket policy. Verify denied
unauthenticated access to the staging prefix and historical canonical URLs
before enabling the corresponding assertion. The application enforces hidden
reads even when admission flags are rolled back. Old external artwork without
an owned asset must migrate before hiding its owner. Previously delivered files
cannot be recalled. Private preview GET/HEAD accepts the account-viewer header,
or a non-secret `viewer` query parameter for browser media elements; neither is
an authentication credential. Every preview requires the current admin session.

Catalog snapshots expose only the protected `/catalog/:kind/:id/artwork` path,
including supported legacy `coverArtUrl` records. A stored image preview requires
the ready image lifecycle record to belong to the current ready owner and retain
its exact reference. Legacy external artwork uses a credential-free HTTPS proxy:
only port 443, all DNS answers must be public unicast, the socket pins one checked
answer, and TLS verifies the original hostname of each connection. A fixed
application User-Agent identifies the image client without account information.
At most three HTTPS redirects are followed; every destination repeats the URL,
DNS and TLS checks. Missing or duplicate Location fields, unsafe destinations
and loops fail closed, and redirect bodies are destroyed without forwarding
cookies, authorization or referrer headers. Download and decoding share an eight-second
deadline, a 10 MiB input limit and a 16-million-pixel ceiling. The process admits
two legacy downloads/decodes at once, queues at most 16 (eight per account), and
cancels queued work on disconnect or expiry. Raster decoding also shares the
canonical artwork-transform budget. Supported static
JPEG, PNG, WebP and GIF inputs are completely decoded, stripped of metadata and
returned as WebP at most 1280 pixels per side. The response is private/no-store
and stops waiting at its deadline; an already-started native decode retains its
capacity until its actual promise settles and has a separate native timeout.
Every response rechecks the current administrator session, ready owner and exact source
before delivery. It never exposes the legacy URL or changes storage, and does
not satisfy the separate historical-URL migration requirement for hiding content.

The Web import editor uses Draft, Review, Files and Publish sections.
Section navigation retains account-fenced local work and does not dispatch a
mutation. Compact value comparisons keep source evidence expandable; publication
recovery has its own status and actions. Confirmation windows show the frozen
named target and proposed change before secondary explanations. Technical IDs
remain available in Details rather than leading normal catalog and Page rows.

The workbench is Web-only. Finitude iOS and Android expose listener features even
for administrator accounts; they do not load administrator capabilities, private
previews, import/catalog/Page editors or upload controls.

<!-- @catalog -->
**Contents**

- [Device-local MP3 conversion](#device-local-mp3-conversion)
<!-- @end-catalog -->

## Device-local MP3 conversion

Open `/finitude/admin/conversions`, or choose **Convert to MP3** for an existing
Album or AudioTrack in Catalog. The device queue accepts up to 100 FLAC/PCM WAVE
files, each at most 512 MiB. Actual complete decoding determines eligibility.
Generated outputs also have a 512 MiB hard limit. Embedded metadata is bounded
to 16 MiB/4096 blocks, and declared FLAC frame lengths to 1 MiB. Invalid, corrupt,
unsupported or oversized sources remain separate failed members of the batch.
Folder intake inspects at most 1024 selected entries, keeps FLAC/WAVE signatures
and named audio candidates, and skips unrelated covers or text files. Individually
selected files are decoded regardless of their extension; stored MP3 paths use
the same normalized, bounded output filename as the generated file.
The preset is 320 kbps CBR, retaining mono/stereo and 44.1/48 kHz; other supported
sample rates are converted to 48 kHz. No volume normalization or channel downmix
is applied. MP3 encoder delay and padding mean this is not a gapless guarantee.

The feature requires a secure context, OPFS, IndexedDB and Web Locks. It requests
persistent browser storage, but browsers may deny persistence or evict data.
That permission request is advisory and does not hold task creation open while
Firefox waits for a browser prompt, or fail conversion if permission is denied
or unavailable. Actual IndexedDB/OPFS writes, storage quota and account ownership
checks still have to succeed.
Browser ports without the required storage APIs show the unavailable explanation
and disable task creation. The browser gate requires real conversion in Chromium
and Firefox. It measures native capabilities in every engine; unsupported WebKit
ports instead verify unavailable controls and still run source-preview, layout
and localization checks. Only the four encoding/upload scenarios that require
durable files are explicitly skipped there, with capability evidence retained.
Keep external originals. Only one same-account tab executes device jobs at a
time. Jobs and bytes remain on this browser/profile/device under their initiating
account; current administrator authorization is required to see or recover them.
Closing a page/process pauses conversion. An unfinished track starts again from
its retained source; verified MP3s are reused. Source downloads resume only under
the same strong ETag and exact range. A changed source is never appended.

New local files create an import draft after all selected tracks finish; metadata,
duplicate review, upload and publication retain the existing import workflow.
Existing tracks use a frozen operation and preserve Track identity and relations.
Unknown uploads reconcile the original operation before resending bytes. Local
MP3 deletion requires exact current S3 and ready-publication proof. Failed or
uncertain results retain the MP3. Retained lossless copies and selected external
originals are never removed by MP3-cache cleanup.

Conversion endpoints, relative to `/api/admin/v1`, all require current admin and
matching account-viewer identity:

- `GET /conversions/albums/:id/source`, `/conversions/tracks/:id/source`:
  private ordered sources and opaque catalog/media/membership revisions.
- `POST /conversions/tracks/:id/operations`: fixed UUID, source revisions,
  strong ETag/length, Album snapshot and output SHA-256/length/preset/filename.
- `POST /conversions/tracks/:id/operations/:operationId/upload`: one bounded
  multipart `audioFile`; actual 320 kbps MP3 frames and digest are validated.
- `GET /conversions/tracks/:id/operations/:operationId`, `POST .../reconcile`:
  exact actor-owned operation and storage/publication recovery. Never infer
  completion from a reservation or merely successful PUT.
- `POST /conversions/tracks/:id/operations/:operationId/cancel`: abandon only an
  unattached output, retaining exact cleanup evidence for an unknown PUT.
- `GET /conversions/imports/:id/ready`: creator-only exact published slot proof;
  staged assets and different-byte duplicate reuse cannot clear MP3 cache.
  `POST` to the same path with `{slots: [uuid]}` checks only selected pending
  cache slots, allowing later members to progress under the bounded S3-read budget.

Every administrator may start conversion operations; no server encoding service
or extra key is needed. Source files remain private authenticated media, not public S3 redirects.
The isolated hashed conversion Worker alone receives `wasm-unsafe-eval`; the
document keeps strict script policy. The LAME WASM module is bundled locally,
with no runtime CDN fetch or COOP/COEP requirement.

Dependencies are pinned to Mediabunny/MP3 encoder 1.61.4 and noble hashes 2.4.0.
Licenses, attribution, LAME 3.100 source, wrapper/source modules and rebuild
instructions ship at `/finitude/licenses/mp3/NOTICES.txt` alongside the source
archives. The Worker has a separate 256 KiB gzip budget; ordinary route and CSS
budgets are unchanged. `npm run build:web` checks all three budgets.

Import routes (relative to `/api/admin/v1`):

- `GET /imports`: bounded workbench inventory/counts, filters and opaque cursor.
- `POST /imports`: `{operationId, manifest, draft?}`; names and relative paths,
  at most 100 files, never client S3 locations or absolute filesystem paths.
- `GET /imports/:id`, `PATCH /imports/:id`: read/save a private draft.
- `POST /imports/:id/analyze`, `/adopt`, `/decisions`, `/cancel-analysis`:
  persisted analysis and selective review with `{operationId, expectedRevision}`.
- `GET /imports/:id/duplicate-candidates`: bounded candidates; a name match is
  never verified identity or automatic reuse.
- `POST /imports/:id/assets/:slotId`: one multipart `file`; `Idempotency-Key`
  and numeric `If-Match` reserve its private object identity before S3 work.
  `slotId=cover` is the independent manual cover slot.
- `DELETE /imports/:id/assets/:slotId`: explicit staged cleanup with the same
  operation headers; unknown/failed cleanup retains lifecycle evidence.
- `POST /imports/:id/select-cover`: explicitly select a ready manual or embedded
  artwork slot; uploading artwork alone never selects it.
- `GET /imports/:id/assets/:slotId/preview`: protected staged artwork preview.
- `POST /imports/:id/publish`: explicit reviewed approval, then asynchronous
  fixed-identity publication; `/resume-publication` reconciles that approval's
  original operation ID rather than creating another Album.
- `POST /imports/:id/cancel-publication`: explicit cancellation with
  `{operationId, expectedRevision, publicationOperationId}`. The new operation
  UUID binds the exact original publication UUID. An active worker lease or a
  completed publication rejects cancellation. The private response includes
  `publicationRecovery: {operationId, cleanupPending, startedByMe} | null`.
  For a cancelled publication, `/resume-publication` reconciles and deletes
  unused canonical copies under the requesting current administrator, even after
  the original grant expires. It never reattaches or repeats an unknown copy.
  Draft edits, suggestion review and duplicate decisions remain available while
  cleanup is pending; source changes, analysis and a new publication approval
  resume only after confirmed cleanup. A new approval preserves the cancelled
  operation's history and allocates independent catalog/storage identities.
  Each project admits at most 16 publication approvals, retaining at most 15
  complete historical snapshots; `capabilities.publish` closes at that limit.
  Cancellation and cleanup remain admitted independently of this new-work limit.

Ordinary import mutations retain their 256-receipt admission limit. Required
asset cleanup and publication cancellation use separate lifecycle receipts tied
to each admitted asset version or approved publication, preserving exact replay
and UUID-collision checks without consuming the ordinary mutation allowance.
The client receives a bounded recent receipt projection; the original publication
UUID remains available through `publicationRecovery` for durable reconciliation.

The analysis worker admits two active projects globally and one per initiating
admin, uses 24-hour grants and 120-second leases, and checkpoints every provider
attempt before dispatch. A stopped analysis still occupies its actor/global slot
until its in-flight provider outcome is checkpointed. Each project permits two generations and at most 22
calls and the deployment reserves at most 220 attempts per UTC day across all
projects, ten tracks per chunk, 4,000 output tokens/call, 48 KB context and 256 KB
responses. `store:false` is sent to the provider; it is not a zero-retention
promise. Credentials, emails, raw music and absolute paths are not analysis
context. Potentially paid ambiguous outcomes block automatic replay. Production
cost/quality measurements and real S3 proof are separate from mocked tests.
Daily reservations are persisted in the same transaction as a chunk checkpoint;
uncertain outcomes and dispatches stopped after reservation remain counted.

Web **Workbench → Edit or review existing Album** exposes explicit manual editing
and creation of an existing-Album review. The separate **Existing Album reviews**
queue retains saved projects when the browser closes. **Unfinished** includes all
unapplied reviews; **Album updated** confirms that this project's selected fields
were applied. Luna progress and the original-Album update status are shown
separately. **Save review draft** changes only the private draft; **Update original
Album** requires selecting saved changes and confirming their frozen old/new
values. **Start Luna review** is available above the track editor and always has
its own confirmation. All `/finitude/admin/*` pages use a dedicated administration
layout with management navigation, language/account controls and the Admin/User
view switch. Listener navigation, global music search and playback controls are
absent. Switching back to User view restores the listener layout while retaining
the authenticated session, playback state and active Room connection.
The catalog uses artwork/name entries for Albums, Artists, MediaTracks and
Organizations, with management actions on their detail pages. The inventory
loads separately from editing controls. Its optional `kind=artist`,
`kind=audioTrack` or `kind=organization` query parameter selects a category;
missing or unsupported values select Albums. Detail return links retain that
category. Organizations use a name mark, matching listener details, and do not
gain artwork upload controls.
Direct catalog saves also confirm the frozen partial patch with per-field saved
and proposed values, including coupled Credits and attribution. A newer catalog
revision disables the open confirmation and shows its recovery instruction;
cancelling preserves unsaved edits. Offline or failed reads do not report a
revision change without a confirmed newer item.
Analysis uses retained original
filenames and saved metadata; absent historical folder/file evidence stays empty.
No media is uploaded, copied or published by this workflow. Artist attribution,
artwork and visibility remain separate catalog edits.

Catalog review routes (relative to `/api/admin/v1`):

- `POST /catalog-reviews`: `{operationId, albumId, expectedRevision}` captures a
  ready Album and up to 100 ready Audio members. Empty Albums are supported;
  malformed, missing, Video or inconsistent members are explicitly rejected.
  Creation does not start analysis. Original filenames are allowlisted basenames, never storage keys.
- `GET /catalog-reviews` and `GET /catalog-reviews/:id`: independent bounded
  workbench pagination and private readback. `sourceStatus` distinguishes current,
  changed and unavailable sources. Old `/imports` routes exclude these projects;
  strict native import DTOs are unchanged.
- `PATCH /catalog-reviews/:id` and `POST` to `/analyze`, `/adopt` or
  `/cancel-analysis`: save/review privately with the original UUID and numeric
  revision. Analysis uses the existing import flag, provider and shared budgets;
  viewing, editing or creating a project does not dispatch a provider request.
- `POST /catalog-reviews/:id/apply`: `{operationId, expectedRevision, fields}`
  selects saved Album `title`/`releaseDate` or Track `title`/`trackNumber` paths.
  Revisions, membership, readiness and internal filename/media evidence are
  checked in the same transaction as metadata/order updates and the receipt.
  Stale sources reject the whole operation. Applied projects become read-only;
  no upload, duplicate-decision, S3 or publication endpoint exists for them.

The publisher reserves immutable approvals and catalog IDs before copying
objects. It uses version-bound GET and conditional checksum PUT to canonical
storage. Canonical destination PUT uses one SDK attempt and a 90-second deadline
within its five-minute lease, preventing a late SDK retry from recreating a
confirmed-clean object. The publisher checkpoints unknown outcomes and publishes the ready graph in one
MongoDB transaction. An unresolved object never loses its import evidence.
Stopping the server stops new steps and awaits admitted worker work before
closing MongoDB. Required indexes and the global admission record initialize
with normal server startup.
Audio/artwork reconciliation includes unresolved canonical copy reservations
from import and cover operations before reporting orphan candidates. Completed
history does not mask later unreferenced objects; unresolved cleanup evidence
remains counted even after an operation is cancelled.

Existing catalog routes use metadata-digest revisions so legacy edits also cause
conflicts: `GET /catalog/:kind`, `GET/PATCH /catalog/:kind/:id`, where `kind` is
`artist`, `album`, `audioTrack` or `organization`. A patch contains
`{operationId, expectedRevision, fields?, visibility?}`. Credits and attribution
must be supplied together; memberships and storage keys are never editable
fields. Track Number edits recompute the parent's automatic order atomically.
`GET /pages/:slug` and `PATCH /pages/:slug/items/:itemId` address one Page
placement, preserving reusable definitions and order. Each placement includes
bounded `name`, `sourceMode` (`manual`, `dynamic` or null) and `referenceStatus`
(`ready`, `missing` or `unsupported`) display metadata. The Page digest binds
that resolved metadata, so a referenced name/source change requires fresh
confirmation. A named target is write-fenced with the visibility mutation.
`/artwork` and `/media`
are private previews with current-source and current-role stream revocation.
Unknown commit responses retry the original intent; stale revisions require
reviewing the latest saved state. Client confirmation dialogs retain the opened
revision and exact publication/asset identity; a background refresh invalidates
the confirmation rather than replacing its approved target.

`POST /catalog/:kind/:id/cover` takes
`{operationId, expectedRevision, importId, slotId, expectedSourceRevision}`;
`DELETE` takes `{operationId, expectedRevision}`. The owner digest and numeric
source-import revision both bind the approved preview. Organization cover edits
are unsupported because that kind has no owned-image lifecycle. Replacement
copies into a reserved canonical asset, attaches it atomically, then cleans the
old asset. `GET /catalog/:kind/:id/cover-operations` prioritizes unresolved work
and cleanup debt; `POST /catalog/:kind/:id/cover-operations/:operationId/reconcile`
reuses the original approval. Each actor may hold at most 256 unresolved cover
operations. Confirmed history remains traceable without consuming that capacity.
`POST /catalog/:kind/:id/cover-operations/:originalOperationId/cancel` explicitly
cancels an unattached approval with a new `{operationId, expectedRevision}`
receipt. A null revision is accepted only when the owner is absent or non-ready.
Attached changes and active worker leases cannot be cancelled. Unused target
cleanup retains its source pin and storage evidence until confirmed; cancelled
cleanup can be reconciled by any current administrator without reattaching it.
