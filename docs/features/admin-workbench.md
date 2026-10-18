# Finitude Administrator Workbench

The private administrator API is mounted at `/api/admin/v1`. It uses the current
persisted `admin` role, same-origin cookie mutation protection, bounded parsers,
account-viewer fencing and `no-store` responses. `GET /capabilities` advertises
admission independently of the normal listener DTOs. Existing catalog edits,
visibility changes, clearing a cover, existing-Album reviews and local MP3
conversion need only that role and have no deployment flag. Choosing a new
cover also requires `FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY` and its
distinct `ADMIN_IMPORT_S3_BUCKET_NAME` staging bucket. The remaining settings
below default closed; the flags among them accept only the literal `true`:

| Configuration | Purpose |
| --- | --- |
| `FINITUDE_ADMIN_IMPORTS_ENABLED` | Admit new import projects, analysis and publication steps |
| `FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT` | Operator contact (email or https URL) sent in the User-Agent of MusicBrainz and Cover Art Archive requests, never to iTunes; lookup is unavailable without it (not a flag) |
| `OPENAI_API_KEY` | Reuse the existing Naruto Mobile server provider configuration for `gpt-6-luna` |
| `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` | Optional existing provider routing; never returned to clients |
| `ADMIN_IMPORT_S3_BUCKET_NAME` | Dedicated private staging bucket, distinct from `S3_BUCKET_NAME` |
| `FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY` | Operator assertion that the staging bucket denies public/CDN access |
| `FINITUDE_MOTION_PREVIEWS_ENABLED` | Show the Motion preview panel for Video MediaTracks and serve public motion previews |

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
unauthenticated access to the staging prefix before enabling that assertion.
Hiding relies on the catalog bucket denying anonymous reads (verified for
production on 2026-10-17): media and artwork reach clients only through
visibility-checked application routes. Old external artwork without
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
mutation. Saving sends only the values the administrator changed, each with
the saved value the edit started from. A newer saved version that changed only
other values carries the unsaved edits over; one that changed an edited value,
or a refused stale save, loads the saved version for comparison. The Artist
name field edits a draft's single Artist entry, keeping its key and role, and
clearing it then typing again brings that saved entry back. Several entries
show their byline read-only, each track edits its Disc Number, and the label
is not edited here yet. Compact value comparisons keep source evidence
expandable; publication recovery has its own status and actions. Confirmation
windows show the frozen named target and proposed change before secondary
explanations. Technical IDs remain available in Details rather than leading
normal catalog and Page rows.

The workbench is Web-only. Finitude iOS and Android expose listener features even
for administrator accounts; they do not load administrator capabilities, private
previews, import/catalog/Page editors or upload controls.

<!-- @catalog -->
**Contents**

- [Device-local MP3 conversion](#device-local-mp3-conversion)
- [Import format compatibility](#import-format-compatibility)
  - [Rollback floors](#rollback-floors)
- [Metadata lookup](#metadata-lookup)
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

New local files create an import draft after all selected tracks finish. That
creation is their upload approval: the MP3s join the import's upload queue, and
metadata, duplicate review and publication retain the existing import workflow.
The batch name becomes the import's folder label only when the selection has
folders; MP3s chosen without a folder send no folder name to Luna.
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
  `q` matches the folder label, the Album title and every Artist entry name, or
  the Artist name of a project still in format 1; a row's `artistName` is the
  first primary entry.
- `POST /imports`: `{operationId, manifest, draft?}`; names and relative paths,
  at most 100 files, never client S3 locations or absolute filesystem paths.
  `manifest.rootLabel` may be empty only when no `relativePath` contains a
  folder; Luna input then carries no folder name, and a suggestion citing
  folder evidence is rejected. Rolling back below this release keeps every
  staged record readable, but analysis of a folderless import then sends an
  empty folder label and no longer rejects folder-sourced suggestions; re-run
  such an analysis after rolling forward. Without `draft`, the stored draft is
  empty with public visibility, while the create receipt still fingerprints the
  frozen hidden empty draft of earlier releases, so a retry admitted before this
  release replays its original, unchanged project. Rolling back restores the
  hidden default for new imports only; saved projects keep their visibility.
  An explicit draft identical to the frozen hidden empty draft has the same
  create fingerprint as a body without `draft`; a retry that switches between
  the two replays the stored project rather than failing with
  `ADMIN_IMPORT_OPERATION_CONFLICT`. `draft` keeps the v1 shape and its frozen
  parser and fingerprint, so every earlier create receipt still replays; the
  new project is stored as Draft v2 (`draftVersion` 2), and a supplied v1
  `draft` converts with every value the administrator's own.
- `GET /imports/:id`: the private project with a Draft v2 `draft`. `album`
  holds `title`, `artists`, `label`, `releaseDate` and `visibility`, and each
  track holds `slotId`, `title`, `discNumber` and `trackNumber`. An Artist
  entry is `{key, name, role, joinPhrase, musicBrainzId}` with a UUID `key`
  unique in the draft and a `role` of `primary` or `featured`; the label is
  `null` or `{name, musicBrainzId}`. Suggestions are Draft v2, where an
  `artists` suggestion proposes the whole entry list; decisions keep their v1
  fields and include an Artist decision only while the entry it was made for
  keeps its key and name. A project still stored in format 1 reads as its
  Draft v2 view. Value origins (`draftOrigins`) are stored, not returned; each
  is keyed by its value path with `:` in place of `.` (`album:title`,
  `tracks:<slotId>:discNumber`), because MongoDB before 5.0 refuses dotted
  field names.
- `PATCH /imports/:id`: `{operationId, expectedRevision, changes}` saves only
  the values the administrator changed, under one ordinary receipt. Each change
  is `{path, base, value}`, at most one per path: `path` is `album.title`,
  `album.artists`, `album.label`, `album.releaseDate`, `album.visibility`, or
  `tracks.<slotId>.title`, `.discNumber` or `.trackNumber` for a manifest slot;
  `base` is the value the editor read there; and `value` replaces it whole, so
  the Artist entries are one value. Before the intent is fingerprinted, the
  body may hold at most 305 changes, a `path` at most 80 characters, and a
  `base` or `value` nested at most two containers deep and at most 48 KB
  serialized; anything else is `400 ADMIN_IMPORT_INVALID_INPUT`. The save is
  admitted at any project revision. A path is stale only when its stored value
  differs from both `base` and `value` and is the administrator's own (a stored
  value without an origin counts as the administrator's own): then the whole
  save is refused with `409 ADMIN_IMPORT_FIELD_CONFLICT`, nothing is written,
  and the Web loads the saved version for comparison, which is its reload
  request. Staleness is decided per path by value, not by a stored per-path
  revision, so a value changed and then changed back is not stale. A `base`
  equal to what the editor shows for a stored value it cannot display (a
  format-1 value over a bound after NFC, shown as empty) is current too, so
  that value stays replaceable. A value automation wrote is overwritten. Every
  saved path becomes the administrator's own. The
  saved draft must stay valid, or the save is
  `400 ADMIN_IMPORT_INVALID_INPUT`: at most 20 entries with unique keys, every
  primary before every featured entry, Artist and label names of 1 to 200
  characters without control or format characters that differ
  case-insensitively, titles of at most 300 characters (both bounds hold
  before and after NFC normalization), join phrases valid as Credit phrases,
  Disc Numbers from 1 to 999 and at most 48 KB unless the save does not grow
  the draft. A `musicBrainzId` must equal the one stored for that unrenamed
  entry or label; none is stored yet, so it is always `null`. Renaming or
  removing an entry drops its Artist decision. A whole-draft body (`draft`,
  nested at most four containers deep) from an editor that predates Draft v2
  is refused with `409 ADMIN_IMPORT_RELOAD_REQUIRED` right after receipt
  lookup, before the publication lock and the operation limit are checked, so
  a lost response of an earlier save still replays and an outdated editor is
  always asked to reload. The JSON limit is 160 KB for this route and 96 KB
  for the other import routes.
- The first admitted change of a format-1 project, other than staged cleanup,
  publication cancellation and analysis cancellation, stores it as Draft v2:
  its draft, analysis baseline, suggestions and the decisions still bound to
  an entry. Its frozen approval, histories and asset records are untouched,
  and conversion starts no analysis; a receipt replay converts nothing. A
  project saved in a newer draft format is read-only here: every change except
  staged cleanup, reconciliation of an admitted upload, `/cancel-publication`,
  `/resume-publication` and `/cancel-analysis` returns
  `409 ADMIN_IMPORT_RELOAD_REQUIRED` before admission and writes nothing, while
  a replay of a stored receipt still returns that receipt.
- `POST /imports/:id/analyze`, `/adopt`, `/decisions`, `/cancel-analysis`:
  persisted analysis and selective review with `{operationId, expectedRevision}`.
  Luna still reads the v1 view of the Draft v2 baseline, whose first primary
  entry is `artistName`, and its Artist name becomes a one-entry primary
  `artists` suggestion; a name with control or format characters is dropped.
  An accepted suggestion becomes the administrator's own; accepting one whose
  baseline is no longer the current value returns
  `409 ADMIN_IMPORT_FIELD_CONFLICT`, so an Artist suggestion never replaces
  entries that changed. An Artist decision binds the draft's single Artist
  entry and its name, and a reuse or create-distinct decision makes the
  entries the administrator's own: without an entry it is
  `400 ADMIN_IMPORT_DRAFT_INCOMPLETE`, and with several entries or a label
  `409 ADMIN_IMPORT_PUBLICATION_UNSUPPORTED`. Each decision must be one flat
  record of at most 1 KB before the intent is fingerprinted. Publishing needs a
  reuse or create-distinct Artist decision still bound to that entry under that
  name, so renaming or removing the entry makes publishing return
  `409 ADMIN_IMPORT_REVIEW_REQUIRED` until the Artist is decided again.
- `GET /imports/:id/duplicate-candidates`: bounded candidates; a name match is
  never verified identity or automatic reuse.
- `POST /imports/:id/assets/:slotId`: one multipart `file`; `Idempotency-Key`
  and numeric `If-Match` form the upload intent, which reserves its private
  object identity before S3 work. Admission binds slot state and that intent,
  not the project revision: the slot must hold no asset other than a deleted
  or confirmed-failed one, which moves to the slot's history, and no
  publication may lock the sources. `If-Match` stays in the intent hash, so a
  replay of the original intent still matches its receipt, and only the
  administrator who started an upload may replay it. Analysis checkpoints,
  draft saves, completed uploads and embedded staging never make a queued
  upload stale. A transfer error leaves the asset unknown; only reconciliation
  confirms a failure. `slotId=cover` is the independent manual cover slot.
- `POST /imports/:id/assets/:slotId/reconcile`: a JSON body `{operationId}`
  naming the original upload intent, with no bytes. It writes no receipt and
  returns the original upload receipt when one exists, otherwise `null`; any
  current administrator may call it, and a publication that locks the sources
  refuses reconciling an unresolved upload. It sends only a storage `HEAD`,
  and leaves alone an admitted upload whose transfer has not started. An
  object whose length, type and `importid`, `slotid`, `operationid` and
  `sha256` metadata all match exactly makes the asset ready. A missing object
  is a confirmed failure only once the last attempt's upload lease is released
  or expired and its 180-second transfer deadline, which bounds the 15-second
  `HEAD` and the 90-second `PUT` abort, has passed. Anything else, including
  a binding mismatch or a storage error, leaves the asset unknown with its
  evidence intact.
- `DELETE /imports/:id/assets/:slotId`: explicit staged cleanup with the same
  operation headers; unknown/failed cleanup retains lifecycle evidence. An
  unresolved upload (pending, unknown, or a failure reconciliation has not
  confirmed) can be removed only after its transfer deadline, so no late
  `PUT` can leave an untracked object.
- `POST /imports/:id/select-cover`: explicitly select a ready manual or embedded
  artwork slot; uploading artwork alone never selects it.
- `GET /imports/:id/assets/:slotId/preview`: protected staged artwork preview.
- `POST /imports/:id/publish`: explicit reviewed approval, then asynchronous
  fixed-identity publication; `/resume-publication` reconciles that approval's
  original operation ID rather than creating another Album. Appending to an
  existing Album whose visibility differs from the draft's returns
  `409 ADMIN_IMPORT_APPEND_VISIBILITY_MISMATCH` and writes no approval, receipt
  or revision; a stale Album reports `ADMIN_IMPORT_DUPLICATE_STALE` first.
  The Web then asks the administrator to match that Album's visibility, save
  and approve again. Rolled back below this release, the same mismatch reports
  `409 ADMIN_IMPORT_DUPLICATE_STALE` instead. This release publishes one
  primary Artist entry and no label: a draft without a title or Artist entry, or
  whose only entry is featured, is `400 ADMIN_IMPORT_DRAFT_INCOMPLETE`, and
  several entries or a label are `409 ADMIN_IMPORT_PUBLICATION_UNSUPPORTED`,
  both before an approval is frozen. A stored value the editor cannot show
  (it reads as empty there) is also `400 ADMIN_IMPORT_DRAFT_INCOMPLETE`, so it
  is never frozen, and only pending suggestions the editor shows hold the
  approval with `409 ADMIN_IMPORT_REVIEW_REQUIRED`. The approval freezes the Draft v2
  snapshot with `schemaVersion` 2 and makes every draft value the
  administrator's own; the entry's join phrase is kept on its Credits.
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

Ordinary import mutations retain their 256-receipt admission limit. Each
admitted file upload takes one ordinary receipt and its replays take none, so a
100-file import leaves room for re-uploads after confirmed failures, draft
edits, decisions and the approval. Required asset cleanup and publication
cancellation use separate lifecycle receipts tied to each admitted asset version
or approved publication, preserving exact replay and UUID-collision checks
without consuming the ordinary mutation allowance. Automatic embedded-cover
staging, which follows a ready audio upload, likewise has its own bounded
lifecycle receipts. An embedded image whose SHA-256 matches one that is ready,
pending or of unknown outcome is not staged again, and each import makes at
most 16 automatic embedded stagings. Embedded assets staged before this release
keep their ordinary receipts and existing lifecycle.
The client receives a bounded recent receipt projection; the original publication
UUID remains available through `publicationRecovery` for durable reconciliation.

The Web upload queue starts when the create action succeeds, or when an
administrator resumes an import after reselecting its files; no file asks for
its own confirmation. It sends one file per request in manifest order, with a
manual cover last, and each row shows its own status and result. Reselection
matches incomplete slots by relative path and size and refuses, without sending
bytes, a file whose SHA-256 differs from its slot's unfinished upload. Leaving
Admin view, losing the administrator role (a `401` or `403`), a publication
lock, unavailable storage or the receipt limit stops the queue after the
current file; changing section or page never restarts it. A lost response or a
server failure leaves that file unknown, rereads the import and also stops the
queue; Resume then resends that file only under its original intent, unless
the reread shows it admitted. Removing a staged file forgets its chosen copy,
so Resume never sends it again. A create confirmed after its page was left
still starts the queue, and New import then opens a fresh form. Reopening an
import reconciles each unknown upload against storage, and only a confirmed
failure asks for that file again. Any current administrator may check an
unknown upload again without its bytes, but only the administrator who started
it is offered its original-intent retry, which reconciles first and then
resends the original key, `If-Match` and bytes. A selection without folders
hides the folder field. An administrator response that fails the Web bundle's
strict schema, as after a deployment, shows a reload-required state instead of
an error or an automatic retry. A `409 ADMIN_IMPORT_RELOAD_REQUIRED` refusal
fails that file before admission and stops the queue with a reload request and
a Reload button beside the uploads; for other changes it shows that request and
button on the refused action only.

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
the authenticated session, playback state and active Room connection. Switching
to User view on an administration page opens Home as a new history entry, so
browser Back returns to that page, which shows the Admin view gate as any User
view visit does and never restarts a stopped upload queue.
The catalog uses artwork/name entries for Albums, Artists, MediaTracks and
Organizations, with management actions on their detail pages. The inventory
loads separately from editing controls. Its optional `kind=artist`,
`kind=audioTrack` or `kind=organization` query parameter selects a category;
missing or unsupported values select Albums. Detail return links retain that
category. Organizations use a name mark, matching listener details, and do not
gain artwork upload controls.
Direct catalog saves also confirm the frozen partial patch with per-field saved
and proposed values, including coupled Credits with their join phrases and
attribution, and a MediaTrack's Disc Number. A newer catalog revision disables
the open confirmation and shows its recovery instruction; cancelling preserves
unsaved edits. Offline or failed reads do not report a revision change without
a confirmed newer item.
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
  Reviews read through the same allowlist and read-only rule as imports: a
  review saved in a newer format offers neither analysis nor apply, and refuses
  edit, analyze, adopt and apply with `409 ADMIN_IMPORT_RELOAD_REQUIRED`, while
  `/cancel-analysis` stays admitted.
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
Imported Album order follows the catalog rule: Disc Number, then Track Number,
then MediaTrack ID. A new imported MediaTrack stores its reviewed Disc Number
with `discNumberSource: 'admin-import'`. A track whose Disc Number is unknown,
including every track of a format-1 approval, stores none and orders as disc 1.
Appending to an existing Album re-derives its whole order from the stored
numbers of all its MediaTracks, so existing disc groupings are kept.
Audio/artwork reconciliation includes unresolved canonical copy reservations
from import and cover operations before reporting orphan candidates. Completed
history does not mask later unreferenced objects; unresolved cleanup evidence
remains counted even after an operation is cancelled.

Existing catalog routes use metadata-digest revisions so legacy edits also cause
conflicts: `GET /catalog/:kind`, `GET/PATCH /catalog/:kind/:id`, where `kind` is
`artist`, `album`, `audioTrack` or `organization`. A patch contains
`{operationId, expectedRevision, fields?, visibility?}`. Credits and attribution
must be supplied together; memberships and storage keys are never editable
fields. Snapshot Credits have the five fields `creditId`, `subjectType`,
`subjectId`, `role` and `order`, plus `joinPhrase` only when a valid phrase is
stored; an invalid stored phrase reads as absent but still changes the
revision. A patched Credit list is a complete replacement, phrases included: a
Credit without the `joinPhrase` key stores none, and a present but invalid
phrase (including `null` or `''`) returns `400 ADMIN_CATALOG_INVALID_INPUT`
before any transaction or receipt. Other extra Credit keys are ignored, and
Organization Credits such as labels accept phrases too. MediaTrack snapshots
always include `discNumber` (1–999, or `null` when none is stored). A patch may
set it to a whole number from 1 to 999 or to `null`, which removes the stored
Disc Number; any other value returns `400 ADMIN_CATALOG_INVALID_INPUT`. A Disc
Number enters the revision only when one is stored, so records without one keep
their earlier revisions. A Web bundle from before this release rejects
`discNumber` and `joinPhrase`, so reload open workbench tabs after deploying.
Disc and Track Number edits recompute the parent's automatic order in the same
transaction as the receipt.
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

## Import format compatibility

Stored import and review projects carry format numbers, so a release can read
what a later release wrote and never acts on a format it does not know. The
reads live in `src/administration/import/adminImportDraftCompat.ts`.

- **Format numbers.** A project's `draftVersion` and a publication approval's
  `schemaVersion` are absent, `null` or `1` for the original format. This
  release writes `draftVersion` 2 for import projects and `schemaVersion` 2 for
  their approvals, reads formats 1 and 2, and treats 3 and higher, or any value
  that is not a positive whole number, as newer. Catalog reviews stay format 1,
  so a format-2 review is newer here. An approval is format 1 only with a v1
  snapshot (a string `artistName`, no artist entries and no Disc Numbers), and
  format 2 only with a Draft v2 snapshot of one primary Artist entry, no label
  and a `discNumber` field (a Disc Number or null) on every track; anything
  else is treated as newer. A later release must write a higher number for any
  other shape.
- **Read-only newer drafts.** A project saved in a newer draft format admits
  only staged cleanup and upload reconciliation, publication recovery and
  cancellation, and analysis cancellation, plus replays of stored receipts.
  Every other change, including an upload, cover selection or approval, returns
  `409 ADMIN_IMPORT_RELOAD_REQUIRED` before admission. Its analysis is never
  claimed or sent to the provider and does not count against this release's
  analysis concurrency, so neither a queued analysis nor a chunk a newer
  release left in flight blocks other projects; it waits for a release that
  knows the format. An upload admitted earlier still completes and can be
  reconciled, but no new embedded-cover staging is admitted, and the project
  cannot become the source of an existing-catalog cover; releasing an existing
  cover pin stays admitted.
- **Unknown approvals.** An approval in a newer format is never copied,
  committed or cleaned here. A preparing approval becomes needs attention
  without minting identities, tagged `unsupportedVersion` unless the newer
  release recorded its own issue, which is kept. Resuming it copies, commits
  and deletes nothing, and cancelling it keeps cleanup pending with every copy
  record retained, which also keeps a new approval blocked. While such an
  approval is unresolved, in any state but complete or cancelled with confirmed
  cleanup, audio and image storage reconciliation fails closed instead of
  classifying objects.
- **Allowlisted DTOs.** Import responses copy only the Draft v2 fields of the
  draft and suggestions and the v1 fields everywhere else: decisions, assets
  and their tags, publication state and receipts. Review responses and the
  workbench inventory copy only v1 fields, so a Draft v2 project's row shows
  its first primary Artist as `artistName`. Fields and values a later release
  adds are dropped; an unknown state reads as needs attention; and a newer
  format offers no `capabilities`. An open tab of this release therefore keeps
  parsing a newer format instead of asking for a reload, while a tab opened
  before this release fails its strict schema on a Draft v2 response and shows
  the reload-required state.
- **Draft v2 view.** The same module presents a v1 project as Draft v2:
  `artistName` becomes one primary entry with a deterministic per-project key,
  label and Disc Numbers are unknown, and every value counts as the
  administrator's own. The view is computed on read; the first admitted change
  stores it (see `PATCH /imports/:id`).

### Rollback floors

Later stages raise the oldest release that is safe to roll back to:

- This release saves Draft v2 projects and format-2 approvals, so never roll
  back below the release before it, the first that keeps such projects
  read-only and holds their approvals in needs attention instead of misreading
  them. That release reads `discNumberSource: 'admin-import'` without issue.
  Every project this release creates is stored as Draft v2 at creation, so
  after a rollback it is read-only even if it was never edited. The release
  before refuses this release's field saves as invalid input and never replays
  them, so after a rollback reload open workbench tabs before retrying a save
  whose response was lost.
- After extended tag evidence is stored, never roll back below this release:
  its allowlist drops the added tag fields.
- After metadata lookup jobs run, never roll back below the release before
  them, which ignores their records.
- After MusicBrainz IDs are stored, never roll back below the release before
  them; its index stays, and listener DTOs already drop unknown fields.
- Credit join phrases and Disc Numbers have their own floor in the
  [catalog Credit rollout runbook](../deployment/catalog-credit-rollout-runbook.md#join-phrase-and-disc-number-rollback-floor).

## Metadata lookup

The metadata source layer is a dark launch: no route, capability, worker or Web
control uses it yet, so nothing is sent to any service. It lives in
`src/administration/lookup/`.

- **Sources and hosts.** MusicBrainz (`https://musicbrainz.org/ws/2/` only), the
  iTunes Search API (`https://itunes.apple.com/search` and `/lookup`, in the
  fixed storefronts `jp`, `us`, `kr` and `tw`, ordered by the query's script)
  and Cover Art Archive listings. A listing starts at
  `coverartarchive.org/release/<mbid>` and may redirect only to
  `archive.org/download/mbid-<mbid>/index.json` and then to the same item on an
  `ia….us.archive.org` or `dn….ca.archive.org` storage node, all bound to the
  requested MBID. Any other destination is refused before DNS.
- **User-Agent.** MusicBrainz and Cover Art Archive requests, including the
  archive.org hops, send `Finitude/1.0 ( <contact> )` built from
  `FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT`: 3 to 200 printable ASCII characters
  without parentheses, quotes, backslashes or angle brackets, forming an email
  address or a credential-free `https:` URL on port 443. iTunes Search API
  requests send `Finitude/1.0` alone, because Apple asks for no contact. Lookup
  is unavailable, and sends nothing, while imports are disabled or the contact
  is missing or invalid. The contact is never logged.
- **Pinned fetcher.** `src/administration/adminPinnedHttps.ts`, shared with the
  legacy artwork proxy above. Every hop must be HTTPS on port 443 to a DNS name,
  without credentials or a fragment, whatever the caller's destination policy
  allows. Every DNS answer must be public unicast; the socket is pinned to one
  checked answer and TLS verifies the original hostname. At most three
  redirects are followed, every hop is re-checked, and loops or duplicate
  `Location` fields are refused. Only `Accept`, `Accept-Encoding: identity` and
  `User-Agent` are sent: no cookie, authorization or referrer.
- **Bounds.** One deadline covers DNS, every hop and the body: 10 seconds for
  MusicBrainz and Cover Art Archive, 8 seconds for iTunes. Bodies are capped at
  2 MiB (MusicBrainz), 1 MiB (iTunes) and 256 KiB (listings).
- **Deployment-wide gates.** `adminMetadataLookupGates` holds one `_id`-keyed
  document per source with its next allowed start and expiring leases, decided
  on the MongoDB clock and written outside transactions. MusicBrainz requests
  start at least 1.1 seconds apart with one in flight, iTunes requests at least
  3 seconds apart, and Cover Art Archive admits two at once; a lease expires
  after 30 seconds. Automatic lookups wait for a slot (wait mode), polling about
  once per interval while a lease is held, and report the source as
  `unavailable` after 60 seconds. A submitted lookup (busy mode) sleeps out only
  its own request spacing, so its consecutive requests are paced rather than
  refused. It is reported as `busy` when another request holds the source, when
  a backoff pushed the next start further than one interval, or when another
  lookup took the slot it waited for. A 503 or 429 answer (iTunes also 403)
  pushes the source's next start by its Retry-After (1 to 30 seconds) or by 2
  then 5 seconds; wait mode makes at most three attempts in one call. A gate
  command is bounded to 2 seconds and a release to 1 second, an abort cancels a
  pending command at once, and a grant whose reply was lost is released again.
  A database failure fails closed before anything is sent.
- **Validation.** Responses need an allowlisted content type, identity encoding,
  complete UTF-8 and the complete JSON parser (duplicate keys and nesting deeper
  than 20 rejected), then an allowlisted shape. Unknown fields are dropped;
  wrong types, out-of-bound values, lone surrogates and impossible dates reject
  the whole response. MBIDs, barcodes (GTIN check digit, all-zero rejected),
  ISRCs, iTunes IDs and Cover Art Archive image IDs are format-checked before
  they are sent or compared. A failure is reported as `unavailable`,
  `invalidResponse`, `rateLimited`, `busy`, `cancelled` or `notConfigured`,
  never as an empty result.
- **Cache.** Validated answers, including 404 answers, stay in a process-local
  LRU of 128 entries, 8 MiB and 15 minutes. Failures are never cached.
- **Discarded links.** iTunes preview, track, collection and artist links never
  enter the response shape, so they never reach evidence or fixtures. A
  100-pixel iTunes artwork URL survives only on `is1-ssl.mzstatic.com` through
  `is5-ssl.mzstatic.com`, as internal evidence. Cover Art Archive listings yield
  image IDs, flags, types and sizes, never URLs.
- **Planning and ranking.** Both are pure. The planner turns embedded
  identifiers shared by every file (release MBID, barcode, catalogue number and,
  for one file, an ISRC), then album or song text, then a cleaned folder name
  into at most six MusicBrainz queries. It never accepts file names. Submitted
  text is only normalized (NFC, collapsed whitespace), so a link, a name over
  200 characters or a control or format character is reported instead of
  planned; tag and folder text has format characters removed and control
  characters turned into spaces. Ranking
  pairs files with tracks by Disc Number, Track Number and upload order, or by
  upload order alone when Disc Numbers are missing and Track Numbers repeat.
  Discs are counted and numbered among the media that have tracks, so a DVD
  without a tracklist is not a disc. A candidate matches when the track count,
  any known disc count and every duration agree within 3 seconds, plus 1 second
  for legacy `m:ss` durations. A candidate with any unknown local or
  MusicBrainz duration is unverified and never preselected.
- **Fixtures.** `npm run record:metadata-lookup-fixtures -- --live` re-records
  the trimmed public responses in `test/fixtures/metadataLookup/`. It contacts
  the live services with a recorder User-Agent and the contract rates, so only
  an operator runs it; tests and CI never do. Lookup tests install
  `test/support/networkGuard.ts`, which fails any non-loopback DNS query,
  socket or `fetch`.
