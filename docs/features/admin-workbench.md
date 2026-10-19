# Finitude Administrator Workbench

The private administrator API is mounted at `/api/admin/v1`. It uses the current
persisted `admin` role, same-origin cookie mutation protection, bounded parsers,
account-viewer fencing and `no-store` responses. `GET /capabilities` advertises
admission independently of the normal listener DTOs; `metadataLookup.available`
says only whether metadata lookup is configured, never the contact or why not. Existing catalog edits,
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
the saved value the edit started from. A newer saved version (a later revision,
or automatic values written from file tags or metadata lookup at the same
revision) that changed only other values carries the unsaved edits over, and so
does one that changed an edited value automatically, because an administrator
save always wins over automation; one where another administrator changed an
edited value, or a refused stale save, loads the saved version for comparison.
Compact value comparisons keep source evidence expandable; publication recovery
has its own status and actions. Confirmation windows show the frozen named
target and proposed change before secondary explanations. Technical IDs remain
available in Details rather than leading normal catalog and Page rows.

The Draft section lists the Artist entries in order. Each entry edits its
name, its role (Primary or Featured) and, unless it is last, its join phrase,
and has Move up, Move down and Remove buttons; Add Artist adds an empty
primary entry at the end of the primary group, up to 20 entries. Primary
entries always precede featured ones: a move never crosses that boundary, and
changing a role moves the entry to the last primary or first featured
position, keeping focus on its role. Every add, removal, move and role change
is announced; a move names the entry and its new position and keeps focus on
the moved entry, an added entry takes focus, and a removal moves focus to the
nearest remaining entry; the same message twice in a row is announced again.
A move keeps each join phrase in its position, so swapping the first two names
of "A & B feat. C" gives "B & A feat. C"; a role change carries the entry's
phrase with it, and the entry an add, removal, move or role change leaves last
loses its phrase. A move, role change or join phrase edit keeps the entry's
key and name, so its saved Artist decision still applies; a rename or removal
drops that decision when saved, but clearing a name keeps the entry, so
retyping the exact saved name keeps the decision. A MusicBrainz ID on an entry
or the label stays only while its name matches the saved one
case-insensitively. An edited entry list or label that the server would refuse
(an empty name, a name repeated case-insensitively, where every entry sharing
it is marked, control or invisible formatting characters left after trimming,
more than 200 characters after normalization, an invalid join phrase) blocks
Save with its message; an empty name is marked only after its field loses
focus or a Save attempt, and unedited saved values are not checked. When no
entry is primary, a note says publishing a new Album needs at least one
primary entry (an append needs none); Save stays available. The entries save as one
`album.artists` change. The label is one Organization name saved as
`album.label`, and an empty label saves none. Each track edits its Disc Number
beside its Track Number. A saved value written automatically from file tags and
not yet reviewed (in `automaticPaths` but not `lookupPaths`) shows "From file
tags" in the visible and accessible label of the Album title, the release date, the Artist entries, the
label and each track's title, Disc Number and Track Number, until that value is
edited; an automatic Artist entry whose name looks like a company says "This
name looks like a label". In Files, a file whose tags had values left out says
how many beside its tag evidence. Once a staged image is ready, the cover
choice offers No cover and each ready image, manual or embedded. While the
choice is automatic, a note says so and only the image chosen automatically is
checked (nothing is checked when no image is); choosing any option, No cover
and the image already chosen automatically included, makes the choice explicit
for good.
Review shows an Artist suggestion as its byline
followed by each entry with its role. Review's existing-content check has one
Artist row per entry, in draft order and named with its role, and a Label row
when the draft has a label; each row lists only the candidates found for its
own name. Review loads the candidates when it opens, and Find matches reads
them again. A row without an explicit decision that the review preselects is
collapsed, reads "Preselected as new" or "Preselected to reuse" a named member,
and needs no answer: an Artist entry, the label or the Album without a name
candidate of its kind is preselected as new, and so is every track once the
Album is new (explicitly or preselected). When the Album row reuses an existing
Album, a file whose verified bytes match exactly one member of that Album, which
no other file matches and no other decision reuses, is preselected to reuse it,
and a file matching no member by bytes or title is preselected as a new member;
a title-only match, ambiguous bytes or an incomplete member list
(`memberMatchesComplete` false) needs an explicit choice. So does a row whose
name matches a record too malformed to be a candidate (listed in `unavailable`),
which offers create but no reuse. A file whose bytes match a ready MediaTrack
outside the append target (on another Album or on none) is flagged as a
possible duplicate and never collapsed, but needs no answer and changes no
preselection: a file with no candidate on the target is preselected as a new
member even when its title or bytes match a Track on another Album. Any other
row stays expanded until answered. An explicit choice, made inside a collapsed
row too, always wins; the empty choice reads "Keep the preselected choice"
while the row has a preselection to return to, answered or not, and choosing it
collapses the row again with the focus on its summary. Saving sends only
explicit decisions.
An Artist that another entry already reuses cannot be chosen again,
and a save in which two entries reuse the same Artist is refused. While the
Album row reuses an existing Album, each Artist and Label row says it is not
applied and needs no decision, and Publish notes that the draft's Album title,
release date, visibility, cover, Artist entries and label are not applied: the
new tracks take that Album's primary Artists, track order and visibility. A
completed import links to its Album, each of its Artists and its label
Organization.

The import page opens on the **Review and publish** summary, above its Draft,
Review, Files and Publish sections, which stay available for manual work. It
reads `GET /imports/:id/lookup` (the lookup view and the server's summary state,
see [Lookup routes](#lookup-routes)) again whenever the project's revision or
automatic values change, every 3 seconds while a lookup is queued or running
or waits on a busy source (`sourceBusy`, whose throttled first retry comes
within seconds), and every 10 seconds while it waits out an outage; a read that sees a
newer saved project reloads the page's project read. The summary components
(`ImportSummary.tsx`, `LookupBox.tsx`, `CandidateChooser.tsx` and the shared
`ImportAnalysisConfirmation.tsx`) load lazily from the media panel, outside the
import route's initial JavaScript. The server decides what holds Publish; the
summary only presents it:

- **Status and next step.** Not run yet while uploads are awaited, not run
  although every needed file is uploaded (its automatic trigger failed; Luna
  next, beside the name box), looking up (queued or running), retrying (busy or
  unavailable, next step the free **Retry lookup**, Luna beside it),
  unavailable after the automatic retries (next step **Analyze with Luna**, the
  retry beside it), not configured (Luna next), stopped (retry first, Luna
  beside it), superseded, no release or nothing to look up (Luna next, beside
  the name box), no matching release or none applied where nothing matched
  (Luna next; every candidate stays choosable), release details that could not
  be fetched (retry first, Luna beside it), a tie (no next step), one
  matching release from a partial comparison that was not applied (no next
  step; choosing it, another release or none is optional), or the applied
  release.
  Where the server cannot run lookup (`lookupAvailable` false) the summary says
  it is not configured, before any run too, and offers neither a retry nor the
  name box. Stale files are counted.
- **Name box.** An Album or song name; a folder-name run prefills the folder
  name for editing, a submitted run its name. A link is refused in place
  (`Enter a name, not a link`), and the box has no autocomplete and stores
  nothing. It is a plain form, never the search landmark, and the
  administration layout still has no global search.
- **Needs an answer.** A tie lists each group's representative with only the
  proposal values that differ (title, Artist entries, label, date, tracks) and
  its barcode, catalogue number, country and medium, plus **Use none of
  these**; a conflict with the administrator's own value shows both values with
  **Keep mine** and **Use lookup value** (`/lookup/resolve` bound to the saved
  value). Identity questions stay in Review and the confirmation; the summary
  counts the rows the server says still need one. The candidate chooser
  discloses how many files have an unknown duration or Disc Number, which
  ranking never counts as agreement, and says when not every release
  MusicBrainz found was compared with the files.
- **Offered, not needed.** The only matching group of a partial comparison
  (see Planning and ranking under [Metadata lookup](#metadata-lookup)) is not
  applied, since more matching releases may exist among those not compared.
  Until a release or none is chosen for that run, the chooser shows it like a
  tie, with every proposal value and **Use none of these**, but it is no tie:
  it is not counted as an answer and never holds Publish. A release applied as
  a preselection stays choosable while a tie needs an answer, so a re-rank
  that leaves a tie can be answered with it.
- **Flagged, never folded.** Values resting only on file tags (automatic and
  not on the applied candidate), a preselection whose artist matches no artist
  tag, and pending Luna suggestions with their ticks.
- **Folded.** Every other row: title, Artist entries with roles and join
  phrases, label, date, visibility (changed in place by a field save, public by
  default), cover (one chosen automatically says so), the disc and track
  order, saved identity decisions, upload progress, answered conflicts, and
  all candidates when there is no tie. An append marks the Album values, their
  conflicts and Album Luna suggestions not applied.
- **Publish.** Disabled while the server says it waits for uploads, lookup or
  analysis or this browser is still uploading, while a tie, a conflict or an
  identity row (`identityAnswers`) needs an answer, or while a new Album's
  credit rests only on a placeholder (said at once, unless the unsaved changes
  Publish includes add a primary Artist entry); otherwise it opens the same
  one-step confirmation as the Publish section.
- **Luna ticks.** The summary state gives each pending suggestion the editor
  shows a tick state: `ticked` for an empty value or one resting only on file
  tags, `unticked` for any other, `resolved` when it already equals the current
  value (Artist entries by name, role and join phrase), or `conflict` when its
  value changed since analysis and is the administrator's own (Artist entries
  whenever they changed), which cannot be ticked. Toggles are kept in the
  workspace for the confirmation; unticking leaves the current value, and
  **Apply ticked suggestions now** accepts the ticked ones and rejects the rest
  through `/adopt`. A ticked suggestion that renames the Album or the Artist
  entries has no candidate read yet, so its rows need a decision in the
  confirmation; there the confirmation offers the same **Apply ticked
  suggestions now**, which saves them to the draft and closes it, so the next
  confirmation reads candidates, and preselects, for the saved names. A
  suggestion equal to the current value is hidden from the summary but stays
  pending in storage, and Review still lists it as already matching, until an
  approval accepts it. **Analyze with Luna** opens the same confirmation as the
  Draft section's Analyze, which shows the runs and AI calls left for the
  project and the AI calls left today and starts nothing until confirmed.
- **Refusals.** Each lookup refusal (`ADMIN_IMPORT_LOOKUP_ACTIVE`,
  `…_UNAVAILABLE`, `…_REFUSED`, `…_INVALID_NAME`, `…_NOTHING_TO_RETRY`,
  `…_STALE`, `…_CANDIDATE_INCOMPLETE`) has its own message, is never
  retried, and reloads the project and the summary.

Publishing is one step. Publish stays available while the draft has unsaved
edits, while cover selection, file removal and cancelling an approval still wait
for a save. Review decisions cannot change while the draft has unsaved edits, so
make them before editing. Review's unsaved decisions survive later field
saves, uploads, Luna and automatic values; they conflict, and cannot be saved
until the saved decisions are loaded, once an entry or the label they decide
was renamed or another save stored decisions after their first edit. Review
reads its name matches again after automatic values change the names they
match. Its confirmation lists the title, the byline and each
Artist entry with its role and join phrase, the label or No label, the date, the
visibility, the cover, and the identity of the Album, each entry and the label:
New, Reuses a named record (marked Hidden when it is), Needs a decision, Match
changed (the reused record is not listed at its reviewed revision), or Not
applied for an append, whose title, date, visibility and cover rows say so too.
Pending Luna suggestions are written into the shown draft as the summary
ticks them (a suggestion whose path the unsaved changes also write stays
unticked), and a row a ticked suggestion renames needs a decision like an
unsaved rename. A Luna row counts the suggestions applied and kept.
The tracks the approval adds follow in approved order, Disc Number (unknown as
1), then Track Number (unknown last), then draft order, followed by an existing
Album's members, named by their catalog title (or draft title while the match
changed) without a position, which the append leaves unchanged; skipped tracks
are left out. The confirmation always reads the duplicate candidates, since
the preselections depend on them, and a row without an explicit decision shows
its preselection as New or Reuses; a row renamed in the unsaved draft (an entry,
the label, the Album title or, in an append, a track title) is not preselected,
because its candidates were read for the saved name. The approval carries the
preselections the confirmation shows, so the server freezes exactly those or
asks for a fresh review. The Artist entries and the
label are marked "From file tags only" while they are automatic, not written
by metadata lookup (`lookupPaths`), and the
approval neither changes them nor shows an explicit identity decision for them,
saved or unsaved (never for an append; a preselection is not one), and an
automatic entry named like a company says it may be a label.
Approve stays disabled while the candidates load, reload or fail, while any row
is neither answered nor preselected, or holds a changed match, and while
Review's unsaved decisions are in conflict as described above. Only a changed
approval digest makes an open confirmation stale, so Luna, uploads and
automatic values that change nothing it shows leave it current. Approving
sends the unsaved changes, Review's unsaved decisions and the summary's Luna
ticks with the approval; a refused approval keeps all three, and a confirmed one
leaves the editor showing the saved draft. If the Web was updated after the page
loaded and the confirmation cannot load its checklist, it asks for a reload and
Approve stays disabled, while the page and its unsaved edits stay open.

The workbench is Web-only. Finitude iOS and Android expose listener features even
for administrator accounts; they do not load administrator capabilities, private
previews, import/catalog/Page editors or upload controls.

<!-- @catalog -->
**Contents**

- [Device-local MP3 conversion](#device-local-mp3-conversion)
- [Tag evidence and automatic values](#tag-evidence-and-automatic-values)
- [Import format compatibility](#import-format-compatibility)
  - [Rollback floors](#rollback-floors)
- [Metadata lookup](#metadata-lookup)
  - [Lookup runs](#lookup-runs)
  - [Triggers and grants](#triggers-and-grants)
  - [Value application](#value-application)
  - [Lookup routes](#lookup-routes)
  - [What lookup sends](#what-lookup-sends)
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
  `artists` suggestion proposes the whole entry list. A decision is
  `{scope, slotId, entryKey, boundName, action, candidateId,
  candidateRevision}`, where `scope` is `artist`, `label`, `album` or `track`,
  `slotId` names the track of a `track` decision, `entryKey` the entry of an
  `artist` decision, and `boundName` the entry or label name an `artist` or
  `label` decision was made for, each `null` otherwise. An Artist decision is
  returned only while its entry keeps its key and name, and a label decision
  only while the label keeps its name. `published` stays `null` until the
  publication is complete, then is `{albumId, artistIds, organizationId,
  trackIds}`: the Artist of
  every entry in draft order and the label's Organization or `null`, or for
  an append the target Album's primary Artists and `null`. An approval frozen
  in format 1 or 2 reads as `artistIds: [artistId]` and
  `organizationId: null`. A project still stored in format 1 reads as its
  Draft v2 view. Value origins (`draftOrigins`) are stored, keyed by value
  path with `:` in place of `.` (`album:title`, `tracks:<slotId>:discNumber`),
  because MongoDB before 5.0 refuses dotted field names; they are returned only
  as markers. `automaticPaths` lists the value paths written from file tags or
  metadata lookup and not yet reviewed, in draft path order, so an unsaved edit
  carries over every automatic write; `lookupPaths` lists those of them whose
  value equals one the applied metadata lookup candidate wrote (the others
  rest on file tags); `possibleLabelEntryKeys` lists the automatic Artist
  entries that rest only on file tags and whose names look like a company (a
  possible label); and `valueRevision` counts the automatic writes, which
  never change `revision`. Each asset's `tags` is the tag evidence described under
  [Tag evidence and automatic values](#tag-evidence-and-automatic-values).
  `selectedCoverSlotId` is the selected staged image or `null`; `coverChoice`
  is `automatic` until an administrator chooses (`/select-cover`, or an
  approval saving a cover its own decisions would not select automatically;
  see `POST /imports/:id/publish`) and `explicit` after (see
  `POST /imports/:id/select-cover`). A stored `selectedCoverSlotId`, including
  those saved by earlier releases and by every earlier one-step approval, is
  explicit. Once a publication is active or complete, an automatic choice shows
  the cover that publication froze (none for an append). The v1 projection
  shows the same `selectedCoverSlotId` without `coverChoice`.
  `approvalDigest` is the SHA-256 hex digest of the key-sorted JSON of what a
  publication confirmation shows from the saved project: the Draft v2 view, the
  returned decisions with their bound names, the selected cover
  (`selectedCoverSlotId`, automatic or explicit), each
  returned asset's `slotId`, `state` and `sha256`, and whether the Artist
  entries and the label rest only on file tags (automatic values equal to a
  value the applied metadata lookup candidate wrote do not). Actor,
  capabilities, receipts,
  `revision`, `valueRevision`, analysis and suggestions do not count, and a
  format-1 project digests as its Draft v2 view, so converting it keeps the
  digest. A
  publish body echoes it; the Web never computes it.
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
  admitted at any project revision up to the current one. A path is stale
  only when its stored value differs from both `base` and `value` and is the
  administrator's own (a stored
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
  always asked to reload. The JSON limit is 160 KB for this route, 192 KB for
  `POST /imports/:id/publish` and 96 KB for the other import routes.
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
  An import change is admitted at any `expectedRevision` from the latest
  receipt (ordinary or recovery) of the kinds it binds up to the current
  revision; a higher one is `409 ADMIN_IMPORT_REVISION_CONFLICT`.
  `/adopt` binds the generation and each suggestion's baseline, so it takes
  any revision; `/decisions` binds each bound name and the last saved
  decisions (a `decisions` or `publish` receipt); `/cancel-analysis` binds the
  generation its `analyze` receipt started; and `/analyze`, staged cleanup and
  `/cancel-publication` bind the last administrator receipt of any kind. Luna
  ticks, upload transfers, publication-worker checkpoints, embedded staging
  and automatic values add no such receipt, so they never make a change
  stale, while another administrator's change of what it binds still does:
  a decision set built before another administrator's saved decisions, or a
  stop issued before another administrator's re-analysis, is refused with
  `409 ADMIN_IMPORT_REVISION_CONFLICT` and writes nothing. `expectedRevision`
  stays required and in every intent's fingerprint, and receipt lookup comes
  first, so an earlier intent with a numeric `expectedRevision` still replays.
  Luna still reads the v1 view of the Draft v2 baseline, whose first primary
  entry is `artistName`, and its Artist name becomes a one-entry primary
  `artists` suggestion; a name with control or format characters is dropped.
  An accepted suggestion becomes the administrator's own; accepting one whose
  baseline is no longer the current value returns
  `409 ADMIN_IMPORT_FIELD_CONFLICT`, so an Artist suggestion never replaces
  entries that changed since its baseline, automatic ones included, while any
  other current value written automatically (from file tags or metadata lookup)
  after that baseline is replaced, as a field save would replace it. Accepting an `artists`
  suggestion keeps the decisions of the entries whose key and name it leaves
  unchanged. Imports never suggest
  a stand-in Artist: a Luna Artist name such as Various Artists or `[unknown]`
  is dropped, and a stored one is hidden, never holds the approval and is not
  counted as pending in the workbench list. Accepting a suggestion the editor
  does not show, such as that hidden one, returns
  `409 ADMIN_IMPORT_SUGGESTION_STALE`; rejecting it is allowed.
  `/decisions` replaces the whole list with at most 122 decisions, at most one
  per Artist entry, the label, the Album and each track, and each decision
  must be one flat record of at most 1 KB before the intent is fingerprinted.
  An `artist` decision binds the entry its `entryKey` names and that entry's
  name; a `label` decision binds the label's name. Each carries the name it was
  made for as `boundName` (`null` for `album` and `track` decisions, otherwise
  `400 ADMIN_IMPORT_INVALID_INPUT`), and a `boundName` that is not exactly the
  saved entry or label name means the decision was made for a value since
  renamed: `409 ADMIN_IMPORT_DECISION_STALE`, nothing written, also while
  appending. An `artist` decision for an
  entry the draft does not have, a `label` decision without a label, or two
  entries reusing one Artist is `400 ADMIN_IMPORT_INVALID_INPUT` and writes
  nothing. A reuse names a ready record at its reviewed revision, for the label
  an Organization of any type, or the save is
  `409 ADMIN_IMPORT_DUPLICATE_STALE`; while the Album decision appends, an
  entry's or the label's reuse is kept without that check, since an append
  applies neither. A body whose decisions lack `entryKey` or `boundName`
  comes from an editor that predates several entries or bound names and
  returns `409 ADMIN_IMPORT_RELOAD_REQUIRED` right after receipt lookup, so a
  lost response of an older body still replays. A reuse or create-distinct
  decision makes the Artist entries, or the label, the administrator's own; a
  skip does
  not. Unless the Album decision appends, publishing needs a reuse or
  create-distinct decision still bound to every entry and to the label unless
  the review preselects it (no name candidate, see `/publish`), so renaming an
  entry or the label to a name that has a candidate makes publishing return
  `409 ADMIN_IMPORT_REVIEW_REQUIRED` until it is decided again. A preselection
  is never saved: a body item carrying `preselected` is invalid input.
- `GET /imports/:id/duplicate-candidates`: bounded candidates; a name match is
  never verified identity or automatic reuse. Candidates are read from the
  Draft v2 view, and each distinct Artist entry name and the label's name are
  matched on their own, exactly and case-insensitively: at most 20 ready
  Artists per name (kind `artist`) and 20 ready Organizations of any type for
  the label (kind `organization`, `albumId` `null`), beside at most 20 Album
  and 20 Track title candidates. Verified byte matches are read on their own:
  for each staged file's hash, the first ready Track outside the saved append
  target whose stored hash is bound to its current object, so at most 100, and
  no number of same-title Tracks hides one. Every ready Track on an Album
  candidate or on the saved append target whose verified bytes or exact title
  match a staged file is then added once (the global Track rows could leave it
  out), at most 300 of them, so at most 860 items. `memberMatchesComplete` is
  `false` when more such member matches exist or one of them is malformed; the
  Web then preselects no append file. `unavailable` lists `{kind, label}` for
  each entry name, the label or the Album title (at most 22) whose same-name
  record is malformed (a stored visibility other than public or hidden): it is
  no selectable candidate, but its row is never preselected. Names compare
  after NFC normalization and locale-independent lower-casing. All reads of one
  request share a 10-second budget, each query at most 3 seconds. The editor
  loads this on opening Review and with every publication confirmation.
- `POST /imports/:id/assets/:slotId`: one multipart `file`; `Idempotency-Key`
  and numeric `If-Match` form the upload intent, which reserves its private
  object identity before S3 work. Admission binds slot state and that intent,
  not the project revision: the slot must hold no asset other than a deleted
  or confirmed-failed one, which moves to the slot's history, and no
  publication may lock the sources. `If-Match` stays in the intent hash, so a
  replay of the original intent still matches its receipt, and only the
  administrator who started an upload may replay it. Analysis checkpoints,
  draft saves, automatic values, completed uploads and embedded staging never
  make a queued upload stale. A transfer error leaves the asset unknown; only
  reconciliation confirms a failure. A confirmed audio upload, including a
  replay of an intent already confirmed, then runs tag automation and the
  metadata lookup trigger (see [Triggers and grants](#triggers-and-grants)).
  `slotId=cover` is the independent manual cover slot.
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
  evidence intact. A ready result, found now or earlier, runs tag automation
  as the reconciling administrator; an audio upload that this reconciliation
  itself confirms also runs the metadata lookup trigger as that administrator.
- `DELETE /imports/:id/assets/:slotId`: explicit staged cleanup with the same
  operation headers; unknown/failed cleanup retains lifecycle evidence. An
  unresolved upload (pending, unknown, or a failure reconciliation has not
  confirmed) can be removed only after its transfer deadline, so no late
  `PUT` can leave an untracked object. `If-Match` must not predate the last
  administrator receipt, so a removal confirmed before another
  administrator's upload, removal or other change is refused, while upload
  transfers, Luna and publication progress never refuse it. Admitting the
  removal of a file that a lookup run bound lists its slot in `staleSlotIds`
  and supersedes that run while it is active (see
  [Triggers and grants](#triggers-and-grants)).
- `POST /imports/:id/select-cover`: explicitly choose a ready manual or embedded
  artwork slot, or `null` for No cover. Choosing makes the cover choice explicit
  for good; nothing turns it back to automatic. Until then the choice is
  automatic: each audio upload records at admission the SHA-256 of its validated
  embedded front image, or none, and the import selects the ready `embedded-*`
  candidate, first in manifest order, of the one image every confirmed audio
  file carries, ignoring files whose saved track decision is `skip` (they
  become no track). It selects nothing when such a file carries none, carries
  another image or has no evidence (an upload admitted before automatic covers
  has evidence only through its own per-file candidate), when that image has no
  ready candidate (the staging bound kept it out, its staging is unresolved, or
  the candidate was removed), or when the saved Album decision is `reuse` or
  `skip`. The automatic choice is stored nowhere and recomputed on every read,
  so a changed file set (an upload, a reconcile, a removal or a replacement)
  re-evaluates it. Uploading a manual cover never selects it. A choice binds the
  cover state the administrator saw: `expectedRevision` must not predate the
  last cover selection, approval or staged cleanup, and a chosen slot must hold
  a ready image admitted no later than that revision, so a stale tab never
  overwrites another administrator's choice or selects a replaced image unseen
  (`409 ADMIN_IMPORT_REVISION_CONFLICT`). Uploads of other slots, Luna,
  automation and worker steps never make it stale.
- `GET /imports/:id/assets/:slotId/preview`: protected staged artwork preview.
- `GET /imports/:id/lookup` and `POST /imports/:id/lookup`, `/lookup/retry`,
  `/lookup/choose` and `/lookup/resolve`: the import's metadata lookup view, a
  submitted name, a manual retry, a candidate choice and conflict answers (see
  [Lookup routes](#lookup-routes)).
- `POST /imports/:id/publish`: explicit reviewed approval, then asynchronous
  fixed-identity publication; `/resume-publication` reconciles that approval's
  original operation ID rather than creating another Album. The body is
  `{operationId, expectedRevision, changes, decisions, selectedCoverSlotId,
  approvalDigest, suggestionTicks}`: the confirmation's unsaved field changes
  in the `PATCH` shape (possibly none), the whole decision set it shows in the
  `/decisions` shape, the cover it shows (`null` or a staged slot, which the
  approval freezes), the
  `approvalDigest` of the saved project it was built on and the Luna ticks it
  shows (below); each decision carries its `boundName`. The Web also sends
  the optional `preselections`: the rows the confirmation shows as
  preselected, each in the decision shape without
  `preselected`. Before the intent is fingerprinted,
  `changes` and `decisions` are bounded as `PATCH` and `/decisions` bound them
  (so two entries reusing one Artist are refused here), the cover and
  digest to 64 characters, and `preselections` to at most 122 well-formed
  items (each identifier at most 300 characters or `null`, `action`
  `create-distinct` or `reuse`), or the body is
  `400 ADMIN_IMPORT_INVALID_INPUT`. The Web always sends `suggestionTicks`
  `{generation, ticked, unticked}`: the analysis generation and every pending
  suggestion it shows, ticked or unticked, at most 204 distinct suggestion IDs
  in all, bounded the same way.
  One transaction under one ordinary `publish` receipt then saves and freezes
  the approval. It is admitted at any project revision up to the current one:
  `approvalDigest` is its binding, so Luna, the publication worker and
  automatic values that change nothing the confirmation shows never make it
  stale. After receipt lookup, the publication-lock, operation-limit,
  publication-readiness and approval-limit checks, a body missing any of the
  four fields or whose digest is not 64 lowercase hex characters is
  `400 ADMIN_IMPORT_INVALID_INPUT`, and a digest that no longer matches the
  saved project is `409 ADMIN_IMPORT_APPROVAL_STALE`. The decisions are then
  saved against the saved names exactly as `/decisions` saves them (a stale
  `boundName` is `409 ADMIN_IMPORT_DECISION_STALE`), the
  changes as `PATCH` saves them, decisions whose entry or label the changes
  renamed or removed are dropped (so that entry needs a new decision,
  `409 ADMIN_IMPORT_REVIEW_REQUIRED`), and the cover as `/select-cover` saves
  it (`409 ADMIN_IMPORT_ASSET_CONFLICT` unless it is no cover or a ready image),
  before the checks below run and the approval is frozen. A cover equal to the
  automatic selection the saved project showed, which the approval's own
  decisions still select or which they append, is not saved as a choice, so it
  stays automatic; any other cover is saved as an explicit choice (for example
  No cover shown for a saved `skip` that the approval changes to a new Album).
  The approval freezes the cover it shows (an append freezes no cover). A
  body with none of the four fields comes from an editor that predates one-step
  approval, and one whose decisions lack `entryKey` or `boundName` from one that
  predates bound names: a lost response replays its stored receipt, and a new
  one is `409 ADMIN_IMPORT_RELOAD_REQUIRED` right after receipt lookup, before
  the lock, limit and format-1 conversion. Rolled back below the release that
  introduced one-step approval, a one-step body is refused before receipt
  lookup (`400 ADMIN_IMPORT_INVALID_INPUT`, or `413` when it exceeds that
  release's 96 KB JSON limit) and never replays; what it saved is the same
  Draft v2 draft, decisions, cover and format-3 approval that `PATCH`,
  `/decisions`, `/select-cover` and the release before one-step approval
  write, so it reads there as that release's own and below it as described
  under [Rollback floors](#rollback-floors). A refusal writes no approval,
  receipt, revision, draft, origin, decision, cover or conversion, so a
  failed approval leaves at most the previously saved draft. Every approval
  needs an Album
  title, and a new Album also at least one primary Artist entry, or it is
  `400 ADMIN_IMPORT_DRAFT_INCOMPLETE` before anything is frozen. A new Album's
  entries and label need the decisions described under `/decisions` or a
  preselection that still holds when the approval reads the candidates again
  (`409 ADMIN_IMPORT_REVIEW_REQUIRED`), and a reused Artist or Organization
  must still be ready at its reviewed revision
  (`409 ADMIN_IMPORT_DUPLICATE_STALE`). An append needs neither a primary entry
  nor those decisions: its target Album must still hold a primary Artist
  Credit, or the approval is `409 ADMIN_IMPORT_APPEND_PRIMARY_REQUIRED`, which
  the Web shows as its own message without a retry, and those Artists must be
  ready (`409 ADMIN_IMPORT_DUPLICATE_STALE`). The draft's Album values,
  visibility, Artist entries, label and cover are not applied to an append,
  and a selected cover is not copied. The appended tracks follow that Album's
  visibility: they are stored public and the Album hides them while it is
  hidden, so a draft visibility that differs is no longer refused. Rolled back
  below the release that publishes several Artist entries and labels, every
  append again needs the draft visibility to equal the target Album's
  (`409 ADMIN_IMPORT_APPEND_VISIBILITY_MISMATCH`), and a draft with several
  Artist entries or a label is again refused with
  `409 ADMIN_IMPORT_PUBLICATION_UNSUPPORTED`.
  Right after the changes are saved, the tick state is applied
  (`adminImportLunaTicks.ts`): each pending suggestion the editor shows that
  does not already equal its current value must be listed as ticked or
  unticked (`409 ADMIN_IMPORT_REVIEW_REQUIRED` otherwise), each listed one must
  still be shown pending in that generation
  (`409 ADMIN_IMPORT_SUGGESTION_STALE`), and a ticked one whose value changed
  since analysis is `409 ADMIN_IMPORT_FIELD_CONFLICT`. Ticked suggestions are
  accepted as `/adopt` accepts them, unticked ones rejected and resolved ones
  accepted, in the same transaction, so identities are read for the values
  they write. A body without `suggestionTicks` comes from an editor that
  predates ticks: it is admitted only when nothing is left to answer, and
  otherwise is `409 ADMIN_IMPORT_RELOAD_REQUIRED`. Pending suggestions never
  hold the approval; a queued or running analysis still does
  (`409 ADMIN_IMPORT_REVIEW_REQUIRED`). A stored value the editor cannot show
  (it reads as empty there) is also `400 ADMIN_IMPORT_DRAFT_INCOMPLETE`, so it
  is never frozen. Metadata lookup holds it too, read in the
  same transaction: a queued, running or automatically retrying lookup is
  `409 ADMIN_IMPORT_LOOKUP_ACTIVE`, and an unanswered tie or conflict (see
  [Value application](#value-application)) is
  `409 ADMIN_IMPORT_REVIEW_REQUIRED`, checked against the draft the approval
  saved, so a change that makes a conflict equal answers it. An append ignores
  conflicts on Album values. A stopped, unavailable, superseded or completed
  run never holds it as active; a tie of the current run or an unanswered
  conflict of the applied candidate still does, whatever the current run's
  state. An admitted approval writes the lookup fence. The approval freezes the Draft v2
  snapshot with `schemaVersion` 3, its decisions, including each preselection
  it applied, and, for each Artist entry and the label, the reviewed record to
  reuse or an ID reserved for a new one,
  so a retry or resume never mints another identity. `artists` lists
  `{entryKey, artistId, newArtist, candidateRevision}` in Credit order, for an
  append the target Album's primary Artists with `entryKey` `null`; `label` is
  `{organizationId, newOrganization, candidateRevision}` or `null`; and the
  top-level `artistId` and `newArtist` mirror the first Artist. The approval
  makes every draft value the administrator's own; each entry's join phrase
  is kept on its Album Credit, and on a MediaTrack's Credit only while the
  next Album Credit is also a primary. No route returns
  `ADMIN_IMPORT_PUBLICATION_UNSUPPORTED` any more; the worker keeps it only as
  its internal signal for an approval format it cannot commit
  (`unsupportedVersion`).
  Inside the same transaction the approval reads the duplicate candidates again
  and computes the rows the review preselects (see Review): a row neither
  answered nor still preselected, because a candidate appeared since review, is
  `409 ADMIN_IMPORT_REVIEW_REQUIRED` and writes nothing, while a lost-response
  replay finds its receipt first. When the body carries `preselections`, any
  other set of computed preselections, candidate revisions included, is the
  same `409 ADMIN_IMPORT_REVIEW_REQUIRED`: an append file shown as a new member
  is never frozen as a reuse, or the reverse, even when a member's verified
  bytes changed without changing the target Album's revision. A body without
  them freezes what the approval computes. The saved decisions stay explicit;
  the frozen `decisions` add each preselection marked `preselected: true`,
  which is never a saved decision, request item or DTO field. Before the first
  copy and again inside the commit transaction, the worker recomputes the
  preselections of a format-3 approval from its frozen snapshot, its frozen
  explicit decisions and fresh candidates; a frozen one that no longer holds
  makes the publication needs attention (internal issue `identityConflict`,
  not projected, like `catalogConflict`) without minting identities, the
  copies already made stay recorded in the publication for cancellation and
  cleanup, and resuming checks again. A format-3 decision list in another
  shape, or candidate reads over their time budget, are a resumable catalog
  conflict (`catalogConflict`), never a passed recheck or an unknown storage
  outcome. No route returns the internal `ADMIN_IMPORT_IDENTITY_CONFLICT`. Every
  format-3 commit also increments one identity-fence document
  (`adminImportAnalysisSlots`, `_id` `identity`, created at startup), so
  concurrent format-3 import commits serialize and a later one rechecks against
  the records an earlier one created. The fence covers only those commits: a
  record that a format-1 or format-2 commit, the Admin Catalog or the Content
  Manager creates concurrently with a commit is not rechecked, since names are
  never identity keys.
- `POST /imports/:id/cancel-publication`: explicit cancellation with
  `{operationId, expectedRevision, publicationOperationId}`. The new operation
  UUID binds the exact original publication UUID, and `expectedRevision` must
  not predate the last administrator receipt, so publication-worker
  checkpoints never make a cancellation stale. The Web keeps an open
  cancellation or removal confirmation current until a newer receipt
  appears. An active worker lease or a completed publication rejects
  cancellation. The private response includes
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
edits, decisions and the approval. An approval takes one ordinary receipt,
including the draft changes, decisions, cover and Luna answers it saves.
Required asset cleanup and publication cancellation use separate lifecycle
receipts tied to each admitted asset version or approved publication,
preserving exact replay and UUID-collision checks without consuming the
ordinary mutation allowance.
Automatic embedded-cover staging, which follows a ready audio upload, likewise
has its own bounded lifecycle receipts. An embedded image whose SHA-256 matches
one that is ready, pending or of unknown outcome is not staged again, and each
import makes at most 16 automatic embedded stagings (automatic cleanups do not
count). A replaced file's image goes in that file's own `embedded-<slotId>`
slot. When the slot still holds the candidate the earlier upload staged under
an automatic receipt, that candidate is first cleaned up through the cleanup
lifecycle like a completed import's (below, with the uploader as actor),
unless it is explicitly chosen, pinned, still settling, or holds an image
another file's current upload carries; the new image is then staged once it is
deleted. Otherwise the new image is not staged, and a failed cleanup needs
attention. A later staging of that slot resumes a cleanup that stopped before
deleting. Embedded assets that an earlier release staged under ordinary
receipts keep them and their existing lifecycle until the import completes,
when unselected ones are cleaned up like any automatic candidate (below).
Automatic values written from file tags and automatic metadata lookup runs and
applications take no receipt of either kind, so they use neither the 256
ordinary receipts nor the 16 automatic embedded stagings. A submitted lookup, a manual retry, a choice and conflict answers each
take one ordinary receipt (`lookup`, `lookup-retry`, `lookup-choose`,
`lookup-resolve`), which only the Draft v2 detail lists.
The client receives a bounded recent receipt projection; the original publication
UUID remains available through `publicationRecovery` for durable reconciliation.

**Automatic cover cleanup.** Once an import completes, each automatically
staged `embedded-*` candidate is cleaned up through the staged cleanup
lifecycle unless it is the published cover (which is where an approved
automatic cover lives), an explicitly chosen cover, pinned by an
existing-catalog cover operation (`coverConsumers`), or already being cleaned
or removed. That includes the per-file duplicates that releases before
embedded deduplication staged, and imports completed before automatic cleanup
existed; an image the files would select automatically but the publication
never used, such as the first of those duplicates, is cleaned too. A manual
cover is never cleaned automatically. The automatic choice is computed in
`src/administration/import/adminImportCoverAutomation.ts`, and this cleanup
runs in `adminImportCoverCleanup.ts` beside it.

- **Reservation.** Right after its commit, the publication worker reserves the
  candidates as a system lifecycle step with no role fence that deletes
  nothing. Each becomes `deleting` with a cleanup `recovery` naming the
  publisher, under an operation ID derived from the candidate version. Each
  takes one `cleanup` receipt among the automatic lifecycle receipts, never an
  ordinary or recovery receipt, so it uses neither allowance and the detail
  lists none of them.
- **Deletion.** Each candidate is then deleted under the publisher's fresh
  administrator check, exactly as `DELETE /imports/:id/assets/:slotId`
  deletes.
- **Failure.** A failed deletion, including one after the publisher lost the
  role, leaves the candidate `cleanupFailed`, which counts as needs attention.
  Nothing retries it automatically. Any current administrator retries it with
  `DELETE …/assets/:slotId` carrying the asset's `recovery` (its `operationId`
  as `Idempotency-Key` and its `expectedRevision` as `If-Match`); that replays
  the automatic receipt and deletes under the retrying administrator's own
  check, adding no receipt.
- **Waits and pins.** A candidate whose staging may still land (pending or
  unknown before its transfer deadline, or leased) waits until it settles. A
  pinned candidate is kept, and releasing the pin re-arms the cleanup; the
  sweep also checks a pinned candidate again a day later, so a release whose
  pin release does not re-arm it never strands it.
- **Sweep.** A completed import keeps its cleanup state in
  `media.coverCleanup`, which is never projected and never changes `revision`.
  On ticks that publish nothing, the publication worker sweeps the oldest
  completed import whose cleanup is not done, which covers crash recovery,
  waiting and re-armed candidates, and imports completed before this release.
  It skips projects saved in a newer draft format, and looks again a day later
  at an approval format this release cannot read. A stopped pass resumes the
  same reserved intents once its five-minute lease expires.

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
artwork and visibility remain separate catalog edits: the review draft shows the
Album's ordered Artist Credits, their join phrases and its label read-only, and
offers a Disc Number field only for Tracks whose review captured one.

Catalog review routes (relative to `/api/admin/v1`):

- `POST /catalog-reviews`: `{operationId, albumId, expectedRevision}` captures a
  ready Album and up to 100 ready Audio members. Empty Albums are supported;
  malformed, missing, Video or inconsistent members are explicitly rejected.
  Creation does not start analysis. Original filenames are allowlisted basenames, never storage keys.
  Each source Track also captures its Disc Number, or `null` when it stores
  none. The review is stored as Draft v2 with read-only context from the
  Album's Credits: the ready, named primary and featured Artist Credits in
  stored order (at most 20, a repeated name once at its first Credit, as in the
  catalog byline), each keeping its join phrase only while the next stored
  Credit is also shown, and the first ready, named label Credit. A draft whose
  editable values exceed 48 KB is refused with `400
  ADMIN_IMPORT_INVALID_INPUT` and nothing is stored; the read-only context is
  not counted, because it cannot be shortened from the review.
- `GET /catalog-reviews` and `GET /catalog-reviews/:id`: independent bounded
  workbench pagination and private readback. `sourceStatus` distinguishes current,
  changed and unavailable sources. Old `/imports` routes exclude these projects;
  strict native import DTOs are unchanged. The detail's `draft` and
  `suggestions` are Draft v2, as for imports, and each `source.tracks` entry
  carries its captured `discNumber`. A review saved in format 1 reads as Draft
  v2: its Artist name as one primary entry, no label, unknown Disc Numbers and
  no `discNumber` key on its source tracks. Its first admitted change other
  than `/cancel-analysis` stores that view and captures nothing new. The Web
  editor shows that converted name alone, never as a Credits list, because it
  may not be any Credit of the Album.
- `PATCH /catalog-reviews/:id` and `POST` to `/analyze`, `/adopt` or
  `/cancel-analysis`: save/review privately with the original UUID and numeric
  revision. Analysis uses the existing import flag, provider and shared budgets;
  viewing, editing or creating a project does not dispatch a provider request.
  Every review change binds `expectedRevision` to the last administrator
  change: any revision from that receipt's to the current one is admitted, so
  analysis progress, which adds no receipt, never makes a save or stop stale,
  while a revision from before another administrator's change returns
  `409 ADMIN_IMPORT_REVISION_CONFLICT`.
  A PATCH body is `{operationId, expectedRevision, draft}` with the whole Draft
  v2. Its `artists`, `label` and `visibility` must equal what the review shows,
  and so must the `discNumber` of a track whose source captured none, or the
  save returns `400 ADMIN_IMPORT_INVALID_INPUT`. The 48 KB cap binds only a
  save or adoption that grows the editable values. A v1 draft body (an Album
  `artistName`) returns `409 ADMIN_IMPORT_RELOAD_REQUIRED` right after receipt
  lookup, before the revision, applied and limit checks. `/adopt` refuses selecting an Artist
  suggestion with `400 ADMIN_IMPORT_INVALID_INPUT`; rejecting one is allowed.
  Reviews read through the same allowlist and read-only rule as imports: a
  review saved in a newer format offers neither analysis nor apply, and refuses
  edit, analyze, adopt and apply with `409 ADMIN_IMPORT_RELOAD_REQUIRED`, while
  `/cancel-analysis` stays admitted.
- `POST /catalog-reviews/:id/apply`: `{operationId, expectedRevision, fields}`
  selects saved Album `title`/`releaseDate` or Track
  `title`/`discNumber`/`trackNumber` paths. A Track `discNumber` is accepted
  only where the source captured one (otherwise `400
  ADMIN_IMPORT_INVALID_INPUT` before any write). It is written with
  `discNumberSource: 'admin-catalog'`, or `null` removes both keys, as a
  catalog edit does, and a Disc or Track Number re-derives the Album order.
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
`src/administration/import/adminImportCatalogCommit.ts` freezes a new
approval's identities and commits a format-3 approval as described in
[Import publication](../architecture/catalog.md#import-publication); formats
1 and 2 keep their earlier commit. Before the first copy, the worker checks
that every reused Artist and Organization and an append's target Album is
still ready, and the commit checks them again; otherwise the publication
needs attention (`catalogConflict`) without minting identities. The
preselections the approval froze are rechecked at the same two points, as
described for `POST /imports/:id/publish`, with `identityConflict` instead.
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

## Tag evidence and automatic values

Tag automation (`src/administration/import/adminImportAutomation.ts`) and
metadata lookup value application (see [Value application](#value-application))
are the only automatic writers of an import's Draft v2 values; both write
through `applyAutomaticValues`. Tag evidence is read by
`src/administration/import/adminImportTags.ts`.

- **Evidence.** A confirmed upload stores version-2 tag evidence
  (`version: 2`): `title` and `album` (at most 300 characters),
  `artists` and `albumArtists` (at most 10 names of at most 200 characters,
  each once), `label` (at most 200 characters), `year` (1 to 9999),
  `discNumber` (1 to 999), `trackNumber` (1 to 9999), `durationMs` (1 ms to
  24 hours, rounded), and `identifiers`: `barcode` (a GTIN-8, -12, -13 or -14
  with a valid check digit, stored as digits), `catalogNumber` (at most 100
  characters), `isrc` (12 characters, uppercase, no hyphens) and
  `musicBrainzReleaseId` (a lowercase UUID). Text is NFC-normalized and
  trimmed. A value with control, invisible formatting or lone surrogate
  characters, over its limit, or that fails its format is left out, never
  stripped or truncated, and listed once per field and reason in `flagged`
  (`characters`, `length` or `format`). A list of more than 10 distinct names
  is left out whole (`length`), and a label, catalogue number or ISRC tag with
  several distinct values is left out (`format`) rather than cut to its first
  value. A strange tag never refuses the audio.
  Evidence stored before version 2 reads as `version: 1` with its five
  original values and empty extended fields; it is never re-read or backfilled.
  Luna still receives only the five original values.
- **Per-file step.** Once a file's upload is confirmed, its track title, Disc
  Number and Track Number are filled from its tags. Without a disc tag, a
  folder or the start of the file name in its relative path naming a disc
  (`Disc 2/`, `CD2/`, `cd 3/`, `CD2-01 x.flac`) supplies the Disc Number from
  1 to 999 when every match agrees; words that merely start alike
  (`Discography`, `Disco 2000`) never match.
- **Album step.** Once every manifest file is confirmed with version-2
  evidence, one step fills the Album title, the release year (month and day
  unknown), the label and one primary Artist entry from the values every file
  shares; a value one file lacks or files disagree on stays empty. The entry
  needs exactly one album artist on every file, with no album-artist name left
  out there, never falls back to the track artist, and has a key derived from
  the import, so it is stable. Placeholder
  credits such as Various Artists, Unknown Artist, `[unknown]` or `[no label]`
  are never written; a company-like album artist is written and flagged in
  `possibleLabelEntryKeys`. The step runs once (`automation.albumAt`): a later
  replay, check or replaced file never repeats it.
- **Compare-and-set.** Every value goes through `applyAutomaticValues`: it is
  written only while the current value is empty or automatic and still the one
  automation read, an equal value is no write, and a write that would grow the
  draft past 48 KB is skipped alone. A written value becomes automatic; others
  are skipped, and the step's markers are set anyway (partial success).
  Tag automation never clears a value and never replaces one still resting on
  the applied metadata lookup candidate (equal to a value it wrote), so files
  confirmed after a lookup was applied or chosen leave its values as they are;
  only applying another candidate, or none, returns values the earlier one
  wrote to their tag values or empty (see
  [Value application](#value-application)). Each run that writes
  bumps `valueRevision` once and never `revision`, receipts or the editing
  allowance; decisions whose entry or label it replaced are dropped.
- **Triggers and guards.** A confirmed upload, a replay of its original intent
  and reconciliation ("Check again") run automation, so a run missed by a crash
  is caught up; reads never write. A run skipped because the triggering
  administrator lost the role, or whose transaction failed, is caught up only
  by a later confirmed upload of any file, a replay of an upload's original
  intent or a reconciliation; the Web reconciles only uploads of unknown
  outcome, so until then the values stay empty. It runs in one transaction
  under the triggering administrator, who must still hold the role, and
  writes nothing for a format-1 or newer-format project, a catalog review, a
  malformed draft or while a publication locks the sources. A concurrent
  writer is a transaction conflict that is retried against fresh state, so an
  administrator's save made meanwhile is kept and only that value is skipped.
  The same confirmation then evaluates the automatic metadata lookup trigger
  (see [Triggers and grants](#triggers-and-grants)).
  A file removed and uploaded again runs its per-file step again, replacing its
  automatic values and keeping the administrator's own. A new upload to a
  converted format-1 project fills only that track's empty values, and no
  album step runs while other files keep version-1 evidence.
- **Durations.** A file's known duration for matching is its version-2
  `durationMs` (exact), or else its stored `mm:ss` duration, which counts with
  1-second precision.

## Import format compatibility

Stored import and review projects carry format numbers, so a release can read
what a later release wrote and never acts on a format it does not know. The
reads live in `src/administration/import/adminImportDraftCompat.ts`.

- **Format numbers.** A project's `draftVersion` and a publication approval's
  `schemaVersion` are absent, `null` or `1` for the original format. This
  release writes `draftVersion` 2 for import projects and `schemaVersion` 3 for
  their approvals. It reads draft formats 1 and 2 and approval formats 1 to 3,
  and treats a higher number, or any value that is not a positive whole
  number, as newer. Catalog reviews are written as
  format 2 too: a format-1 review is shown converted and stored as format 2 at
  its first admitted change other than stopping analysis, and 3 or higher is
  newer. An approval is format 1 only with a v1
  snapshot (a string `artistName`, no artist entries and no Disc Numbers),
  format 2 only with a Draft v2 snapshot of one primary Artist entry, no label
  and a `discNumber` field (a Disc Number or null) on every track, and format 3
  only with a Draft v2 snapshot whose entries each have a key, a name and a
  primary or featured role, a label that is null or named, a `discNumber` field
  on every track, 1 to 50 frozen `artists` and a frozen `label` that is null or
  a record; anything else is treated as newer, and deeper inconsistencies are a
  catalog conflict at commit. A later release must write a higher number for
  any other shape.
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
  draft and suggestions, the decision, `published`, `coverChoice`, marker and
  asset tag fields described under `GET /imports/:id` (assets carry the
  version-2 tag allowlist), and the v1 fields everywhere else: assets,
  publication state and receipts, whose kinds include the four lookup
  receipts; the lookup view is its own allowlist (see
  [Lookup routes](#lookup-routes)). A decision whose
  scope this release does not know is dropped. Review responses copy the
  Draft v2 fields of the draft and suggestions, the source with a Disc Number
  only on a track that captured one, and applied Track `discNumber` fields.
  The import workbench inventory copies only v1 fields, so a Draft v2 project's
  row shows its first primary Artist as `artistName`. Fields and values a
  later release adds are dropped; an unknown state reads as needs attention;
  and a newer format offers no `capabilities`. An open tab of this release
  therefore keeps parsing a newer format instead of asking for a reload, while
  a tab opened before this release fails its strict schema on a Draft v2
  response and shows the reload-required state.
- **Draft v2 view.** The same module presents a v1 project as Draft v2:
  `artistName` becomes one primary entry with a deterministic per-project key,
  label and Disc Numbers are unknown, and every value counts as the
  administrator's own. The view is computed on read; the first admitted change
  stores it (see `PATCH /imports/:id`).

### Rollback floors

Later stages raise the oldest release that is safe to roll back to:

- Once Draft v2 projects or format-3 approvals are saved, never roll back
  below the first release that keeps such projects read-only and holds their
  approvals in needs attention instead of misreading them. That release reads
  `discNumberSource: 'admin-import'` without issue, and it links a completed
  import of several Artists or a label only to its Album and first Artist,
  which the approval mirrors as `artistId`.
  Every project created since is stored as Draft v2 at creation, so after a
  rollback to that release it is read-only even if it was never edited. That
  release refuses field saves and one-step approvals before receipt lookup
  (as invalid input, or as too large over its 96 KB JSON limit) and never
  replays them, so after a rollback reload open workbench tabs before
  retrying a save or approval whose response was lost.
- This release stores catalog reviews as Draft v2, at creation or at their
  first admitted change. The oldest release that reads Draft v2 imports (the
  floor above) keeps such reviews read-only: it never dispatches their
  analysis, so stop a queued or running analysis there (stopping stays
  admitted), and it omits applied Disc Number fields from the applied list.
  Reviews this release neither created nor changed stay format 1 and editable
  there.
- Version-2 tag evidence, `valueRevision`, the once-only `automation` marker
  and per-asset automation markers do not raise the first floor above, the
  release that allowlists Draft v2 DTOs. Older releases show only the five
  original tag fields, though their analysis sends the stored evidence to
  Luna as it is, ignore `valueRevision` and `automation`, and refuse decision
  and approval bodies that carry `boundName`, so reload open workbench tabs
  after a rollback. Those that save Draft v2 projects run no automatic step and
  compare decisions, cover choices, approvals, adoptions, analysis, analysis
  stops, staged cleanup and publication cancellation with the project
  revision again, so Luna progress, finishing uploads and publication
  checkpoints can make them stale there. A file uploaded while rolled back
  keeps only its original five tag fields and fills nothing after rolling
  forward.
- An approval made with preselections keeps format 3. A release before them
  commits its frozen preselected creates without the recheck, so a name
  candidate that appeared after approval is then not caught; roll back only
  while no such publication is preparing or in needs attention. Before rolling
  back, confirm in `mongosh` that this returns 0, or cancel those publications
  first:

  ```js
  db.adminAlbumImports.countDocuments({
    "media.publication.state": { $in: ["preparing", "needsAttention"] },
    "media.publication.decisions.preselected": true
  })
  ```

  A Web tab opened before them cannot parse the candidates response, which
  now carries `memberMatchesComplete`, `unavailable` and up to 860 items, and
  a release before them refuses the `preselections` this Web sends with its
  approvals as invalid input, so reload open workbench tabs after deploying or
  rolling back across them.
- After metadata lookup jobs run, never roll back below the release before
  them, which ignores `adminImportLookups` and keeps each import document's
  `lookupGate` as it is, because it replaces documents as it read them. Its
  index revision is older, so it verifies its own indexes and leaves
  `admin_import_lookup_worker` in place. The release that runs lookup jobs but
  applies no values reads a record's `applied` without using it, no longer
  holds publication for a queued, running or retrying lookup, a tie or a
  conflict, shows applied entries as resting on file tags, lets file-tag
  automation replace applied values, and filters `lookup*` receipts out of the
  detail, so a lost lookup response there cannot be reconciled from receipts;
  reload open tabs.
- Partial comparisons, 100-release search pages, normalized fallbacks and
  quick throttled retries need no floor of their own. A release before them
  runs a stored plan's fallback queries unconditionally (still at most six),
  ignores `searchComplete` and stored reported track counts, may again
  preselect and apply a truncated search's only matching group, and schedules
  a throttled first retry after 30 seconds. Its Web schema refuses the new
  `partialComparison` disclosure key, and this Web's schema requires it, so
  reload open workbench tabs after deploying or rolling back across them. A
  run that the release before them completed keeps its stored preselection and
  applied values; only a re-rank on new evidence ranks it again, as a partial
  comparison, which then offers its only matching group without unapplying it.
- Luna ticks need no floor of their own: an approval applies them to ordinary
  suggestion decisions and draft values. A release before them refuses the
  `suggestionTicks` this Web sends as invalid input and holds an approval
  while a shown suggestion is pending, and a Web tab opened after them cannot
  parse a lookup read without its `summary` (from a release before them), so
  its Review and publish summary shows an error and its confirmation cannot be
  approved while a suggestion is pending; reload open workbench tabs after
  deploying or rolling back across them.
- Automatic covers need no floor of their own. A release before them shows and
  publishes only a stored, explicit `selectedCoverSlotId`, so an import whose
  choice is still automatic shows No cover there and publishes no cover unless
  an approval already froze one. It ignores `artworkSha256` and
  `media.coverCleanup`, runs no automatic cleanup, and counts automatic
  cleanup receipts toward the 16 embedded stagings. A reserved automatic
  cleanup (`deleting` or `cleanupFailed`) still retries there with its
  original intent, because that release also finds receipts among the
  automatic lifecycle receipts. A Web tab opened before them cannot parse a
  detail that carries `coverChoice`, so reload open workbench tabs after
  deploying or rolling back across them.
- After MusicBrainz IDs are stored, never roll back below the release before
  them; its index stays, and listener DTOs already drop unknown fields.
- Credit join phrases and Disc Numbers have their own floor in the
  [catalog Credit rollout runbook](../deployment/catalog-credit-rollout-runbook.md#join-phrase-and-disc-number-rollback-floor).

## Metadata lookup

A server worker runs MusicBrainz lookups for import projects automatically (see
[Lookup runs](#lookup-runs)) and applies a preselected candidate's values (see
[Value application](#value-application)). [Routes](#lookup-routes) and the
`metadataLookup` capability expose them, and the import's Review and publish
summary (see the import page above) is their Web control. iTunes and Cover Art
Archive are not queried yet. The source layer, the jobs and their routes live
in `src/administration/lookup/`.

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
  after 30 seconds. Spacing counts from each holder's latest send, after DNS and
  once per redirect hop (or, before it sends, from its grant's arrival): its
  release moves the next start to at least one interval after that moment, the
  database time of the release minus the time since, so a grant whose reply
  arrives late (a slow write) or a slow DNS answer cannot bring the next request
  closer. That bound needs one holder at a time, so a source with spacing must
  have concurrency 1. Automatic lookups wait for a slot (wait mode), polling
  about once per interval while a lease is held, and report the source as
  `unavailable` after 60 seconds. A submitted lookup (busy mode) sleeps out only
  its own request spacing, so its consecutive requests are paced rather than
  refused. It is reported as `busy` when another request holds the source, when
  a backoff pushed the next start further than one interval, or when another
  lookup took the slot it waited for. A 503 or 429 answer (iTunes also 403)
  pushes the source's next start by its Retry-After (1 to 30 seconds) or by 2
  then 5 seconds; wait mode makes at most three attempts in one call. A gate
  command is bounded to 2 seconds and a release to 1 second, an abort cancels a
  pending command at once, and a grant whose reply was lost is released again. A
  database failure fails closed before anything is sent.
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
  into at most six MusicBrainz queries, in that order, so the cap drops
  trailing fallbacks first. It never accepts file names. Submitted text is only
  normalized (NFC, collapsed whitespace), so a link, a name over 200 characters
  or a control or format character is reported instead of planned; tag and
  folder text has format characters removed and control characters turned into
  spaces.
  - Queries carry only the text and identifiers above. The number of selected
    files is never sent: a run uses it locally to admit the releases whose
    reported track count can equal it (or is unknown) before the others, and
    to fetch their details first (see [Lookup runs](#lookup-runs)). A release
    search asks for a page of 100 releases, so popular Albums with many
    editions still offer their plausible editions to that admission; a
    recording search asks for 25 recordings. Media counts and release-group
    browse are not used.
  - Album text plans the credited search (with the album-artist name or label
    term, or the folder's "Artist - Album" split) and the bare search, then
    fallbacks in the normalized spelling: the credited search respelled, then
    the bare text respelled (not a folder's whole "Artist - Album" name, which
    names no release). A song plans the credited and bare recording searches,
    then both respelled as fallbacks. The fallbacks are sent together, and only
    when the searches before them found no candidate, so one spelling alone
    never narrows what is compared.
  - The normalized spelling applies to tag and folder text only; submitted
    text is sent as typed. It applies NFKC (full-width forms and `～` fold),
    writes the wave dash `〜` as `~`, joins "Sound Track" (or "Sound-Track")
    into "Soundtrack" and removes a trailing remaster note such as
    `(2013 Remaster)`, `[Remastered]` or ` - Remastered 2009`; it is planned
    only when it differs from the cleaned text.
  - Ranking pairs files with tracks by Disc Number, Track Number and upload
    order, or by upload order alone when Disc Numbers are missing and Track
    Numbers repeat. Discs are counted and numbered among the media that have
    tracks, so a DVD without a tracklist is not a disc. A candidate matches
    when the track count, any known disc count and every duration agree within
    3 seconds, plus 1 second for legacy `m:ss` durations. A candidate with any
    unknown local or MusicBrainz duration is unverified and never preselected.
  - The only matching group is preselected only when the comparison is
    complete. It is partial (`partialComparison` in the disclosure) when a
    search reported more hits than it returned, the candidate bound left out a
    release a search offered that could match or ended the search before a
    planned non-fallback query, a planned search was refused, or a candidate
    that could match is incomplete. A release could match unless it reported a
    track count other than the number of files or, for an incomplete
    candidate, no longer exists (404). A partial comparison's only matching
    group is offered but not applied, and needs no answer; two or more
    matching groups are a tie as always. An identifier every file shares still
    preselects the candidate it matches alone.
- **Fixtures.** `npm run record:metadata-lookup-fixtures -- --live` re-records
  the trimmed public responses in `test/fixtures/metadataLookup/`. It contacts
  the live services with a recorder User-Agent and the contract rates, so only
  an operator runs it; tests and CI never do. Lookup tests install
  `test/support/networkGuard.ts`, which fails any non-loopback DNS query,
  socket or `fetch`.

### Lookup runs

`src/administration/lookup/metadataLookupService.ts` runs the jobs,
`metadataLookupRecord.ts` beside it holds their pure model, and
`lookupRunStep.ts` performs each step's request and decides, without a
database, what the step stores and which request comes next.

- **Record.** `adminImportLookups` keeps one record per import project (its
  `_id` is the project's): the run number, state, issue and outcome, the grant,
  the bound file set (`fileSetDigest` and each manifest slot's confirmed upload
  intent and SHA-256), the input (`tags`, `folder` or `submitted`), at most six
  planned queries with their progress, the MusicBrainz attempts, at most 25
  candidates, whether every release its searches offered was compared
  (`searchComplete`; a record from an earlier release counts as partial when
  it is re-ranked or resumed), the ranking with its groups, the applied
  candidate (or none) with its values, conflicts and flags (see
  [Value application](#value-application)),
  stale slots, the automatic-run count and whether a folder-name query was
  handed to the worker. A new run (an automatic rerun, a submitted name or a
  manual retry) replaces the previous run's results; only the
  automatic-run count, the folder use and the applied values carry over. No
  history is kept, and records are never deleted.
- **States.** `queued`, `running` and `retrying` are active; `complete`,
  `unavailable`, `stopped` and `superseded` end a run. A stopped run's issue is
  `permissionLost` or `grantExpired`, an unavailable one's `sourceUnavailable`,
  `sourceBusy` (a refused gate, or a rate-limited source after its retries) or
  `notConfigured`, and a superseded one's `fileSetChanged` or
  `projectClosed`. A completed run's outcome is `candidates`, `noRelease` or
  `noQuery` (nothing to look up, so nothing was sent); an unavailable run has
  no outcome and is never reported as no release.
- **Steps.** The worker polls every 2 seconds, claims a due run with a
  180-second lease and advances it one MusicBrainz request per stored step: the
  planned queries in order until 25 distinct releases are known, skipping the
  fallbacks when a candidate is known as they start, then each candidate's
  release lookup, then ranking. Releases whose reported track count can match
  the files (or is unknown) are admitted first and their details fetched first,
  so the bound is spent on plausible editions; a recording hit's reported track
  count is stored with its candidate, since its release has no summary. A run
  attempt sends at most 6 searches and 25
  release lookups (31 requests); in wait mode each request is sent at most 3
  times within one call for a 503 or 429, and a failed step is retried
  automatically at most 3 times. Each step's transaction first
  rechecks the lease, the grant, the granting administrator's current role,
  that the project still accepts lookup and that no bound file changed. Requests
  run outside any transaction, each bounded by a 120-second step deadline. A
  worker whose lease was taken over writes nothing, and search progress
  survives retries, takeovers and restarts. Stopping the server aborts the
  request in flight and releases the lease; the next claim resumes at the
  stored step. The step that ranks a run also applies its preselection (see
  [Value application](#value-application)).
- **Retries.** A busy, rate-limited, unavailable or invalid answer, or the step
  deadline, schedules an automatic retry of the run after 30 seconds, 2 minutes
  and 5 minutes, or after a longer Retry-After of at most 60 seconds. A 503 or
  429 that is the run's first failure is a throttled source rather than an
  outage: the run waits as `retrying` with issue `sourceBusy`, and its first
  retry follows the Retry-After within 2 to 10 seconds (2 seconds without one;
  MusicBrainz's `Retry-After: 0` counts as 1 second), while the
  deployment-wide gate still holds the source for a longer Retry-After; later
  retries keep 2 and 5 minutes. A refused gate (`sourceBusy`), an outage or a
  timeout (`sourceUnavailable`) keep 30 seconds, 2 and 5 minutes. Automatic
  runs, automatic reruns (also of submitted text) and manual retries wait for
  the source gate; a submitted run uses busy mode until its first failed
  attempt, then waits. When the third retry fails too, or the next retry would
  come after the run's grant expires, a search ends `unavailable` with no
  ranking, while during release lookups the remaining candidates become
  incomplete and the run completes with `sourceUnavailable`. A manual retry
  starts a new run with the same queries.
- **Candidates.** Releases are stored without ISRCs, within 4 MiB of JSON for
  all candidates together, and candidates plus ranking stay within 12 MiB: while
  over it, the largest fetched releases are omitted and the rest ranked again. A
  release-ID query is stored under the ID MusicBrainz returns, so a release
  merged into another is ranked under its current ID. A 404 is `missing`, an
  exhausted lookup `failed` and a release over a budget `omitted`; all three
  are incomplete and unranked. The
  front-artwork flag comes from the release lookup. Ranking compares each
  file's known duration (version-2 milliseconds, else a stored `mm:ss` with
  1-second precision), the draft's Disc and Track Numbers, the version-2 artist
  and album-artist tags and the identifiers every file shares.
- **Limit.** A project runs at most three automatic lookups: the first and two
  reruns after file-set changes. Submitted names and manual retries do not
  count.
- **Fence.** Starting a run (including one that completes at once as
  `noQuery`) and every state change write `lookupGate`
  `{ fence, run, state, blocking }` on the import document in the same
  transaction, the gate before the record, with `fence` incremented so the
  write always conflicts with a concurrent transaction that also writes the
  document. A re-rank of stored candidates writes it too, and the publish gate
  reads and writes it. A transaction that only reads the document does not
  conflict. A trigger that starts nothing, stale marking of a finished run and
  progress steps do not write it. It never changes `revision`,
  `valueRevision`, `updatedAt`, receipts or the editing allowance, and it is
  never projected. `blocking` is true while a run is active; ties and
  conflicts are computed from the record and the draft, not stored in it.

### Triggers and grants

- **Automatic runs.** The confirmation that completes the file set queues a
  run: the upload of the last selected audio file (or a replay of its intent),
  or a reconciliation ("Check again") that itself confirms the last upload.
  Creating an import queues nothing, because none of its files is confirmed
  yet. A reconciliation that finds the file already ready, cover and
  embedded-artwork slots, typing, saving, reading, listing, decisions,
  candidates, adoption, cover selection, analysis and navigation never run
  lookup, and a format-1 project's conversion never does either. Catalog
  reviews never accept lookup.
- **Input.** Several files are looked up by the album and album-artist tags
  they all share (album-artist names joined by ` / `), never by per-file
  artists, and one file by its title and artist tags, together with the
  identifiers every file shares (release MBID, barcode, catalogue number, and
  an ISRC for one file). Only version-2 tag evidence counts. Without usable
  tags, the cleaned name of the chosen folder is used, only when the files were
  chosen with a folder and only by one automatic run per project: the
  allowance is spent when the worker hands out a folder-name query, before it
  is sent, so a folder run superseded or stopped before sending leaves it to
  the next automatic run. A manual retry of a folder run repeats its queries. A
  rerun after a submitted run repeats the submitted text.
- **File set.** A run binds each manifest slot's confirmed upload. Once the set
  is complete again after a change, the next completing confirmation reruns,
  within the limit. Removing or replacing a bound file supersedes an active run
  (in the staged-cleanup transaction) or lists the file in a finished run's
  `staleSlotIds`, without reverting values. A file confirmed after a run
  started is newly known, not stale.
- **Grants.** Each run holds a one-hour grant:

  | Granted by | Source | Administrator |
  |---|---|---|
  | The last upload or its replay | `upload` | the uploader |
  | A reconcile confirming it | `reopen` | the reconciler |
  | A submitted name | `submit` | the submitter |
  | A manual retry | `retry` | the one retrying |
  | Choosing a candidate or none | `choose` | the one choosing |

  Admitting a submitted or retried run, a choice or conflict answers rechecks
  that administrator's role in the same transaction, and every stored step
  rechecks the grant and that administrator's current role. Choosing a
  candidate or none moves the run's grant to the one choosing for another hour
  without starting a run.
  A role loss, a deleted account or an expired grant stores nothing from that
  step and ends the run as `stopped`; earlier candidates stay as evidence and
  are never ranked or applied. A project that no longer accepts lookup (a
  publication lock, completion, a newer format or a malformed draft) ends it as
  `superseded` (`projectClosed`).
- **Refusals.** Submitted and retried runs are admitted inside the caller's
  administrator transaction, which the [routes](#lookup-routes) provide. They
  are refused with 503 `ADMIN_IMPORT_LOOKUP_UNAVAILABLE` while lookup is not
  configured, 400 `ADMIN_IMPORT_INVALID_INPUT` for an unknown request kind or
  a malformed account or intent, 403 `ADMIN_IMPORT_ADMIN_REQUIRED` when the
  granting account is not a current administrator, 409
  `ADMIN_IMPORT_LOOKUP_REFUSED` for a project that does not accept lookup, 400
  `ADMIN_IMPORT_LOOKUP_INVALID_NAME` for a link or an empty, over-long or
  invisible-character name, 409 `ADMIN_IMPORT_LOOKUP_ACTIVE` for a retry while
  a run is queued or running, and 409 `ADMIN_IMPORT_LOOKUP_NOTHING_TO_RETRY`
  without an earlier run's queries or with a stored input this release cannot
  read. A manual retry while a run waits for an automatic retry replaces that
  run at once, so the free retry is available while Publish waits.
- **Independence.** A trigger never changes the confirmation's result: lookup
  not configured, a role loss, a closed project, an incomplete or unchanged
  file set, the limit or a database failure writes nothing beyond stale
  marking. Lookup never blocks saves, uploads, Luna analysis or review and
  never uses Luna's budget, and starting or stopping Luna keeps its record.
  While lookup is not configured the worker ends a queued run as `unavailable`
  (`notConfigured`) without a request; while imports are disabled it is idle.

### Value application

`src/administration/lookup/lookupValueApplication.ts` applies a candidate to
the draft through the same compare-and-set path as file-tag automation, so it
fills only empty or automatic values that are still as it saw them.

- **When.** The worker step that completes a run applies its preselection in
  the same transaction as the record and the gate; a re-rank that finds a new
  preselection applies it too. An explicit choice of a candidate or none
  (`/lookup/choose`) applies at once. A completed run's preselection replaces
  an earlier application, an explicit one included, but never this run's own
  explicit choice; a run without a preselection leaves the earlier application
  as it is. Only a fetched candidate whose release has the candidate's own ID
  is applied; one answered under another ID (such as a merged release) ranks
  as incomplete and is never preselected or chosen. A role loss, an expired
  grant or a publication lock at that step applies nothing.
- **Values.** The Album title; the Artist entries in credit order with their
  join phrases, where the entry after a featuring phrase (`feat.`,
  `featuring`, `ft.`) and every later one is featured and a credit repeating an
  earlier one's MusicBrainz artist or name (compared case-insensitively) is
  dropped; the first listed label; the release group's first-release date at
  its precision, else the release's own; and, only when the candidate's track
  count equals the file count, each file's title, Disc and Track Number in the
  ranking's file order (Disc Numbers count only media with tracks). An entry
  keeps the key of the current entry with the same name, compared
  case-insensitively, else a key derived from the project and the name, so
  decisions on unchanged entries survive. No MusicBrainz ID is written yet.
- **Left out.** Text is NFC and trimmed; a value with control, invisible
  formatting or lone surrogate characters, over 300 (titles) or 200 (names)
  characters, one bad Artist entry (including an invalid or over-16 join
  phrase), more than 20 entries, a malformed date or number, or a write past
  the 48 KB draft cap is not written and is flagged (`characters`, `length`,
  `format`, `size`). A release that credits only placeholders is flagged
  `placeholder`; placeholder credits and a `[no label]` label are never
  written.
- **Conflicts.** A value that differs from the administrator's own non-empty
  value (Artist entries by name case-insensitively, role and join phrase; the
  label by name case-insensitively; anything else exactly) is recorded as an
  unanswered conflict and not written; an empty administrator value is filled.
  A conflict needs no answer once the current value equals the lookup value,
  and applying the same lookup value again keeps an earlier answer.
- **Replacing.** Applying another candidate, or none, returns each value the
  previous application wrote that is still automatic and unchanged, and that
  the new candidate does not supply, to its file-tag value or to empty; an
  emptied value loses its origin, so it is not marked automatic. File-tag
  automation for files confirmed later never replaces a value still resting
  on the applied candidate; it fills only the values lookup did not write.
- **Evidence.** The record's `applied` keeps the run, candidate and release,
  how it was chosen (`preselected` with its basis, `chosen` or `none`), the
  administrator and intent, the paths written, each value resting on the
  candidate (a track value names its manifest slot), the conflicts with their
  answers and the flagged values. Automatic values equal to an applied value
  are listed in the detail's `lookupPaths` and are not marked as resting only
  on file tags.
- **All or nothing.** A write bumps `valueRevision` once and keeps only
  decisions still bound to their entry or label; `revision`, receipts and the
  editing allowance never change. Applying the same candidate again writes
  nothing. A failure in the worker step aborts values, gate and record
  together, and the run resumes at its stored step after its lease.
- **Re-ranking.** A confirmation that leaves the file set incomplete, or that
  reaches the automatic-run limit, re-ranks a completed run's stored
  candidates when their evidence changed (Disc and Track Numbers aside, which
  an application writes in ranking order), with no request, writing the gate.
  A new preselection is applied as the administrator whose confirmation
  re-ranked it; the run's grant is unchanged. The run then binds the file set
  it re-ranked: a stale slot whose replacement is confirmed is no longer
  stale, one still without a confirmed file stays stale, and the stored
  `fileSetDigest` still decides automatic reruns.
- **Publish.** An approval waits while a run is queued, running or retrying
  (`409 ADMIN_IMPORT_LOOKUP_ACTIVE`), and for a tie (a completed run with two
  or more matching groups, no preselection and no choice for that run) or an
  unanswered conflict of the applied candidate, whatever the current run's
  state (`409 ADMIN_IMPORT_REVIEW_REQUIRED`). An append ignores Album
  conflicts. The only matching group of a partial comparison is no tie and
  never holds an approval; left unchosen, nothing from it is applied.
- **Scope.** Value application writes only the import document and its
  lookup record, never a catalog collection. A published Album or MediaTrack
  and its search projection carry only the reviewed names and values, never
  a release, recording or iTunes identifier.

### Lookup routes

All are under `/imports/:id`, behind the same administrator, current-viewer
and `no-store` guards as every import route, parsed after those guards.
Submissions, retries and choices accept at most 8 KB of JSON, whatever the
path's letter case (Express matches routes case-insensitively); conflict
answers keep the 96 KB limit. Changes run through the import mutation path, so
each is one ordinary receipt that replays its intent, a changed body under the
same `operationId` is `409 ADMIN_IMPORT_OPERATION_CONFLICT`, and the usual
`PUBLICATION_LOCKED`, `OPERATION_LIMIT`, `RELOAD_REQUIRED` and
`REVISION_CONFLICT` refusals apply. A submission and conflict answers admit any
`expectedRevision` up to the current one, because each binds its own state; a
retry or a choice must not predate the last `lookup`, `lookup-retry` or
`lookup-choose` receipt, so one made before another administrator's lookup
request is `409 ADMIN_IMPORT_REVISION_CONFLICT`. Field saves and automatic
lookup runs never make them stale.

| Route | Body | Success | Refusals |
| --- | --- | --- | --- |
| `GET /lookup` | — | `200 {lookup, revision, valueRevision, summary}`; `lookup` is `null` before any run | `404 ADMIN_IMPORT_NOT_FOUND` for a review or a bad id |
| `POST /lookup` | `{operationId, expectedRevision, kind, text}`, `kind` `album` or `song`, text at most 1000 characters | `202` import response, receipt `lookup` | `503 ADMIN_IMPORT_LOOKUP_UNAVAILABLE`, `400 ADMIN_IMPORT_LOOKUP_INVALID_NAME`, `409 ADMIN_IMPORT_LOOKUP_REFUSED` |
| `POST /lookup/retry` | `{operationId, expectedRevision}` | `202`, receipt `lookup-retry` | `503 …UNAVAILABLE`, `409 …LOOKUP_ACTIVE`, `409 …NOTHING_TO_RETRY`, `409 …REFUSED` |
| `POST /lookup/choose` | `{operationId, expectedRevision, run, candidateKey}`, key `musicbrainz:<mbid>` or `null` for none | `200`, receipt `lookup-choose` | `409 ADMIN_IMPORT_LOOKUP_STALE` (another run, an active run, an unknown candidate, a candidate before completion), `409 ADMIN_IMPORT_LOOKUP_CANDIDATE_INCOMPLETE` (no fetched details, or a release fetched under another ID), `409 …REFUSED` |
| `POST /lookup/resolve` | `{operationId, expectedRevision, run, candidateKey, answers}`, 1 to 305 distinct `{path, answer, base}`, `answer` `mine` or `lookup` | `200`, receipt `lookup-resolve` | `409 …LOOKUP_STALE` (another application or a path that is no conflict), `409 ADMIN_IMPORT_FIELD_CONFLICT` (the current value is not `base`), `409 …REFUSED` (the project no longer accepts lookup or its draft cannot be read), `400 ADMIN_IMPORT_INVALID_INPUT` (an answer that grows the draft past 48 KB) |

A malformed body is `400 ADMIN_IMPORT_INVALID_INPUT` before its intent is
fingerprinted. Answering `lookup` writes the lookup value as the
administrator's own; `mine` keeps the current value. The lookup view is an
allowlist: the run, state, issue, outcome and input; at most 25 candidates
(ranked order, else stored order as incomplete) with title, joined credit,
label, catalogue number, barcode, country, date, at most 20 formats, track
count, the comparison counts and differences, group and artist mismatch; at
most 25 groups with their proposals; the preselection; the disclosure (unknown
local durations and Disc Numbers, and `partialComparison`); the applied
candidate's choice, value paths, conflicts (lookup value re-read
through the draft rules) and flags; stale files; and `needsAnswer` and
`blocking`. It carries no URL, ISRC, recording ID, account, grant, lease,
fence, file-set digest or query.

The `summary` is the import's Review and publish state, computed by
`src/administration/import/adminImportSummary.ts` from the same snapshot:
`append` (a saved Album reuse), `waiting` (`uploads` while any staged upload,
a file's or a cover's, is still in flight, pending with a transfer that can
still land, or any manifest file whose track is neither skipped nor reused
lacks a confirmed upload; `lookup` while a run is queued, running or
retrying; `analysis` while Luna is queued or running), `placeholderOnly` (no
Album reuse, no primary Artist entry, and every file's album-level credit,
album artists else artists, is a placeholder such as Various Artists, or the
applied candidate was flagged `placeholder`), `luna` (each pending suggestion
the editor shows with its tick state), `analysis` (`runs`, `attempts` and
`daily`: what is left of the project's two runs and 22 calls and of the
deployment's 220 calls today), `lookupAvailable` (whether this server's
configuration lets lookup run) and `identityAnswers` (the identity rows of the
saved draft that neither a saved decision nor a preselection answers, read
with the same candidates as Review). The lookup view's `needsAnswer` remains
the list of lookup answers Publish waits for. A stored manifest in a shape this
release does not know is read through its sanitized view. The publish
transaction rechecks all of it; an upload still in flight, or a file a
published track needs without a confirmed upload, is
`409 ADMIN_IMPORT_UPLOAD_INCOMPLETE`, writing nothing.

### What lookup sends

- Only the planner's MusicBrainz URLs under `https://musicbrainz.org/ws/2/`:
  the shared album text and album-artist names, or a one-file import's title
  and artist; shared identifiers that pass their format checks; a submitted
  name; the cleaned folder name only when no usable tags exist, only for
  folder-chosen imports and automatically only once per project (a manual
  retry of that run repeats it); release MBIDs from earlier results of the
  same run; and normalized spellings of tag or folder text as fallbacks. The
  number of selected files is never sent; the run uses it only locally.
- Never file names, relative path segments, account data (including any
  account's email address) or audio. The only contact sent is the operator
  contact configured in `FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT`, in the
  User-Agent.
- Requests carry only `Accept`, `Accept-Encoding: identity` and
  `User-Agent: Finitude/1.0 ( <contact> )`: no cookie, authorization or
  referrer.
- Stored records contain no URL.
