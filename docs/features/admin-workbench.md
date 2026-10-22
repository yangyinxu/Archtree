# Finitude Administrator Workbench

The private administrator API is mounted at `/api/admin/v1`. It uses the current
persisted `admin` role, same-origin cookie mutation protection, bounded parsers,
account-viewer fencing and `no-store` responses. `GET /capabilities` advertises
admission independently of the normal listener DTOs; `metadataLookup.available`
says only whether metadata lookup is configured, never the contact or why not.
Existing catalog edits, visibility changes, clearing a cover, existing-Album
reviews and local MP3 conversion need only that role and have no deployment
flag. Choosing a new cover also requires
`FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY` and its distinct
`ADMIN_IMPORT_S3_BUCKET_NAME` staging bucket. The remaining settings
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
the imports flag and configured provider, and its metadata lookup the imports
flag and `FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT` (without them the Album page
offers a review for manual editing, creating one queues no lookup, and its
summary says lookup is not configured).

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
does one that changed an edited value automatically, or changed only the
MusicBrainz IDs of edited Artist entries or the label (metadata lookup adds and
removes them on the administrator's own values; the edit takes the saved IDs
wherever it left an ID as it started, under an unchanged name), because an
administrator save always wins over automation; one where another
administrator changed an edited value, or a refused stale save, loads the
saved version for comparison. The rebase loads beside the editor, outside the
page's initial JavaScript. Compact value comparisons keep source evidence
expandable; publication recovery has its own status and actions. Confirmation
windows show the frozen named target and proposed change before secondary
explanations. Technical IDs remain available in Details rather than leading
normal catalog and Page rows.

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
or the label stays while its name matches the saved one case-insensitively or
is one of the names metadata lookup found for that ID (`musicBrainzNames` of
`GET /lookup`); Draft has no field to type one. An edited entry list or label
that the server would refuse (an empty name, a name repeated case-insensitively,
where every entry sharing it is marked, control or invisible formatting
characters left after trimming, more than 200 characters after normalization, an
invalid join phrase) blocks Save with its message; an empty name is marked only
after its field loses focus or a Save attempt, and unedited saved values are not
checked. When no entry is primary, a note says publishing a new Album needs at
least one primary entry (an append needs none); Save stays available. The
entries save as one `album.artists` change. The label is one Organization name
saved as `album.label`, and an empty label saves none. Each track edits its Disc
Number beside its Track Number. A saved value written automatically from file
tags and not yet reviewed (in `automaticPaths` but not `lookupPaths`) shows
"From file tags" in the visible and accessible label of the Album title, the
release date, the Artist entries, the label and each track's title, Disc Number
and Track Number, until that value is edited; an automatic Artist entry whose
name looks like a company says "This name looks like a label". In Files, a file
whose tags had values left out says how many beside its tag evidence. Once a
staged image is ready, the cover choice offers No cover and each ready image:
manual, embedded or Cover Art Archive front artwork from metadata lookup, which
Files and the cover choice name with the first eight characters of its release
MBID so lookup covers kept at once read apart, or the iTunes artwork of an
applied iTunes-only candidate, named with the first eight digits of its
collection ID. While the choice is automatic, a note says so, naming Cover Art
Archive or iTunes when the lookup cover is chosen, and only the image chosen
automatically is checked (nothing is checked when no image is);
choosing any option, No cover and the image already chosen automatically
included, makes the choice explicit for good. Review shows an Artist suggestion
as its byline followed by each entry with its role, and a label suggestion by
the label's name. Review's existing-content check has one Artist row per entry,
in draft order and named with its role, and a Label row when the draft has a
label; each row lists only the candidates found for its own name and, for an
entry or the label carrying a MusicBrainz ID, the record of its kind holding
that ID (Same MusicBrainz ID) and the records named as metadata lookup found for
that ID (MusicBrainz alias), and for an Artist entry the Artists named with
another iTunes localized name that metadata lookup found for its name (iTunes
localized name). Review loads the candidates when it opens, and Find matches
reads them again. A row without an explicit decision that the review preselects
is collapsed, reads "Preselected as new", "Preselected to reuse" a named member
or "Reuses" a named record "(same MusicBrainz ID)", and needs no answer: an
entry or the label is preselected to reuse the record holding its ID unless
another row's reuse, replace or an earlier preselection names that record, and
an Artist entry, the label or the Album without a name, alias, localized-name or
same-ID candidate of its kind is preselected as new, and so is every track once
the Album is new (explicitly or preselected). Creating a distinct record, or
reusing another one, instead of the record holding the entry's ID records no ID.
Reusing a record that holds a different ID keeps that ID, and reusing it while
replacing its ID with the entry's is a separate choice, offered while no
listed record holds the entry's ID. When the Album row reuses an existing
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
explicit decisions. An Artist that another entry already reuses cannot be chosen
again, and a save in which two entries reuse the same Artist is refused. While
the Album row reuses an existing Album, each Artist and Label row says it is not
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
within seconds) and while the applied release's cover is being staged
(`waiting.cover`), and every 10 seconds while it waits out an outage; a read
that sees a newer saved project reloads the page's project read. The summary
components (`ImportSummary.tsx`, `LookupBox.tsx`, `CandidateChooser.tsx` and
the shared `ImportAnalysisConfirmation.tsx`) load lazily from the media panel,
outside the import route's initial JavaScript. An append's expected tracklist
rows (`ImportExpectedRows.tsx`) load in a chunk of their own, from the
summary and the publication confirmation, only for an append to an Album that
has one; a chunk that cannot load asks for a reload in their place and holds
neither Publish nor Approve. The server decides what holds Publish; the
summary only presents it:

- **Status and next step.** Not run yet while uploads are awaited, not run
  although every needed file is uploaded (its automatic trigger failed; the name
  box next), looking up (queued or running), retrying (busy or unavailable, next
  step the free **Retry lookup**), unavailable after the automatic retries (the
  retry still next), not configured (no next step; the name box where this
  server can now run lookup), stopped (the retry next), superseded (the retry
  next), no release or nothing to look up (the name box next), no matching
  release or none applied where nothing matched (the name box next; every
  candidate stays choosable), release details that could not be fetched (the
  retry next), a tie (no next step), one matching release from a partial
  comparison that was not applied (no next step; choosing it, another release or
  none is optional), or the applied release. With the iTunes fallback it also
  says when lookup searches the iTunes Search API (no next step) or retries it
  (the retry next), when MusicBrainz answered without a match and iTunes stayed
  unavailable (the name box next), and when an iTunes-only result was applied
  (no next step) or applied without a check against MusicBrainz (the retry
  next). Only the free retry is ever a next-step button; Luna never is. A
  completed run whose MusicBrainz retries ran out and that matched nothing
  reports lookup unavailable, or release details that could not be fetched,
  never no match. Where the server cannot run lookup (`lookupAvailable` false)
  the summary says it is not configured, before any run too, and offers neither
  a retry nor the name box. Stale files are counted. While the applied release's
  front artwork is being staged (`waiting.cover`) the summary says Publish waits
  for it; a staging that failed or was skipped is not shown, and the cover
  choice stays as it was.
- **Name box.** An Album or song name and an **Artist (optional)** field,
  whose hint says that an empty field uses the files' artist tags; a
  folder-name run prefills the folder name for editing, a submitted run its
  name and any Artist name submitted with it. **Look up** stays disabled
  while the name is empty, whatever the Artist field holds, and an empty
  Artist field is not sent. A link in either field is refused in place
  (`Enter a name, not a link`), and the box has no autocomplete and stores
  nothing. It is a plain form, never the search landmark, and the
  administration layout still has no global search.
- **Luna AI.** In every lookup state, also where lookup is not configured and
  after a release was applied, **Use Luna AI (paid)** comes after the summary's
  lookup controls (the retry, the name box and the candidate chooser, where
  shown) as a secondary button: never the next step and never styled as the
  primary action. It stays visible, disabled while Luna cannot start (without
  analysis access or the import's analysis capability, while an analysis is
  queued or running, after an unknown provider outcome, with no runs left for
  the project, or while the publication is locked or its cleanup is pending),
  and opens the confirmation described under Luna ticks. Status
  text about Luna work names Luna AI.
- **Needs an answer.** A tie lists each group's representative with only the
  proposal values that differ (title, Artist entries, label, date, tracks) and
  its barcode, catalogue number, country and medium, plus **Use none of
  these**; a conflict with the administrator's own value shows both values with
  **Keep mine** and **Use lookup value** (`/lookup/resolve` bound to the saved
  value); one that differs only in MusicBrainz IDs is headed "MusicBrainz ID
  differs" and shows each entry's or the label's name with its ID. Identity
  questions, including keeping or replacing a reused record's ID, stay in
  Review and the confirmation; the summary counts the rows the server says still
  need one. The candidate chooser discloses how many files have an unknown
  duration or Disc Number, which ranking never counts as agreement, and says
  when not every release MusicBrainz found was compared with the files. It marks
  each iTunes-only candidate "iTunes only", and "Not checked against
  MusicBrainz" when it is `notChecked`.
- **Offered, not needed.** The only matching group of a partial comparison
  (see Planning and ranking under [Metadata lookup](#metadata-lookup)) is not
  applied, since more matching releases may exist among those not compared.
  Until a release or none is chosen for that run, the chooser shows it like a
  tie, with every proposal value and **Use none of these**, but it is no tie:
  it is not counted as an answer and never holds Publish. A release applied as
  a preselection stays choosable while a tie needs an answer, so a re-rank
  that leaves a tie can be answered with it.
- **Artwork previews.** The candidate chooser shows a preview beside each
  listed release whose `artwork` flag is set, loaded from
  `GET /imports/:id/lookup/candidates/:key/artwork` with the `viewer` query
  parameter and "Front artwork of this release" as its text alternative. Each
  release's preview appears once: beside it in the tie or single-choice view
  when it represents a group there, else in the folded list once that is
  opened. At most two previews load at a time, in the order shown, as Cover Art
  Archive serves two; a preview that fails is tried once more two seconds
  later and then hidden. The browser never loads a Cover Art Archive or iTunes
  artwork address.
- **Flagged, never folded.** Values resting only on file tags (automatic and
  not on the applied candidate), values resting on an applied iTunes-only
  candidate (marked "iTunes only", and "Not checked against MusicBrainz" when
  MusicBrainz did not rule it out), a preselection whose artist matches no
  artist tag, directly or through an alias or iTunes localized name the lookup
  found, and pending Luna suggestions with their ticks.
- **Expected tracklist.** When the saved Album decision appends to an Album
  that has an expected tracklist (`appendTracklist`, until the publication is
  complete), the summary, under
  "Album's expected tracklist", says how many of the Album's missing-file rows
  the appended files fill, then lists each file the append adds (the saved
  track decision, else its preselection, neither skips nor reuses it) in
  approved order, never folded, with the shown draft's Disc Number (unknown as
  1) and Track Number, unsaved changes included, its title or filename, and
  the row those numbers reach or No row. `importAppendRows.ts` places the files
  as the server places members and flags: no Track Number; no Disc Number while
  the tracklist has more than one disc; a position outside the tracklist; a
  row an existing member already fills or another listed file also reaches; a
  duration that differs from its row's by more than `durationToleranceMs`, one
  more second for a legacy whole-second duration (both known). Flags need no
  answer and never hold Publish. While `numbering` is not empty, **Number from
  the Album's expected tracklist** (an ordinary secondary button after the
  flagged values and before Luna AI, never the next step) saves it as one
  `PATCH /imports/:id` field save of each proposed file's
  `tracks.<slotId>.discNumber`, `.trackNumber` and, where proposed, `.title`,
  with the saved values as `base`, so they become the administrator's own. It
  is disabled while other saves are (unsaved editor changes included), while
  the publication is locked, and while the summary read is of another revision
  or automatic-write revision; a changed numbered value is
  `409 ADMIN_IMPORT_FIELD_CONFLICT`, after which the page reads the project and
  the summary again, as for any field conflict.
- **Folded.** Every other row: title, Artist entries with roles and join
  phrases, label, date, visibility (changed in place by a field save, public by
  default), cover (one chosen automatically says so, and a lookup cover is
  named Cover Art Archive front artwork with the first eight characters of its
  release MBID, or iTunes artwork with the first eight digits of its collection
  ID), the disc and track order, saved identity decisions, upload progress,
  answered conflicts, and all candidates when there is no tie. An append marks
  the Album values, their conflicts and Album Luna suggestions not applied.
- **Publish.** Disabled while the server says it waits for uploads, lookup,
  the applied release's cover staging or analysis or this browser is still
  uploading, while a tie, a conflict or an identity row (`identityAnswers`)
  needs an answer, or while a new Album's credit rests only on a placeholder
  (said at once, unless the unsaved changes Publish includes add a primary
  Artist entry); otherwise it opens the same one-step confirmation as the
  Publish section.
- **Luna ticks.** The summary state gives each pending suggestion the editor
  shows a tick state: `ticked` for an empty value or one resting only on file
  tags, `unticked` for any other, `resolved` when it already equals the current
  value (Artist entries by name, role and join phrase, a label by name, IDs
  aside), or `conflict` when its value changed since analysis and is the
  administrator's own (Artist entries whenever they changed), which cannot be
  ticked. Label and Disc Number suggestions tick like the others. Toggles are
  kept in the workspace for the confirmation; unticking leaves the current
  value, and **Apply ticked suggestions now** accepts the ticked ones and
  rejects the rest through `/adopt`. The confirmation's candidate read also
  covers every pending Luna proposal (`/duplicate-candidates`), so a ticked
  title, Artist entry or label is preselected there as if it were applied, and
  the approval freezes that preselection. Only a ticked row that still needs an
  explicit answer (a record shares its name and nothing is preselected) holds
  the confirmation; then it offers the same **Apply ticked suggestions now**,
  which saves them to the draft and closes it, so Review can answer that row. A
  suggestion equal to the current value is hidden from the summary but stays
  pending in storage, and Review still lists it as already matching, until an
  approval accepts it. **Use Luna AI (paid)** opens the same confirmation as the
  Draft section's button of that name (**Use Luna AI again (paid)** after a
  run), titled "Use Luna AI? This is a paid AI service", which shows the Luna AI
  runs and paid AI calls left for the project and the paid Luna AI calls left
  today and starts nothing until **Start paid Luna AI** is chosen.
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
match. Its confirmation lists the title, the byline and each Artist entry with
its role and join phrase, the label or No label, the date, the
visibility, the cover, and the identity of the Album, each entry and the label:
New, Reuses a named record (marked Hidden when it is), Needs a decision, Match
changed (the reused record is not listed at its reviewed revision), or Not
applied for an append, whose title, date, visibility and cover rows say so too.
Beside an entry or the label it names the MusicBrainz ID the publication
records on its new or reused record ("records MusicBrainz ID") or replaces on
a reused one ("replaces MusicBrainz ID", with the old and new ID), and sends
that list as `musicBrainzIds`; an append lists none. Pending Luna suggestions
are written into the shown draft as the summary ticks them (a suggestion whose
path the unsaved changes also write stays unticked). A ticked row is preselected
as if it were applied, since the candidates were read for it too; it says
**Needs a decision** only when a record shares its name, and then the
confirmation offers **Apply ticked suggestions now**. Decisions bound to an
entry or label a ticked suggestion replaces are left out of the checklist, as
the approval drops them. A Luna row counts the suggestions applied and kept.
The tracks the approval adds follow in approved order, Disc Number (unknown as
1), then Track Number (unknown last), then draft order, followed by an existing
Album's members, named by their catalog title (or draft title while the match
changed) without a position, which the append leaves unchanged; skipped tracks
are left out. The confirmation always reads the duplicate candidates, since
the preselections depend on them, and a row without an explicit decision shows
its preselection as New or Reuses; a row renamed in the unsaved draft (an entry,
the label, the Album title or, in an append, a track title) to a value neither
saved nor proposed by a pending Luna suggestion is not preselected, because no
candidates were read for it. The approval carries the preselections the
confirmation shows, so the server freezes exactly those or asks for a fresh
review. The Artist entries and the label are marked "From file tags only" while
they are automatic, not written by metadata lookup (`lookupPaths`), and the
approval neither changes them nor shows an explicit identity decision for them,
saved or unsaved (never for an append; a preselection is not one), and an
automatic entry named like a company says it may be a label. Approve stays
disabled while the candidates load, reload or fail, while any row
is neither answered nor preselected, or holds a changed match, and while
Review's unsaved decisions are in conflict as described above. Only a changed
approval digest makes an open confirmation stale, so Luna, uploads and
automatic values that change nothing it shows leave it current. Approving
sends the unsaved changes, Review's unsaved decisions and the summary's Luna
ticks with the approval; a refused approval keeps all three, and a confirmed one
leaves the editor showing the saved draft. If the Web was updated after the page
loaded and the confirmation cannot load its checklist, it asks for a reload and
Approve stays disabled, while the page and its unsaved edits stay open.

For an append, the confirmation also reads the summary state, and Approve waits
until that read answers. The rows are information only, so a failed read shows
an error and no rows without holding Approve (pending Luna ticks still need the
read to succeed); reopening the confirmation reads it again. When the state has
`appendTracklist` for
the Album the shown decisions append to, the confirmation lists under "Album's
expected tracklist" how many missing-file rows the tracks the approval adds
fill and the row each one's shown Disc and Track Number reach, or No row, with
the flags the summary describes, derived for the shown draft with its unsaved
changes and without the numbering button; neither the rows nor the flags hold
Approve. When Review's unsaved decisions append to another Album than the
saved ones, it says to save them first instead of showing rows.

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
  - [iTunes fallback and MusicBrainz bridge](#itunes-fallback-and-musicbrainz-bridge)
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
  `null` or `{name, musicBrainzId}`. `musicBrainzId` is `null` or the
  lowercase MusicBrainz artist or label ID that metadata lookup supplied;
  `GET /lookup` lists the names lookup found for each (`musicBrainzNames`).
  Suggestions are Draft v2: `field` is `title`, `artists`, `label`,
  `releaseDate`, `discNumber` or `trackNumber`; an `artists` suggestion
  proposes the whole entry list and a `label` suggestion a label
  `{name, musicBrainzId: null}`. A decision is `{scope, slotId, entryKey,
  boundName, action, candidateId, candidateRevision}`, where `scope` is
  `artist`, `label`, `album` or `track`, `slotId` names the track of a `track`
  decision, `entryKey` the entry of an `artist` decision, and `boundName` the
  entry or label name an `artist` or `label` decision was made for, each `null`
  otherwise. An Artist decision is returned only while its entry keeps its key
  and name, and a label decision only while the label keeps its name.
  `published` stays `null` until the publication is complete, then is
  `{albumId, artistIds, organizationId, trackIds}`: the Artist of
  every entry in draft order and the label's Organization or `null`, or for
  an append the target Album's primary Artists and `null`. An approval frozen
  in format 1 or 2 reads as `artistIds: [artistId]` and `organizationId: null`.
  A project still stored in format 1 reads as its Draft v2 view. Value origins
  (`draftOrigins`) are stored, keyed by value path with `:` in place of `.`
  (`album:title`, `tracks:<slotId>:discNumber`), because MongoDB before 5.0
  refuses dotted field names; they are returned only as markers.
  `automaticPaths` lists the value paths written from file tags or
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
  `POST /imports/:id/select-cover`). The automatic choice prefers the applied
  metadata lookup candidate's ready `lookup-<candidateKey>` cover (see Lookup
  cover staging below); lookup cover slots appear in `assets` in every state
  but `deleted`, so the list holds at most 205 assets. A stored
  `selectedCoverSlotId`, including those saved by earlier releases and by
  every earlier one-step approval, is explicit. Once a publication is active
  or complete, an automatic choice shows the cover that publication froze
  (none for an append). The v1 projection shows the same `selectedCoverSlotId`
  without `coverChoice`. `approvalDigest` is the SHA-256 hex digest of the
  key-sorted JSON of what a publication confirmation shows from the saved
  project: the Draft v2 view, the returned decisions with their bound names, the
  selected cover (`selectedCoverSlotId`, automatic or explicit), each
  returned asset's `slotId`, `state` and `sha256`, and whether the Artist
  entries and the label rest only on file tags (automatic values equal to a
  value the applied metadata lookup candidate wrote do not). Actor,
  capabilities, receipts, `revision`, `valueRevision`, analysis and suggestions
  do not count, and a format-1 project digests as its Draft v2 view, so
  converting it keeps the digest. A publish body echoes it; the Web never
  computes it.
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
  administrator's own (a stored value without an origin counts as the
  administrator's own): then the whole save is refused with
  `409 ADMIN_IMPORT_FIELD_CONFLICT`, nothing is written, and the Web loads the
  saved version for comparison, which is its reload request. Artist entries or a
  label that differ from `base` only in MusicBrainz IDs are not stale: metadata
  lookup adds and removes IDs on the administrator's own values, and the save
  merges them, so an entry (by key) or the label whose `musicBrainzId` the save
  left as `base` had it takes the stored ID, kept only while its name equals the
  stored one case-insensitively, and an ID the save cleared stays cleared.
  Staleness is decided per path by value, not by a stored per-path
  revision, so a value changed and then changed back is not stale. A `base`
  equal to what the editor shows for a stored value it cannot display (a
  format-1 value over a bound after NFC, shown as empty) is current too, so
  that value stays replaceable. A value automation wrote is overwritten. Every
  saved path becomes the administrator's own. The saved draft must stay valid,
  or the save is `400 ADMIN_IMPORT_INVALID_INPUT`: at most 20 entries with
  unique keys, every primary before every featured entry, Artist and label names
  of 1 to 200 characters without control or format characters that differ
  case-insensitively, titles of at most 300 characters (both bounds hold
  before and after NFC normalization), join phrases valid as Credit phrases,
  Disc Numbers from 1 to 999 and at most 48 KB unless the save does not grow
  the draft. A save never adds a MusicBrainz ID: an entry's or the label's
  `musicBrainzId` is `null`, which removes a stored one, or the one stored for
  that entry key (for the label, the stored label's) while its name equals the
  stored one case-insensitively or is a name metadata lookup found for that ID
  (`musicBrainzNames` of `GET /lookup`); anything else is
  `400 ADMIN_IMPORT_INVALID_INPUT`. Renaming or removing an entry drops its
  Artist decision. A whole-draft body (`draft`, nested at most four containers
  deep) from an editor that predates Draft v2 is refused with
  `409 ADMIN_IMPORT_RELOAD_REQUIRED` right after receipt lookup, before the
  publication lock and the operation limit are checked, so a lost response of an
  earlier save still replays and an outdated editor is always asked to reload.
  The JSON limit is 160 KB for this route, 192 KB for
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
  ticks, upload transfers, publication-worker checkpoints, cover staging and
  automatic values add no such receipt, so they never make a change
  stale, while another administrator's change of what it binds still does:
  a decision set built before another administrator's saved decisions, or a
  stop issued before another administrator's re-analysis, is refused with
  `409 ADMIN_IMPORT_REVISION_CONFLICT` and writes nothing. `expectedRevision`
  stays required and in every intent's fingerprint, and receipt lookup comes
  first, so an earlier intent with a numeric `expectedRevision` still replays.
  **Luna schema v2** (`adminImportProvider.ts`, `adminImportLuna.ts`). Luna
  answers with the strict json_schema `album_import_suggestions_v2`: suggestions
  of `{scope, slotId, field, text, number, date, artists, source, evidence}`,
  every unused value slot `null`. The Album chunk may suggest `title`, `artists`
  (the complete ordered entries, each `{name, role, joinPhrase}`, every primary
  before every featured one), `label` (a name) and `releaseDate`; a track chunk
  `title`, `discNumber` and `trackNumber`; at most 4 + 3 × files suggestions in
  all, one per path. It reads the Draft v2 baseline without entry keys,
  MusicBrainz IDs or visibility (the label as its name) and the file tags as
  their five v1 fields; never an identifier. An import's or an existing-Album
  review's analysis captures at admission the MusicBrainz release applied to
  it, if any (a preselected or chosen MusicBrainz candidate whose details were
  fetched; an applied iTunes-only candidate, or none, gives none), only while
  the lookup record still stores that candidate: a later lookup run replaces
  the candidates, so after one that applies no release the values stay applied
  but Luna gets no context. It sends
  the release's title, credited names and join phrases, label
  names, date, first-release date, media positions and formats and, per track,
  position, number, title and length, labelled
  `{source: 'musicbrainz', kind: 'appliedRelease', trust: 'untrusted'}` as
  `lookupContext`. Release, release-group, artist, label and recording IDs,
  ISRCs, barcode, catalogue number, artwork flags, other candidates and iTunes
  evidence are never sent; a catalog review's input also names its purpose
  (`catalogReview`). Each chunk cuts the
  context deterministically so its whole input stays within 48 KB (the longest
  track prefix in medium and position order, `truncated: true`, or none when
  even its header does not fit), and each suggestion of a chunk that sent it
  stores `lookupContext: {source, releaseId, digest, truncated}` (the SHA-256 of
  the JSON sent), server-side only. Validation is all or nothing
  (`providerInvalidResponse`): an unknown or identity key such as
  `musicBrainzId`, `key` or `candidateId`, identifier-shaped text (a UUID or 24
  hex digits) in a title, label, name or evidence, entries that break the Draft
  v2 entry rules (featured before primary, a repeated name, an invalid join
  phrase, control or invisible formatting characters, more than 20), a value
  outside its field's range or over-limit counts refuse the whole response. A
  Luna entry whose name folds to a baseline entry's (equal after NFC and
  lower-casing) takes that entry's key and MusicBrainz ID, so an unchanged
  entry's decisions survive and a case-only correction keeps the ID as such a
  rename does; another gets a key derived from the suggestion and no ID, and a
  label never carries one. A placeholder Artist or label drops only that
  suggestion, and in a catalog review so does a Disc Number for a track whose
  source captured none. An analysis an earlier release queued on a format-1
  project stores v1 suggestions (one plain primary entry as `artistName`,
  nothing else new). Stored v1 suggestions are still read. The frozen v1
  validator remains only as the reference the v1 golden test replays; no
  production path calls it. An accepted suggestion becomes the administrator's
  own; accepting one whose baseline is no longer the current value returns
  `409 ADMIN_IMPORT_FIELD_CONFLICT`, so an Artist suggestion never replaces
  entries that changed since its baseline, automatic ones included, while any
  other current value written automatically (from file tags or metadata lookup)
  after that baseline is replaced, as a field save would replace it. Accepting
  an `artists` suggestion keeps the decisions of the entries whose key and name
  it leaves unchanged. Accepting a label suggestion that names the current label
  keeps that label, its MusicBrainz ID and its decision, whatever its baseline,
  and makes it the administrator's own. Imports never suggest
  a stand-in: Luna Artist entries naming one such as Various Artists or
  `[unknown]`, or a label such as `[no label]`, are dropped, and a stored one is
  hidden, never holds the approval and is not counted as pending in the
  workbench list. Accepting a suggestion the editor does not show, such as that
  hidden one, returns `409 ADMIN_IMPORT_SUGGESTION_STALE`; rejecting it is
  allowed. `/decisions` replaces the whole list with at most 122 decisions, at
  most one per Artist entry, the label, the Album and each track, and each
  decision must be one flat record of at most 1 KB before the intent is
  fingerprinted. An `artist` decision binds the entry its `entryKey` names and
  that entry's name; a `label` decision binds the label's name. Each carries the
  name it was made for as `boundName` (`null` for `album` and `track` decisions,
  otherwise `400 ADMIN_IMPORT_INVALID_INPUT`), and a `boundName` that is not
  exactly the saved entry or label name means the decision was made for a value
  since renamed: `409 ADMIN_IMPORT_DECISION_STALE`, nothing written, also while
  appending. An `artist` decision for an entry the draft does not have, a
  `label` decision without a label, or two entries reusing one Artist is
  `400 ADMIN_IMPORT_INVALID_INPUT` and writes nothing. A reuse names a ready
  record at its reviewed revision, for the label an Organization of any type, or
  the save is `409 ADMIN_IMPORT_DUPLICATE_STALE`; while the Album decision
  appends, an entry's or the label's reuse is kept without that check, since an
  append applies neither. A body whose decisions lack `entryKey` or `boundName`
  comes from an editor that predates several entries or bound names and
  returns `409 ADMIN_IMPORT_RELOAD_REQUIRED` right after receipt lookup, so a
  lost response of an older body still replays. A reuse or create-distinct
  decision makes the Artist entries, or the label, the administrator's own; a
  skip does not. Unless the Album decision appends, publishing needs a reuse or
  create-distinct decision still bound to every entry and to the label unless
  the review preselects it (no candidate, or a record holding its MusicBrainz
  ID, see `/publish`), so renaming an entry or the label to a name that has a
  candidate makes publishing return `409 ADMIN_IMPORT_REVIEW_REQUIRED` until it
  is decided again. A preselection is never saved: a body item carrying
  `preselected` is invalid input. An `artist` or `label` decision also binds the
  entry's or label's MusicBrainz ID, server-side only (`boundMusicBrainzId`,
  never a DTO field or request item; a decision saved before entries carried IDs
  binds none), so changing the ID clears the decision as a rename does.
  `replace` (an `artist` or `label` decision only, otherwise `400`) reuses a
  record like `reuse` and replaces the MusicBrainz ID it holds with the entry's:
  the entry or label must carry an ID (`400 ADMIN_IMPORT_INVALID_INPUT`) and the
  record must hold a different keepable ID at its reviewed revision
  (`409 ADMIN_IMPORT_DUPLICATE_STALE`). Two entries may not reuse, or reuse and
  replace, one Artist. The v1 DTO never shows a `replace`.
- `GET /imports/:id/duplicate-candidates`: bounded candidates; a name match is
  never verified identity or automatic reuse. Candidates are read from the
  Draft v2 view, and each distinct Artist entry name, label name and Album
  title is matched on its own, exactly and case-insensitively: at most 20
  ready Artists per name (kind `artist`), 20 ready Organizations of any type
  per label name (kind `organization`, `albumId` `null`) and 20 Albums per
  title, beside at most 20 Track title candidates. Verified byte matches are
  read on their own: for each staged file's hash, the first ready Track outside
  the saved append target whose stored hash is bound to its current object, so
  at most 100, and no number of same-title Tracks hides one. Every ready Track
  on an Album candidate or on the saved append target whose verified bytes or
  exact title match a staged file is then added once (the global Track rows
  could leave it out), at most 300 of them. `/duplicate-candidates` also reads
  the names and titles the pending Luna proposals the editor shows would write,
  each on its own so that no number of records sharing the saved value hides a
  proposal's candidates, or the reverse: Artist entry names (at most 40 in all),
  one label name and one Album title beside the saved ones, and up to 20 more
  Track candidates for the proposed track titles no saved title matches. A
  ticked suggestion is thus preselected as if it were applied; the summary's
  `identityAnswers` still counts the saved draft only. Proposed track titles
  share the 300 member matches with the saved ones, so past them Review and
  the confirmation preselect no append file even for the saved titles, and an
  approval then asks for each append file's explicit answer
  (`409 ADMIN_IMPORT_REVIEW_REQUIRED`, writing nothing). That makes at most
  1320 name, byte and member items. `memberMatchesComplete` is `false` when more
  such member matches exist or one of them is malformed; the Web then preselects
  no append file. `unavailable` lists `{kind, label}` for each Artist name,
  label or Album title (at most 44) whose same-name record is malformed (a
  stored visibility other than public or hidden): it is no selectable candidate,
  but its row is never preselected. Names compare after NFC normalization and
  locale-independent lower-casing. For the entries and the label that carry a
  MusicBrainz ID, one query per kind adds the ready record holding each ID
  (`match: 'musicBrainzId'`, at most 21, upgrading a row already listed by
  name), and one query per such entry or label adds up to 20 ready records named
  as metadata lookup found for its ID (`match: 'alias'`, `aliasOf` the ID, from
  at most 32 stored names). Then, for each Artist name read (the saved entries'
  and those pending Luna proposals would write, at most 40) that has iTunes
  localized names on the import (`localizedNames`, see [iTunes fallback and
  MusicBrainz bridge](#itunes-fallback-and-musicbrainz-bridge)),
  one query adds up to 20 ready Artists named with another name of its group
  (`match: 'localizedName'`, `localizedOf` the name it was read for, upgrading
  a row listed by name only, never one listed by ID or alias): at most 2561
  items. Such a row blocks a preselected create of the entry or proposal with
  that name; since a row is listed once, another name read whose localized
  name it also is (a second entry of the same group, or a name beside the
  entry whose ID or alias lists it) is made `unavailable`, so its create is
  not preselected either. A label has no localized names. An Artist
  or Organization item names the ID it holds in `musicBrainzId` only when it
  holds a keepable one; a malformed same-ID, alias or localized-name record
  makes its entry's or label's name `unavailable`. All reads of one
  request share a 10-second budget, each query at most 3 seconds. The editor
  loads this on opening Review and with every publication confirmation. Review
  preselects as reuse the record holding an entry's or the label's ID (unless
  another row's explicit reuse or replace, or an earlier preselection, names it)
  and shows its other candidates without needing an answer; a record holding a
  different ID is offered as reuse that keeps its ID, and as reuse that
  replaces it while no listed record holds the entry's ID, beside creating a
  distinct record. The publication confirmation shows a saved replace that is
  no longer possible (the record holds no other ID, or a listed record holds
  the entry's) as a changed match that blocks approval, as the server would
  refuse it.
- `POST /imports/:id/assets/:slotId`: one multipart `file`; `Idempotency-Key`
  and numeric `If-Match` form the upload intent, which reserves its private
  object identity before S3 work. Admission binds slot state and that intent,
  not the project revision: the slot must hold no asset other than a deleted
  or confirmed-failed one, which moves to the slot's history, and no
  publication may lock the sources. `If-Match` stays in the intent hash, so a
  replay of the original intent still matches its receipt, and only the
  administrator who started an upload may replay it. Analysis checkpoints,
  draft saves, automatic values, completed uploads and cover staging never
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
- `POST /imports/:id/select-cover`: explicitly choose a ready manual, embedded
  or lookup artwork slot, or `null` for No cover. Choosing makes the cover
  choice explicit for good; nothing turns it back to automatic. Until then the
  choice is automatic. It first selects the ready `lookup-<candidateKey>` cover
  of the applied metadata lookup candidate, while, and only while, that
  candidate is applied (a cover staged for a candidate no longer applied is
  never selected). Without one (no candidate applied, none chosen, a release
  without front artwork, or a staging that failed, was skipped or is
  unresolved), each audio upload records at admission the SHA-256 of its
  validated embedded front image, or none, and the import selects the ready
  `embedded-*` candidate, first in manifest order, of the one image every
  confirmed audio file carries, ignoring files whose saved track decision is
  `skip` (they become no track). It selects nothing when such a file carries
  none, carries another image or has no evidence (an upload admitted before
  automatic covers has evidence only through its own per-file candidate), or
  when that image has no ready candidate (the staging bound kept it out, its
  staging is unresolved, or the candidate was removed). A saved Album decision
  of `reuse` or `skip` deselects every automatic cover, lookup or embedded, and
  `create` selects it again. The automatic choice is stored nowhere and
  recomputed on every read, so a changed file set (an upload, a reconcile, a
  removal or a replacement) or applied candidate re-evaluates it. Uploading a
  manual cover never selects it. Moving an explicit choice away from a lookup
  cover lets the lookup cover pass clean that cover once its candidate is no
  longer applied. A choice binds the cover state the administrator saw:
  `expectedRevision` must not predate the last cover selection, approval or
  staged cleanup, and a chosen slot must hold a ready image admitted no later
  than that revision, so a stale tab never overwrites another administrator's
  choice or selects a replaced image unseen
  (`409 ADMIN_IMPORT_REVISION_CONFLICT`). Uploads of other slots, Luna,
  automation and worker steps never make it stale.
- `GET /imports/:id/assets/:slotId/preview`: protected staged artwork preview.
- `GET /imports/:id/lookup` and `POST /imports/:id/lookup`, `/lookup/retry`,
  `/lookup/choose` and `/lookup/resolve`: the import's metadata lookup view, a
  submitted name, a manual retry, a candidate choice and conflict answers; and
  `GET /imports/:id/lookup/candidates/:key/artwork`, a candidate's transient
  artwork preview (see [Lookup routes](#lookup-routes)).
- `POST /imports/:id/publish`: explicit reviewed approval, then asynchronous
  fixed-identity publication; `/resume-publication` reconciles that approval's
  original operation ID rather than creating another Album. The body is
  `{operationId, expectedRevision, changes, decisions, selectedCoverSlotId,
  approvalDigest, suggestionTicks}`: the confirmation's unsaved field changes
  in the `PATCH` shape (possibly none), the whole decision set it shows in the
  `/decisions` shape, the cover it shows (`null` or a staged slot, which the
  approval freezes), the `approvalDigest` of the saved project it was built on
  and the Luna ticks it shows (below); each decision carries its `boundName`.
  The Web also sends the optional `preselections`: the rows the confirmation
  shows as preselected, each in the decision shape without `preselected`. Before
  the intent is fingerprinted, `changes` and `decisions` are bounded as `PATCH`
  and `/decisions` bound them (so two entries reusing one Artist are refused
  here), the cover and digest to 64 characters, and `preselections` to at most
  122 well-formed items (each identifier at most 300 characters or `null`,
  `action` `create-distinct` or `reuse`), or the body is
  `400 ADMIN_IMPORT_INVALID_INPUT`. The Web always sends `suggestionTicks`
  `{generation, ticked, unticked}`: the analysis generation and every pending
  suggestion it shows, ticked or unticked, at most 304 distinct suggestion IDs
  (four Album values and three per file) in all, bounded the same way, as
  `/adopt` takes at most 304 IDs. The Web also sends `musicBrainzIds`: each
  MusicBrainz ID the confirmation lists as recorded or replaced,
  `{scope, entryKey, musicBrainzId, replaces}` (at most 21, bounded the same
  way, each a keepable ID). The approval computes the frozen writes and
  refuses any other set, and a body without the field may freeze none
  (`409 ADMIN_IMPORT_REVIEW_REQUIRED` otherwise, as for two Artists that would
  record one ID), so an editor that did not show the IDs never records one. Each
  frozen Artist and the label carry `musicBrainzIdWrite`
  (`{musicBrainzId, replaces}` or `null`), and the publication freezes the names
  lookup found for each carried ID (`musicBrainzNames`) for the worker's alias
  recheck; `schemaVersion` stays 3 (the fields are optional). The commit records
  each write, a reused record only while it still holds what the review saw (a
  stored value that is no keepable ID, such as a placeholder's, counts as none),
  and a duplicate key on a MusicBrainz ID index is needs attention with
  `identityConflict`, minting nothing; an append records no ID.
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
  `boundName` is `409 ADMIN_IMPORT_DECISION_STALE`), the changes as `PATCH`
  saves them, decisions whose entry or label the changes renamed or removed are
  dropped (so that entry needs a new decision,
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
  needs an Album title, and a new Album also at least one primary Artist entry,
  or it is `400 ADMIN_IMPORT_DRAFT_INCOMPLETE` before anything is frozen. A new
  Album's entries and label need the decisions described under `/decisions` or a
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
  `409 ADMIN_IMPORT_PUBLICATION_UNSUPPORTED`. Right after the changes are saved,
  the tick state is applied (`adminImportLunaTicks.ts`): each pending suggestion
  the editor shows that does not already equal its current value must be listed
  as ticked or unticked (`409 ADMIN_IMPORT_REVIEW_REQUIRED` otherwise), each
  listed one must still be shown pending in that generation
  (`409 ADMIN_IMPORT_SUGGESTION_STALE`), and a ticked one whose value changed
  since analysis is `409 ADMIN_IMPORT_FIELD_CONFLICT`. Ticked suggestions are
  accepted as `/adopt` accepts them, unticked ones rejected and resolved ones
  accepted, in the same transaction, so identities are read, and preselected,
  for the values they write, as `/duplicate-candidates` read and preselected
  them for the confirmation. A body without `suggestionTicks` comes from an
  editor that predates ticks: it is admitted only when nothing is left to
  answer, and otherwise is `409 ADMIN_IMPORT_RELOAD_REQUIRED`. Pending
  suggestions never hold the approval; a queued or running analysis still does
  (`409 ADMIN_IMPORT_REVIEW_REQUIRED`). A stored value the editor cannot show
  (it reads as empty there) is also `400 ADMIN_IMPORT_DRAFT_INCOMPLETE`, so it
  is never frozen. Metadata lookup holds it too, read in the same transaction: a
  queued, running or automatically retrying lookup, or a lookup cover staging
  queued or running within its grant, is `409 ADMIN_IMPORT_LOOKUP_ACTIVE`, and
  an unanswered tie or conflict (see [Value application](#value-application)) is
  `409 ADMIN_IMPORT_REVIEW_REQUIRED`, checked against the draft the approval
  saved, so a change that makes a conflict equal answers it. An append ignores
  conflicts on Album values. A stopped, unavailable, superseded or completed
  run never holds it as active; a tie of the current run or an unanswered
  conflict of the applied candidate still does, whatever the current run's
  state. An admitted approval writes the lookup fence. The approval freezes the
  Draft v2 snapshot with `schemaVersion` 3, its decisions, including each
  preselection it applied, and, for each Artist entry and the label, the
  reviewed record to reuse or an ID reserved for a new one, so a retry or resume
  never mints another identity. `artists` lists
  `{entryKey, artistId, newArtist, candidateRevision, musicBrainzIdWrite}` in
  Credit order, for an append the target Album's primary Artists with
  `entryKey` `null` and no `musicBrainzIdWrite`; `label` is
  `{organizationId, newOrganization, candidateRevision, musicBrainzIdWrite}`
  or `null`; and the top-level `artistId` and `newArtist` mirror the first
  Artist. The approval makes every draft value the administrator's own; each
  entry's join phrase is kept on its Album Credit, and on a MediaTrack's Credit
  only while the next Album Credit is also a primary. No route returns
  `ADMIN_IMPORT_PUBLICATION_UNSUPPORTED` any more; the worker keeps it only as
  its internal signal for an approval format it cannot commit
  (`unsupportedVersion`). Inside the same transaction the approval reads the
  duplicate candidates again and computes the rows the review preselects (see
  Review): a row neither answered nor still preselected, because a candidate
  appeared since review, is `409 ADMIN_IMPORT_REVIEW_REQUIRED` and writes
  nothing, while a lost-response replay finds its receipt first. When the body
  carries `preselections`, any other set of computed preselections, candidate
  revisions included, is the same `409 ADMIN_IMPORT_REVIEW_REQUIRED`: an append
  file shown as a new member is never frozen as a reuse, or the reverse, even
  when a member's verified bytes changed without changing the target Album's
  revision. A body without them freezes what the approval computes. The saved
  decisions stay explicit; the frozen `decisions` add each preselection marked
  `preselected: true`, which is never a saved decision, request item or DTO
  field. Before the first copy and again inside the commit transaction, the
  worker recomputes the preselections of a format-3 approval from its frozen
  snapshot, its frozen explicit decisions and fresh candidates; a frozen one
  that no longer holds makes the publication needs attention (internal issue
  `identityConflict`, not projected, like `catalogConflict`) without minting
  identities, the copies already made stay recorded in the publication for
  cancellation and cleanup, and resuming checks again. A format-3 decision list
  in another shape, or candidate reads over their time budget, are a resumable
  catalog conflict (`catalogConflict`), never a passed recheck or an unknown
  storage outcome. No route returns the internal
  `ADMIN_IMPORT_IDENTITY_CONFLICT`. Every format-3 commit also increments one
  identity-fence document (`adminImportAnalysisSlots`, `_id` `identity`, created
  at startup), and so does every existing-Album review apply that resolves
  identities, so concurrent format-3 import commits and review applies
  serialize and a later one rechecks against the records an earlier one
  created. The fence covers only those writers: a record that a format-1 or
  format-2 commit, the Admin Catalog or the Content Manager creates concurrently
  with a commit is not rechecked, since names are never identity keys; the
  unique indexes still refuse a MusicBrainz ID that a concurrent write gave
  another record of the kind.
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
ordinary mutation allowance. Automatic embedded-cover staging, which follows a
ready audio upload, likewise has its own bounded lifecycle receipts. An embedded
image whose SHA-256 matches one that is ready, pending or of unknown outcome is
not staged again, and each import makes at most 16 automatic embedded stagings
(automatic cleanups do not count). A replaced file's image goes in that file's
own `embedded-<slotId>` slot. When the slot still holds the candidate the
earlier upload staged under an automatic receipt, that candidate is first
cleaned up through the cleanup lifecycle like a completed import's (below, with
the uploader as actor), unless it is explicitly chosen, pinned, still settling,
or holds an image another file's current upload carries; the new image is then
staged once it is deleted. Otherwise the new image is not staged, and a failed
cleanup needs attention. A later staging of that slot resumes a cleanup that
stopped before deleting. Embedded assets that an earlier release staged under
ordinary receipts keep them and their existing lifecycle until the import
completes, when unselected ones are cleaned up like any automatic candidate
(below). Lookup cover staging (described below) takes automatic `upload` and
`cleanup` receipts too, keeps at most 4 lookup covers at once and never counts
against the 16 embedded stagings, which embedded stagings likewise never take
from the lookup bound. Automatic values written from file tags and automatic
metadata lookup runs and applications take no receipt of either kind, so they
use neither the 256 ordinary receipts nor the 16 automatic embedded stagings. A
submitted lookup, a manual retry, a choice and conflict answers each
take one ordinary receipt (`lookup`, `lookup-retry`, `lookup-choose`,
`lookup-resolve`), which only the Draft v2 detail lists. The client receives a
bounded recent receipt projection; the original publication UUID remains
available through `publicationRecovery` for durable reconciliation.

**Automatic cover cleanup.** Once an import completes, each automatically
staged `embedded-*` or `lookup-*` candidate is cleaned up through the staged
cleanup lifecycle unless it is the published cover (which is where an approved
automatic cover lives), an explicitly chosen cover, pinned by an
existing-catalog cover operation (`coverConsumers`), or already being cleaned
or removed. That includes the per-file duplicates that releases before
embedded deduplication staged, and imports completed before automatic cleanup
existed; an image the files would select automatically but the publication
never used, such as the first of those duplicates, is cleaned too. A manual
cover is never cleaned automatically, and a lookup cover is cleaned earlier,
once its candidate is no longer applied (see Lookup cover staging below).
The automatic choice is computed in
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
- **Sweep.** A completed import keeps its cleanup state in `media.coverCleanup`,
  which is never projected and never changes `revision`. On ticks that publish
  nothing, the publication worker sweeps the oldest completed import whose
  cleanup is not done, which covers crash recovery, waiting and re-armed
  candidates, and imports completed before this release. It skips projects saved
  in a newer draft format, and looks again a day later at an approval format
  this release cannot read. A stopped pass resumes the same reserved intents
  once its five-minute lease expires.

**Lookup cover staging.** When the applied metadata lookup candidate's fetched
release reports Cover Art Archive front artwork, or an applied iTunes-only
candidate has an artwork address on the fixed iTunes artwork hosts, the server
stages that artwork as the cover candidate `lookup-<candidateKey>`
(`lookup-musicbrainz:<release MBID>` or `lookup-itunes:<collection ID>`). A
MusicBrainz candidate never stages iTunes artwork, the bridge's included. The
job keeps an iTunes-only candidate's artwork address (`artworkUrl`). The code
lives in `src/administration/import/adminImportLookupCover.ts`.

- **Queueing.** The application that applies the candidate records the cover
  job (`media.lookupCover`, never projected, never changing `revision` or
  `valueRevision`) in its own transaction: the worker step that completes a run
  under the run's grant, a re-rank under the confirming administrator's fresh
  one-hour grant, and `POST /lookup/choose` under the chooser's fresh grant.
  Another candidate, or none, replaces the job, so each application gets its
  own staging intent. Applying the same candidate again records nothing while
  its staging is staged, or queued or running within its grant; one that
  failed, was skipped or ran past its grant is queued again under the new
  application's grant, with its own intent. A later run preselecting the same
  release does the same, and so does choosing it again through the API; the
  Web keeps Choose disabled for the applied release, so there an administrator
  retries by choosing Use none of these, or another release, and then this
  release again. Queueing writes no lookup fence: the application's own write
  of the import document already conflicts with a concurrent approval.
- **Publish waits.** While the job is queued or running within its grant, the
  summary reports `waiting.cover` and an approval is
  `409 ADMIN_IMPORT_LOOKUP_ACTIVE`. A failed, skipped or expired staging never
  holds Publish; every settled staging bumps the lookup fence.
- **The pass.** On ticks that publish and sweep nothing, the publication
  worker (which owns private storage) claims one import whose job is due under
  a five-minute lease. Its planning transaction, a system step with no role
  fence, reserves cleanups and decides the staging: an expired grant or a
  closed project skips it, a ready cover already staged for the same candidate
  is adopted without a fetch, another unresolved record in the slot fails it
  without blocking (a failure reconciliation confirmed is replaced instead, as
  an upload replaces one), 4 other lookup covers already kept (not counting
  the cleanups this pass deletes first) skip it before anything is fetched,
  and its own admitted record resumes the same intent.
- **Fetch.** Under the applying administrator's fresh check, the pass fetches
  the release's `front-1200` thumbnail from a URL the server builds, or an
  iTunes-only candidate's artwork rewritten to 1200 pixels (see Cover Art
  Archive artwork and iTunes artwork under [Metadata lookup](#metadata-lookup));
  a job whose key, release ID and address disagree fails as invalid. 404 is
  no artwork; an unconfigured lookup, an unavailable source or an invalid
  image, one larger than 1200 pixels included, fails the staging; a shutdown
  leaves it running for the next pass.
- **Admission and transfer.** The bytes are admitted as a `pending` asset with
  one automatic `upload` receipt under the job's UUID (a replay with the same
  bytes is recognised; different bytes fail as unknown), only while fewer than
  4 other lookup covers are kept (removed ones, and a confirmed failure this
  staging replaces, move to `assetHistory`; else the staging is skipped), then
  transferred with the shared HEAD/PUT/HEAD transfer. A lookup cover record
  never counts as an upload Publish waits for, even while it is pending: only
  the job holds Publish. An unknown outcome fails the staging without blocking
  and keeps its record; reopening the import reconciles it
  (`POST /imports/:id/assets/:slotId/reconcile` accepts lookup slots and
  re-arms the pass), after which a confirmed cover is selected while its
  candidate is applied and cleaned otherwise.
- **Cleanup.** Each lookup cover no longer applied that is neither an explicit
  choice nor pinned is reserved and deleted exactly as completion cleans
  automatic candidates, with the applying administrator as actor. A failure is
  needs attention and is retried by any current administrator with the
  original intent. A lookup cover whose transfer may still land waits for its
  deadline, a pinned cover is checked again a day later (the pass looks again
  at the earliest of these times), and a project a publication locks is
  checked again an hour later; completion hands every lookup cover to the
  completion sweep.

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
until its in-flight provider outcome is checkpointed, or until its
existing-Album review is discarded. Each project permits two
generations and at most 22 calls and the deployment reserves at most 220
attempts per UTC day across all projects, ten tracks per chunk, 4,000 output
tokens/call, 48 KB context and 256 KB responses. `store:false` is sent to the
provider; it is not a zero-retention promise. Credentials, emails, raw music and
absolute paths are not analysis context. Potentially paid ambiguous outcomes
block automatic replay. Production cost/quality measurements and real S3 proof
are separate from mocked tests. Luna schema v2 changes no budget: two
generations, 22 calls, 220/day, ten tracks per chunk, 4,000 output tokens, 48 KB
input, 24-hour grants. Daily reservations are persisted in the same transaction
as a chunk checkpoint; uncertain outcomes and dispatches stopped after
reservation remain counted.

Web **Workbench → Edit or complete existing Album** exposes explicit manual
editing and creation of an existing-Album review (an Album completion). The
Album page's **Complete from MusicBrainz (free)** action reads
`GET /catalog-reviews/eligibility` for the Album's current revision: it waits
disabled while that read loads, offers a retry when it fails, and is shown
disabled with its reason for an Album that cannot have a review. Where the Album
has an unapplied review whose source is current, the page links **Open Album
completion** instead and offers **Start another completion**, which sends
`another: true`; a refused creation reads the eligibility again. While catalog
editing is turned off the page still reads the eligibility and links an open
review, and both creation actions stay disabled. The Album page's hero leads
with the completion: the primary **Complete from MusicBrainz (free)** button,
or, for an open review, its note on its own line above **Open Album
completion** (primary) and **Start another completion**, with any reason the
action is unavailable under the buttons. Each such reason (unsaved catalog
edits, catalog editing turned off, or the Album's ineligibility) is the
buttons' accessible description, and a disabled completion button loses the
accent so it never reads as the live action. **Convert to MP3** and **Refresh
status** follow on a quieter row of their own, with fainter outlines, in the
same keyboard order. On a single-column hero the completion buttons fill their
row. The completion block keeps the primary button's place while its chunk and
the eligibility read load, so the row below does not move, and the Album's copy
is top-aligned with its cover, so rows the read adds only grow the hero
downward. The hero has no separate manual-editing entry: the details form
directly below it is the manual editor.
The action's confirmation says lookup completes the title, release date,
Artists, label, track titles, Disc and Track Numbers, each track's own Artists
and the expected tracklist but not the cover, that nothing changes until the
changes are confirmed and that Luna AI (paid) never starts; where lookup is not
configured the action reads **Create Album completion for manual editing**. The separate
**Album completions** queue retains saved projects when the browser closes.
**Unfinished** includes all unapplied reviews; **Album updated** confirms that
this project's selected fields were applied. Luna progress and the
original-Album update status are shown separately. **Save completion draft**
changes only the private draft and sends only the values edited since the saved
draft was loaded (an edit changed back is no change), so it never overwrites
another value saved meanwhile; **Update original Album** lists every change the
apply can write (see below), lookup-filled and lookup-answered values preselected
and deselectable, and confirms their frozen old/new values. An unapplied review opens on its **Metadata lookup** summary,
above its tabs and loaded as its own chunk (a chunk that cannot load, the
summary's or one it loads, asks for a reload in its place, leaving manual
editing usable): the lookup status with the free **Retry lookup** as its only
primary button, the name box prefilled with the last submitted name and
Artist name or else the saved Album title (its **Artist (optional)**
hint says that an empty field uses the Album's primary Artists), the
candidate chooser (review copy about the Album's tracks, and per candidate
the members it pairs with each pair listed, the missing-file rows it
adds, video or data tracks left out and members no track can pair with),
from two open conflicts **Keep all current** and **Use all MusicBrainz** (or
iTunes), each answering every open conflict in one request, member conflicts
included; the Album's conflicts with **Keep current** and **Use MusicBrainz**
(**Use iTunes** for an iTunes-only result) per row; the values to check (iTunes
only and not checked, an artist mismatch, a label not applicable, values lookup
could not apply); **Track Artists**, one row per member filled from its own
release track, in conflict with the same answers per row, or unchanged with its
reason (no usable track credit, a placeholder, not all its Credits shown, left
out for its characters, length or format, over the review limits, unpaired), and
when the members pair in no single way a line saying so above every member
unchanged as unpaired; the expected tracklist the review keeps, or the one an
open conflict proposes, with each row's members, its rows without a file and the
members outside it; the identity rows (one per artist shared by the Album and
its tracks, naming every entry it covers, and the label) with **Save
decisions**, which sends the whole decision set; and the values that need no
answer, folded, each once. Lookup controls are disabled while a command runs,
offline, while the draft has unsaved or conflicting edits and while the source
is not current, and answers also while a run is active; the summary polls while
a run is active and reads the review detail again when its read shows a newer
revision or `valueRevision`, which lookup applications advance at the same
revision. An open Apply confirmation is disabled once the detail shows another
`valueRevision`, and its apply sends the one it showed, so a run that completed
unseen is refused (`409 ADMIN_IMPORT_REVISION_CONFLICT`) and the page reads the
review again. **Use Luna AI (paid)** (**Use Luna AI again (paid)** after a run)
follows that summary, above the track editor, is never styled as the primary
action and always has its own confirmation, titled "Use Luna AI? This is a paid
AI service", whose confirm button keeps the primary style and repeats **Use Luna
AI (paid)**; its suggestions arrive unticked in **Review Luna AI suggestions**
and change the draft only when adopted.
**Discard completion** (never primary) follows the Luna AI controls on an
unapplied review page, whatever its source status, and ends each unfinished card
of the **Album completions** queue; an applied completion offers none. It is
disabled offline, while Luna AI is queued or running (its description then says
"Stop Luna AI before discarding this completion.") and while the review page's
own change is unconfirmed; unsaved edits do not block it. Its confirmation names
the catalog Album, with the draft title as secondary text when it differs, says
what is lost and that the catalog does not change, puts initial focus on Cancel
and sends the revision it showed. On success, or when another tab already
discarded the review, it forgets the review's editor, stage and command buffers,
removes the review's reads and navigates to the Album page (to the queue when
the source is unavailable), whose action then opens another open completion or
creates a new one; the queue reads itself again, so the card disappears. A
review page whose read (its detail, lookup summary or identity rows) or change
is answered as discarded shows only the discarded notice with Back, and no poll
or window focus reads that review again. A refusal reads the review again and
says why: Luna AI active and applied each have their own message, and a stale
confirmation shows the conflict message; an unknown outcome is retried only with
its original intent. The action loads as its own chunk; one that cannot load (a
deploy replaced it) is left out, while the page, with the summary's reload
request, and the queue cards stay usable.
All `/finitude/admin/*` pages use a
dedicated
administration layout with management navigation, language/account controls and
the Admin/User view switch. Listener navigation, global music search and
playback controls are absent. Switching back to User view restores the listener
layout while retaining the authenticated session, playback state and active Room
connection. Switching to User view on an administration page opens Home as a new
history entry, so browser Back returns to that page, which shows the Admin view
gate as any User view visit does and never restarts a stopped upload queue.
The catalog uses artwork/name entries for Albums, Artists, MediaTracks and
Organizations, with management actions on their detail pages: the hero groups
them, an Album's completion first, then Convert to MP3 (Albums and
MediaTracks) and Refresh status on a quieter row, and the details form below
the hero is where manual edits are made. The inventory
loads separately from editing controls. Its optional `kind=artist`,
`kind=audioTrack` or `kind=organization` query parameter selects a category;
missing or unsupported values select Albums. Detail return links retain that
category. Organizations use a name mark, matching listener details, and do not
gain artwork upload controls. An Album's detail page ends with a read-only Tracks
section listing its member MediaTracks in the order listeners receive: each row
shows its position, title, Disc and Track Numbers and duration when known, Audio
or Video, Hidden for a hidden MediaTrack and the state of a member that is not
ready (unfinished or failed upload, being deleted, not published, media needing
repair, or a missing record), with an empty state for an Album without members.
A member whose own Album link is absent or names another Album is marked Not
linked to this Album, and a note counts stored entries that are malformed or
repeated, since either blocks a catalog review of the Album. A legacy Album's
note says its tracks are listed by title instead of the Disc and Track Number
explanation. Only a ready member links to its own catalog page, where it is
edited; the section has no ordering or member-editing controls and loads in its
own chunk once the Album itself has been read. It rereads after the page's
Refresh once the Album answers, whenever the page adopts a newer Album revision
(a confirmed edit or cover change, Load saved, or a later read such as on
returning to the tab) and after a refused clear. When the Album keeps an
expected tracklist, the section lists its rows by Disc then Track Number
instead, under one ordering note: a row with members shows each member's usual
line, which keeps its number in the order listeners receive (several members at
one position each keep their own line, with no disc headers), and a row without
one shows No file yet with its title, Disc and Track Numbers and duration when
known, without a number or a link. Members at no row's position and missing
records follow under Outside the expected tracklist, in the Album order. An
empty Album with a tracklist shows every row as No file yet instead of the empty
state. A summary names the source (MusicBrainz or iTunes, untranslated), the
date it was applied in the viewer's locale and time zone, its row count and how
many rows have no file; on an Album without a primary Artist Credit (the append
refusal's test, read from the saved Album) that has such a row, a note says only
a Content Manager Audio upload can fill them. On a truncated Album a row's
member may be past the read bound, so no row is marked No file yet, no note is
shown and the summary reads only Expected tracklist. Administrators who may edit
the catalog see Clear expected tracklist. It opens the catalog confirmation,
which shows the summary against No expected tracklist and says that tracks,
files, the Album order and listeners are unchanged, and sends the clear alone at
the Album revision the confirmation captured. It is disabled while a field edit
is unsaved, an operation is running or unconfirmed, the Album changed elsewhere,
the page is offline, or the Tracks list is loading or failed to load, so the
confirmation names rows read after the revision it sends; a stale confirmation
cannot be confirmed. Direct catalog saves also confirm the frozen
partial patch with per-field saved and proposed values, including coupled
Credits with their join phrases and attribution, a MediaTrack's Disc Number and
an Artist's or Organization's MusicBrainz ID. Every Artist and Organization
snapshot names `musicBrainzId` (`null` without one; a malformed stored value
reads as `null` and stays repairable). A `fields.musicBrainzId` patch is a
string of at most 64 characters naming a keepable ID (any case, stored
lowercase) or `null` to clear it; a placeholder identity, a malformed value or
the field on an Album or MediaTrack is `400 ADMIN_CATALOG_INVALID_INPUT`, and an
ID another record of the same kind keeps, in any lifecycle state, is
`409 ADMIN_CATALOG_MUSICBRAINZ_ID_IN_USE` (also for the loser of two concurrent
setters), writing nothing and storing no receipt, so the same `operationId` may
retry. The editor trims and lowercases the typed ID, an emptied field clears it,
and the 409 shows its own message. A newer catalog revision disables
the open confirmation and shows its recovery instruction; cancelling preserves
unsaved edits. Offline or failed reads do not report a revision change without
a confirmed newer item. Analysis uses retained original filenames and saved
metadata; absent historical folder/file evidence stays empty.
No media is uploaded, copied or published by this workflow. Artist attribution,
artwork and visibility remain separate catalog edits: the review draft shows its
Artist entries (the Album's ordered Artist Credits until lookup changes them),
their join phrases and its label read-only, and offers a Disc Number field only
for Tracks whose review captured one. Metadata lookup values and conflict
answers change the Artist entries, the label, each member's track Artist entries
and the expected tracklist only in the review's private draft. **Update original
Album** (`CatalogReviewApply.tsx`, its pure model `catalogReviewApplyModel.ts`)
lists, in this order, the Album's title and date, its Artist entries and label
(current and new Credits, an IDs-only change said as such), the expected
tracklist (the rows kept and the rows it stores, with their missing-file rows
after the selected changes), each Track's title, Disc Number and Track Number,
and one line per member whose Credits change (current and new Credits, every
Credit removed, and its attribution change, such as Unknown → Documented). It
reads the review's lookup summary and its identity read (`GET /candidates`,
whose `selection` names the Artist entry lists and label it shows and whose
`keptTracklist` is the Album's captured tracklist): every review-only item (the
Artist entries, label, tracklist and member lines) and every title, date or
number lookup filled or that a conflict answered with the lookup value arrive
selected, and so does a saved Disc or Track Number at its member's pair position
(a number the administrator fixed, on which lookup re-ranked the pairing); any
other manual or Luna-adopted change arrives unselected, and any can be
deselected. An explicit choice is kept across reads while its item shows the
same saved values (the review draft's value, Artist entries or tracklist, never
what identity decisions resolve), so saving identity decisions never undoes a
deselection; a newer saved or looked-up value needs choosing again. A value
whose lookup conflict is unanswered cannot be selected and says to answer it
first. The tracklist can be selected only while every member its pairing placed
sits at its row after the selected numbers, otherwise its note names each member
off its row. A Disc or Track Number lookup filled through its pairing is
selected only with that tracklist, or alone when the Album's kept tracklist
places the member at a row with the same position, otherwise its note says it
applies together with the expected tracklist; a deselected one waits for
nothing, so it can always be selected again. When the Album's primary Artist Credits change, the step says Album
Credits are never copied to tracks and names each member whose Credits still
credit a replaced Artist. Below the items it lists each Artist and label
Organization the selected lists name: reused (hidden ones marked), created,
named differently by bound entries, or still needing a record, with each
MusicBrainz ID recorded or replaced. **Update original Album** waits while
lookup or Luna runs, while a selected list's identity needs a record (it names
them) and until both the lookup summary read and the identity read of this
revision and value revision are in. Its confirmation, whose copy says only the
listed changes update the Album, shows the same items, identities and note
frozen, and sends
`{expectedRevision, fields, memberCredits, preselections, musicBrainzIds,
expectedValueRevision}`: the selected fields and members, and only the
preselections and ID writes of the identities a selected list or label owns. A
`409` refusal (a new candidate or ID holder, a decided record or ID changed, a
lookup application unseen) reads the review, its summary and its identity rows
again, so a row that needs an answer is shown in the same review, and keeps
nothing to retry. The page's **Review changes to apply** count and the Review
step's empty state count title, date and number changes only. Luna's Artist and label suggestions appear only in a hint panel of the
Review step, which can keep the current values (rejecting a suggestion) but
never adopts one or changes a Credit; acting on a hint is a separate catalog
Credit edit.

A review's lookup summary (`CatalogReviewSummary.tsx`) presents what the server
decides. Its statuses and next steps are the import summary's
(`lookupNextStep.ts`, shared with `ImportSummary.tsx`), in the review's own
words where the import's wording names files, tags or the import: before a
review's first run it says lookup has not run, with the name box next, and where
lookup is not configured (`lookupAvailable` false) it says so and offers neither
a retry nor the name box. It reads `GET /catalog-reviews/:id/lookup` for each
review revision and, while online, every 3 seconds while a lookup is queued or
running or waits on a busy source and every 10 seconds while it waits out an
outage, and the identity rows (`GET /catalog-reviews/:id/candidates`) for each
revision and `valueRevision`. Its name box, candidate chooser and identity rows
load as their own chunks, the first two shared with the import page. The name
box sends `POST /catalog-reviews/:id/lookup`, with `artist` only when the
Artist field is not empty, and refuses a link in either field in place,
**Retry lookup** sends `/lookup/retry`, candidate previews load from `GET
/catalog-reviews/:id/lookup/candidates/:key/artwork`, choosing a release or
**Use none of these** sends `/lookup/choose`, and each answer, and each bulk
answer covering every listed conflict, is one `/lookup/resolve` request, every
answer in it bound to the saved value it was made against. **Save decisions**
sends `POST /catalog-reviews/:id/decisions`; the review keeps them until an
apply sends the identity items its confirmation showed, which the Web's
**Update original Album** does. A saved reuse or replace whose
record the identity read lists at another revision, or no longer lists, is
stale: the server refuses to keep it (`409 ADMIN_IMPORT_DUPLICATE_STALE`), so
its row shows undecided with a note, it takes no candidate from another entry
and every save leaves it out. Each lookup refusal has its own message, as on the
import page, and reads the summary and its identity rows again.

Catalog review routes (relative to `/api/admin/v1`):

- `POST /catalog-reviews`: `{operationId, albumId, expectedRevision, another?}`
  captures a ready Album and up to 100 ready Audio members. The route creates
  through `createCatalogReviewWithLookup` (`catalogReviewLookupRequests.ts`):
  where metadata lookup is available it converts the new review to format 3 and
  queues its one automatic `catalog` run in the creation transaction (the
  catalog trigger below), so the response shows revision 2 while the create
  receipt keeps revision 1, and the review's `lookupGate` is written; a replay
  returns the stored response and queues nothing, and a failure of the
  conversion or of any write stores no review, run or gate. Without lookup the
  review stays format 2 for manual editing. While an unapplied review of the
  Album whose source is current exists (`ADMIN_CATALOG_REVIEW_OPEN`, `409`,
  only its code) creation is refused and stores nothing unless `another` is
  `true`; `another` is optional, part of the fingerprinted body, and anything
  but a boolean is `400 ADMIN_IMPORT_INVALID_INPUT`. A replay answers before
  that check, and a stale revision or unavailable membership keeps its own
  refusal. A creation whose review was discarded inserts nothing: its
  original intent is `404 ADMIN_CATALOG_REVIEW_DISCARDED`, and another body
  under the same `operationId` is `409 ADMIN_IMPORT_OPERATION_CONFLICT`.
  Concurrent creations are serialized (each increments
  `adminImportAnalysisSlots` `catalog-review-creation`, seeded at startup), so
  only one succeeds without `another`: the other runs again and is refused as
  open. Empty Albums are supported; malformed, missing, Video or inconsistent
  members are explicitly rejected.
  Creation does not start analysis. Original filenames are allowlisted
  basenames, never storage keys. Each source Track also captures its Disc
  Number, or `null` when it stores none. The review is stored as Draft v2 with
  read-only context from the Album's Credits: the ready, named primary and
  featured Artist Credits in stored order (at most 20, a name repeated in any
  letter case once at its first Credit, since entries may not share a name
  case-insensitively; such a list does not show every Artist Credit, so it is
  never applied), each keeping its join phrase only
  while the next stored Credit is also shown, and the first ready, named label
  Credit. A draft whose editable values exceed 48 KB, retained filenames over
  24,000 bytes, or a stored title, date, Disc or Track Number the review
  parsers refuse is refused with `400 ADMIN_IMPORT_INVALID_INPUT` and nothing is
  stored; the read-only context is not counted, because it cannot be shortened
  from the review.
- `GET /catalog-reviews/eligibility?albumId=` (registered before `/:id`):
  `200 {eligible, reason, openReviewId, lookupAvailable}`, private no-store,
  writing nothing. `reason` is null when a review can be created, else the
  first refusal creation would give: `albumNotReady` (missing or not ready),
  `membershipInvalid` (not a list, a malformed or repeated member ID),
  `tooManyTracks` (over 100 members), `videoTracks`, `membershipInconsistent`
  (a member linked to another Album), `tracksNotReady` (a missing or unready
  member) or `valuesUnsupported` (values creation refuses as more than a review
  holds: the 48 KB draft cap, retained filenames over 24,000 bytes or a stored
  title, date, Disc or Track Number the review parsers refuse; creation and this
  read share one check). `openReviewId` is the newest unapplied review of the
  Album at its current revision whose source is current (of at most 25 matching
  reviews, newest first; changed, unavailable, applied and newer-format reviews
  are not open, and a discarded review is never found), whatever the reason.
  `lookupAvailable` is whether metadata lookup runs on this server. A
  missing, repeated, malformed or extra query key is `400
  ADMIN_IMPORT_INVALID_INPUT`; the route has the guards of every review route.
- `GET /catalog-reviews` and `GET /catalog-reviews/:id`: independent bounded
  workbench pagination and private readback. `sourceStatus` distinguishes current,
  changed and unavailable sources. For a review captured for metadata lookup
  (format 3), `changed` also covers each Artist and Organization its captured
  Credits name (the Album's and every member's) that is missing, no longer ready
  or at another identity revision, so `capabilities.apply` turns off, applying
  is refused and metadata lookup ends the review's active run (the detail read
  loads the server-only capture for this check only). Old `/imports` routes
  exclude these projects;
  strict native import DTOs are unchanged. The detail's `draft` and
  `suggestions` are Draft v2, as for imports, and each `source.tracks` entry
  carries its captured `discNumber`. A review captured for metadata lookup
  (format 3, below) also carries `draft.album.expectedTracklist` (its rows, or
  `null`) and an `artists` entry list on each draft track; other reviews and
  imports carry neither key, and what the review captured stays server-only. A
  review saved in format 1 reads as Draft v2: its Artist name as one primary
  entry, no label, unknown Disc Numbers and no `discNumber` key on its source
  tracks. Its first admitted change other than `/cancel-analysis` stores that
  view and captures nothing new. The Web editor shows that converted name alone,
  never as a Credits list, because it may not be any Credit of the Album. The
  detail's `valueRevision` counts the draft writes metadata lookup makes without
  changing `revision` (0 for a review lookup never wrote); the Web sends it back
  with each apply as `expectedValueRevision`. The Web's strict detail schema
  requires it, so reload admin Web tabs across deploy or rollback.
  Each list item carries `albumTitle`, the catalog Album's title as the review
  captured it, beside `title`, the draft's (which lookup, Luna or the
  administrator may have changed); a discard confirmation names it. The Web's
  strict workbench schema requires it, so reload admin Web tabs across deploy or
  rollback.
- `PATCH /catalog-reviews/:id` and `POST` to `/analyze`, `/adopt` or
  `/cancel-analysis`: save/review privately with the original UUID and numeric
  revision. Analysis uses the existing import flag, provider and shared budgets;
  viewing, editing or creating a project does not dispatch a provider request.
  Every review change binds `expectedRevision` to the last administrator
  change: any revision from that receipt's to the current one is admitted, so
  analysis progress, which adds no receipt, never makes a save or stop stale,
  while a revision from before another administrator's change returns
  `409 ADMIN_IMPORT_REVISION_CONFLICT`. A PATCH body is
  `{operationId, expectedRevision, changes: [{path, base, value}]}` (at most
  160 KB of JSON; every other review body stays at 96 KB): each changed
  editable value with the value the editor started from (`base`), on the paths
  `album.title`, `album.releaseDate` and
  `tracks.<slotId>.title|discNumber|trackNumber`, each at most once. A save
  naming `album.artists`, `album.label`, `album.visibility`,
  `album.expectedTracklist` or any `tracks.<slotId>.artists` returns
  `400 ADMIN_IMPORT_INVALID_INPUT` before any value is parsed, and so does a
  `discNumber` other than the shown one for a track whose source captured none.
  Staleness is per path, as for an import field save: a change whose saved
  value differs from both its base and its value returns
  `409 ADMIN_IMPORT_FIELD_CONFLICT` while that value is the administrator's
  own, an automatic value is replaced only on a path the save sends, and one
  refused change writes nothing and stores no receipt. Every path a save sends,
  and every value an `/adopt` accepts, becomes the administrator's own
  (`draftOrigins`). The legacy body `{operationId, expectedRevision, draft}`
  with the whole Draft v2 is admitted only for a format-2 review: its
  `artists`, `label` and `visibility` must equal what the review shows, and so
  must the `discNumber` of a track whose source captured none, or the save
  returns `400 ADMIN_IMPORT_INVALID_INPUT`; it records no value origins. A whole
  draft for a format-3 review, or a v1 draft body (an Album `artistName`),
  returns `409 ADMIN_IMPORT_RELOAD_REQUIRED` right after receipt lookup, before
  the revision, applied and limit checks, so a lost response still replays. The
  48 KB cap binds only a save or adoption that grows the editable values: the
  Album's and members' Artist entries, the label and the expected tracklist are
  not counted. `/adopt` refuses
  selecting an Artist-entries or label suggestion with
  `400 ADMIN_IMPORT_INVALID_INPUT`; rejecting one is allowed, and the Web shows
  both as identity hints that can only be kept. Disc suggestions need filename
  evidence and exist only for tracks whose source captured a Disc Number.
  Reviews read through the same allowlist and read-only rule as imports: a
  review saved in a newer format offers neither analysis nor apply, and refuses
  edit, analyze, adopt and apply with `409 ADMIN_IMPORT_RELOAD_REQUIRED`, while
  `/cancel-analysis` stays admitted. A per-path PATCH of a format-3 review
  whose metadata lookup run completed with candidates, and an `/adopt` that
  accepts a Luna Disc or Track Number, re-rank the stored candidates in the
  same transaction, without any request, when the change altered the ranking
  evidence (a member's own Disc or Track Number; a title or date save
  re-ranks nothing): the run's ranking and `lookupGate` are written with the
  change, and a sole preselection is applied to the review's draft only while
  the run has applied nothing (no preselection, choice or none of that run),
  so a re-rank never removes or replaces values an application of the run
  wrote. While lookup is unavailable, or no longer admits the review (its
  Album deleted, not ready or changed elsewhere), the change is saved without
  a re-rank. A failure of that write aborts the whole change, writing
  nothing; the same request is then admitted afresh.
- Metadata lookup admission (review creation where lookup is available, and
  the review lookup routes below, which the Web review summary calls, admit
  it): the first lookup
  admitted for a review
  stores it as format 3, only while its source is current, otherwise
  `409 ADMIN_CATALOG_REVIEW_SOURCE_CHANGED` and nothing is stored. An applied
  review is `409 ADMIN_CATALOG_REVIEW_APPLIED`, and a newer format or a
  format-3 review whose capture this release cannot read is
  `409 ADMIN_IMPORT_RELOAD_REQUIRED`. The capture, kept server-only at
  `catalogCapture`, holds each member's duration (its exact media duration, or
  else its whole-second text) and attribution state (an explicit `unknown`
  kept apart from none); the Album's and each member's ordered Credits as the
  canonical Credit lifecycle reads them (an unmigrated member's legacy Artist
  links as legacy unspecified Credits, an unreadable list as unreadable), each
  with the credited Artist's or Organization's name, MusicBrainz ID and
  identity revision (none for a record that is not ready, so such a primary or
  featured Artist Credit leaves its list incomplete); whether the shown label is
  the Album's first label Credit; whether every primary and featured Artist
  Credit is shown, for the Album and each member (a Credit left out as a
  repeated name, in any letter case, makes its list incomplete, so lookup marks
  it `notApplicable` and applying never writes it); and the Album's expected
  tracklist rows. The draft gains those rows and each member's shown primary and
  featured Artist Credits as entries (keyed per member); the Album's entries and
  label are rebuilt from the Credits read then, keeping the keys of unchanged
  Credits, and carry the records' MusicBrainz IDs; and each source track that
  captured no Disc Number takes the Track's current one, which the draft shows
  where it showed none. Admission adds no receipt and advances the revision
  once, when it converts, and a format-3 review is only checked again, never
  captured again.
- `GET /catalog-reviews/:id/lookup` (the Web review summary reads it, polling
  while a run is active, and calls the two routes after it):
  `200 {lookup, revision, valueRevision, summary}`, read in
  one snapshot. `lookup` is the review's lookup view (`null` before any run;
  see [Lookup routes](#lookup-routes)), `valueRevision` is the detail's (the
  Web reads the detail again when it is newer; reload admin Web tabs across
  deploy or rollback), and `summary` is
  `{waiting: {lookup, analysis}, needsAnswer: {tie, conflicts}, lookupAvailable}`:
  `waiting.lookup` while the run can still send a request (queued, running or
  retrying, within its grant, while lookup is available; read from the run
  itself, never from the review's gate), `waiting.analysis` while Luna is
  queued, running or settling a stopped call (as apply checks both), the
  lookup answers the view's `needsAnswer` lists (a tie and each unanswered
  conflict of the applied candidate that still differs, those on member Artist
  entries and the expected tracklist included; identity rows are read from
  `GET /catalog-reviews/:id/candidates`), and
  whether this server's configuration lets lookup run. An applied review reads
  too; an import or a bad id is `404 ADMIN_CATALOG_REVIEW_NOT_FOUND`, and the
  import lookup routes never find a review.
- `POST /catalog-reviews/:id/lookup` `{operationId, expectedRevision, kind,
  text, artist?}` (`kind` `album` or `song`; text and an optional `artist`
  string of at most 1000 characters each) looks up a submitted name with the
  submitted Artist name, else the review's shown primary Artist names, and
  `POST /catalog-reviews/:id/lookup/retry` `{operationId, expectedRevision}`
  repeats the last run's input and queries (a `catalog` run's too): `202` with
  the review response and receipt `lookup` or `lookup-retry`. Bodies are at
  most 8 KB of JSON, whatever the path's letter case; a malformed one is
  `400 ADMIN_IMPORT_INVALID_INPUT`. Each runs through the review mutation path:
  one review receipt that replays its intent (a changed body under the same
  `operationId` is `409 ADMIN_IMPORT_OPERATION_CONFLICT`), bound to the last
  administrator change like every review change
  (`409 ADMIN_IMPORT_REVISION_CONFLICT` before it), and refused with
  `409 ADMIN_IMPORT_RELOAD_REQUIRED` (a newer format),
  `409 ADMIN_CATALOG_REVIEW_APPLIED` or `409 ADMIN_IMPORT_OPERATION_LIMIT`. The
  run is admitted in the same transaction, which converts the review to format 3
  first: `503 ADMIN_IMPORT_LOOKUP_UNAVAILABLE`,
  `400 ADMIN_IMPORT_LOOKUP_INVALID_NAME`, `409 ADMIN_IMPORT_LOOKUP_ACTIVE` (a
  retry while a run is queued or running),
  `409 ADMIN_IMPORT_LOOKUP_NOTHING_TO_RETRY` and
  `409 ADMIN_CATALOG_REVIEW_SOURCE_CHANGED` refuse it, and a refusal stores
  no conversion, run or receipt. The detail's `receipts` never list `lookup` or
  `lookup-retry`, though they move the review's last-administrator-receipt
  window like any review change; the Web's review response schema already
  accepts both receipt kinds.
- `POST /catalog-reviews/:id/lookup/choose`
  `{operationId, expectedRevision, run, candidateKey}` (the Web review summary's
  candidate chooser) applies a candidate of the current run
  (`musicbrainz:<mbid>` or `itunes:<collection ID>`), or none
  (`candidateKey: null`), to the review's
  private draft (see Existing-Album reviews under [Value
  application](#value-application)), and
  `POST /catalog-reviews/:id/lookup/resolve`
  `{operationId, expectedRevision, run, candidateKey, answers}` answers 1 to 406
  of the applied candidate's conflicts, all or nothing: each answer is exactly
  `{path, answer, base}` on a distinct lookup value path of the review
  (`album.title|artists|label|releaseDate|expectedTracklist` and
  `tracks.<slotId>.title|discNumber|trackNumber|artists`, a slot of this
  review), `answer` `mine` or `lookup`, and `base` the value the answer was
  made against (bounded JSON). Both answer `200` with the review response and
  receipt `lookup-choose` or `lookup-resolve`, which replays its intent and
  which the detail's `receipts` never list. A choice body is at most 8 KB and
  an answers body 512 KB, whatever the path's letter case; a malformed one is
  `400 ADMIN_IMPORT_INVALID_INPUT`. Each runs through the review mutation path
  (the receipt, revision, applied and limit refusals above) and is admitted
  only for a format-3 review whose capture is readable and whose source is
  current: `409 ADMIN_IMPORT_LOOKUP_REFUSED` (an older format, which only a
  submission or retry converts), `409 ADMIN_IMPORT_RELOAD_REQUIRED` and
  `409 ADMIN_CATALOG_REVIEW_SOURCE_CHANGED`. The import refusals follow:
  `409 ADMIN_IMPORT_LOOKUP_STALE` (another run, an active run, an unknown
  candidate, another application, or a path that is no conflict),
  `409 ADMIN_IMPORT_LOOKUP_CANDIDATE_INCOMPLETE`,
  `409 ADMIN_IMPORT_FIELD_CONFLICT` (a `base` that is no longer current) and
  `400 ADMIN_IMPORT_INVALID_INPUT` (an answer that grows the review's capped
  draft past 48 KB). A refusal writes nothing; the review document and the
  lookup record are written in one transaction. An import's ID is not found
  under these routes, nor a review's under `/imports`. The Web review summary
  answers one conflict, or every open one at once, through `/resolve`, each
  answer made against the saved draft's value, and its review response schema
  (`catalogReviewApi.ts`) accepts both receipt kinds.
- `GET /catalog-reviews/:id/lookup/candidates/:key/artwork`: the import
  candidate preview (see [Lookup routes](#lookup-routes)) for a review's
  candidate, with the same guards (`?viewer=<account id>` admitted only on
  this route), private WebP answer, read-only checks and error codes without a
  body; a review's candidate is never found under `/imports`, nor an import's
  here.
- The catalog trigger (review creation calls it where lookup is available):
  `queueCatalogReviewLookup` starts a review's one automatic run in the
  caller's administrator transaction under a `create` grant, from the Album's
  saved title and first usable shown primary Artist name (see [Lookup
  runs](#lookup-runs)). It admits and stores nothing while lookup is not
  configured, rechecks the administrator, converts the review as above
  (refusals included), and queues nothing once the review had its automatic
  run.
- `GET /catalog-reviews/:id/candidates` (the Web review summary's identity rows
  read it and save through `/decisions`, and **Update original Album** reads it
  for its confirmation): `200` the identity rows of the review's default
  selection, every Artist entry list that may be applied and changed (the
  Album's and each member's) and the label when it may be applied and changed,
  which `selection` names (`{lists, label}`), the Album's expected tracklist as
  the review captured it (`keptTracklist`, null without one), with the review's
  `revision` and `valueRevision` (which lookup applications bump without changing `revision`),
  read in one snapshot and writing nothing. Entries crediting one artist share
  one identity across the Album and every member: by MusicBrainz ID, else by
  name case-insensitively; a row (`id`, a UUID handle derived from the review
  and the identity) names the identity after its first entry (the Album's first,
  then members in manifest order), lists its other credited names (`names`),
  each entry it covers (`path`, `slotId`, `entryKey`, `name`, `role`) and the
  records its entries are bound to (`bound`, with their visibility and the
  captured `revision` a `replace` decision names). An Album entry a captured
  Credit shows is bound to that Credit's Artist; a member entry is bound to one
  of that member's captured Artists of any role (the Credit showing it, else the
  first keeping the entry's MusicBrainz ID, else the first whose saved name
  equals the entry's name or a name lookup found for its ID). `state` is
  `bound` (one record: every entry of the identity resolves to it),
  `conflicting` (bound entries naming different Artists: each keeps its own,
  no ID is recorded, and its unbound entries need a decision) or `unbound`
  (the import identity rules decide: the record keeping the identity's ID is
  preselected as reuse, create is preselected without any candidate, and a
  name, alias or localized-name candidate needs a decision). Names found for
  an ID are the review's stored names merged with what its stored run found
  (the applied release's and every track's credited names and the run's fetched
  aliases), so a review whose lookup an earlier release applied still lists
  alias candidates for an artist only members credit; localized-name groups
  naming a member's entry are kept for reviews too (up to 512 groups). Each row
  carries its stored `decision` (rebuilt from its seven known keys), its
  `preselection`, `needsAnswer` and the `musicBrainzIdWrite` an apply would
  make (`{scope, identity, musicBrainzId, replaces}`: recorded while the record
  keeps none and no other record of the kind holds it, replaced only by an
  explicit `replace`). `needsAnswer` marks every row an apply would wait for:
  one without a decision or preselection, a decided `replace` that can no
  longer apply (another ready record now holds the new ID), a decided write
  colliding with any other write (two IDs on one record, or one ID on two
  records; each decided row), an identity whose entry repeats an Artist within
  one list (unless that entry is bound to its record), and a decided reuse or
  replace target that is no longer ready or at another revision. Two colliding
  ID writes that no decision made (two bound identities each recording an
  entry's ID on one record, which no answer can change) are dropped: the record
  keeps what it holds, as for a conflicting identity. `label` is the same
  for the label (bound while it names the Album's first label Organization by
  name, kept ID or a found name), or `null` when the label is not selected.
  `candidates` lists the Artist and Organization candidates
  (`ImportDuplicateCandidate`) and the names whose candidate is unavailable;
  `preselections` and `musicBrainzIds` are the lists an apply of this
  selection must show, each item naming its identity, so a confirmation that
  deselects a list or the label shows only the items of identities it still
  selects. An apply resolves every identity of the default selection before
  narrowing to its own, so what it computes is always this read narrowed by
  identity: a write dropped here stays dropped, and a row marked `needsAnswer`
  must be answered whenever any list holding it (or, for `label`, the label) is
  selected. `album`
  (when its Artist entries or label are selected) and `members` (each selected
  member) give the current and new Credits (`creditId` null for a new Credit,
  `subjectId` null for a record still to be created or an identity not
  answered), whether more than IDs change (`credits`), each member's removed
  Credit IDs and attribution change, the Album's primary Artists its new
  Credits drop (`replacedPrimaryArtistIds`) and the members whose Credits still
  name one of them (`membersNamingReplaced`). An applied review, or one not
  captured for lookup, has no rows; an unreadable capture is
  `409 ADMIN_IMPORT_RELOAD_REQUIRED`, a source that is not current
  `409 ADMIN_CATALOG_REVIEW_SOURCE_CHANGED`; candidate reads over their
  10-second budget are `503 ADMIN_CATALOG_REVIEW_UNAVAILABLE`. Up to 512
  identities are read through one synthetic entry each (the import's 40-name
  query bound is raised for reviews only).
- `POST /catalog-reviews/:id/decisions`
  `{operationId, expectedRevision, decisions}` replaces the review's identity
  decisions (at most 513 flat items of at most 1 KB, each exactly `{scope,
  identity, boundName, action, candidateId, candidateRevision}`: an Artist
  identity by its handle, or the label with `identity: null`, at most once
  each; `action` `reuse` or `replace` naming an ObjectId candidate at a 64-hex
  revision, or `create-distinct` with both null): `200` with the review response
  and receipt `decisions`, which
  replays its intent and which the detail's `receipts` never list. Bodies are
  at most 768 KB, whatever the path's letter case. It runs through the review
  mutation path (receipt, revision, applied and limit refusals) and is admitted
  only for a format-3 review (`409 ADMIN_IMPORT_LOOKUP_REFUSED`) whose capture
  is readable (`409 ADMIN_IMPORT_RELOAD_REQUIRED`) and whose source is current
  (`409 ADMIN_CATALOG_REVIEW_SOURCE_CHANGED`). An item naming a handle that is
  no identity of the default selection (a lookup application, such as a
  candidate choice crediting the name under another MusicBrainz ID, replaced
  it since the read), the label while it is not selected, or a `boundName`
  other than the identity's current name is `409 ADMIN_IMPORT_DECISION_STALE`:
  read the rows again. An action the identity's state refuses (a bound
  identity or label only replaces its record's ID, naming that record at its
  captured revision; a conflicting one only reuses or creates; `replace` needs
  an identity ID) is `400 ADMIN_IMPORT_INVALID_INPUT`, and so are two entries
  of one list resolving to one Artist and a decided ID write landing on a
  record or ID another write of the set lands on (such as identities of two
  lists reusing one record that keeps no ID, each recording its own). A reuse
  or replace target that is not ready, at another revision, or (replace) keeps
  no other keepable ID, and a replace whose new ID another ready record holds,
  are `409 ADMIN_IMPORT_DUPLICATE_STALE`. These checks read ID holders and the
  targets, never candidates. A bound identity's `replace` that can no longer
  apply is answered by a set without it: its record keeps the ID it holds.
  Each stored decision binds its identity's name and MusicBrainz ID
  (`catalogIdentityDecisions`, never projected elsewhere) and applies only
  while both are current; value application never reads it.
- `POST /catalog-reviews/:id/apply`: `{operationId, expectedRevision, fields,
  preselections?, musicBrainzIds?, memberCredits?, expectedValueRevision?}` (at
  most 768 KB, whatever the path's letter case) selects saved Album `title`,
  `releaseDate`, `artists`, `label` and `expectedTracklist` and Track
  `title`/`discNumber`/`trackNumber` paths (at most 305), and the members whose
  Artist entries apply (`memberCredits`, at most 100 distinct slots). Something
  must be selected; `fields` may be `[]` when members are. `preselections` and
  `musicBrainzIds` are what the confirmation showed (`GET /candidates`, at most
  513 well-formed items each); missing ones count as empty, so a body listing
  only members may leave them out (the apply then refuses whenever it computes
  items), but a body selecting the Album's Artist entries, label or expected
  tracklist must carry both (`400 ADMIN_IMPORT_INVALID_INPUT`).
  `expectedValueRevision` is the `valueRevision` that confirmation read (a
  non-negative integer), required whenever the body selects one of those
  fields or lists a member (`400`), since lookup writes those values without
  changing `revision`. A body that sends `fields` without identity items (an
  older Web tab's body, which also sends `expectedValueRevision`) is admitted
  as before and writes no Credits, records, IDs, tracklist or identity fence;
  the Web sends every key, empty lists for a review not captured for lookup. A review
  keeps its last receipt for applying: every other
  change of a review holding 255 receipts, except a discard, is
  `409 ADMIN_IMPORT_OPERATION_LIMIT`, so answers and edits never leave it
  unappliable. Checks, each refusing before any write: analysis active
  (`409 ADMIN_IMPORT_ANALYSIS_ACTIVE`); a metadata lookup run that can still
  send a request (queued, running or waiting for an automatic retry, within its
  grant, while lookup is available; read from the run itself, never the
  review's gate, so a run past its grant or while lookup is unavailable never
  holds apply, and the worker later ends it with `grantExpired`,
  `notConfigured` or `projectClosed`): `409 ADMIN_IMPORT_LOOKUP_ACTIVE`; an
  `expectedValueRevision` other than the review's current one (a run completed
  or a re-rank applied values since the confirmation was read):
  `409 ADMIN_IMPORT_REVISION_CONFLICT`; the
  source (revisions, membership, readiness, filename/media evidence and, for a
  format-3 review, every captured credited record):
  `409 ADMIN_CATALOG_REVIEW_SOURCE_CHANGED`; a review-only selection on a
  review not captured for lookup: `400`; a selected value (members' entries
  included) with an unanswered lookup conflict whose current value still
  differs: `409 ADMIN_IMPORT_REVIEW_REQUIRED` (a tie and unselected conflicts
  never hold apply); a selection that may not apply: `400` (a Track
  `discNumber` only where the source captured one; `artists`, `label`, member
  lists and `expectedTracklist` only while they differ from what the review
  captured; `artists` and member lists only while the review shows every
  primary and featured Artist Credit of the owner, the list holds no two names
  equal case-insensitively and no two of its entries resolve to one Artist
  whatever is decided (each bound to one record, by its own binding or its
  identity's, or both of one identity neither is bound through: no answer
  could tell them apart, so such a list is never in the default selection), a
  member list also non-empty; `label` only
  while the first label Credit is shown or none exists; `expectedTracklist`
  only as the applied release offers it, with its whole pairing stored and
  readable, which pairing-filled numbers need too; titles, dates and numbers
  are applied as saved, even when equal to the captured value); placement
  (`400`): a selected tracklist must place every member its pairing placed at
  its row once the selected numbers apply (an unselected number counts as
  captured), and a Disc or Track Number the pairing filled (automatic) applies
  only as its pair says and only with that tracklist or the Album's kept
  tracklist placing it at a row with the same position; identities, when Artist
  entries, the label or a member are selected: shown preselections or ID writes
  other than those computed now, an identity row without an answer, one list
  resolving one Artist twice or a decided ID write colliding with another
  (`409 ADMIN_IMPORT_REVIEW_REQUIRED`, the review stays usable: a fresh
  `GET /candidates` shows the items to send and marks the row behind each
  other refusal `needsAnswer`), a decided record not
  ready or at another revision (`409 ADMIN_IMPORT_DUPLICATE_STALE`); each
  changing owner's stored Credits as the canonical lifecycle reads them (an
  unmigrated Album's linked Artists included) must equal the captured list
  (`409 ADMIN_CATALOG_REVIEW_SOURCE_CHANGED`); a Credit list the Credit rules
  refuse (such as more than 50 Credits) is `400`; Credit writes turned off are
  `503 ADMIN_CATALOG_REVIEW_UNAVAILABLE`. One transaction then writes the
  reference fences, the identity fence (`adminImportAnalysisSlots` `identity`,
  shared with format-3 import commits, when identities were resolved), new
  Artists and label Organizations (the Album's visibility, a MusicBrainz ID
  only when its write records one, IDs derived from the review, operation and
  identity, so one identity shared by the Album and members creates one
  record, once across retries), ID writes on reused records (only while each
  still holds what was reviewed), each selected member's Credits (its primary
  and featured Artist Credits and its legacy unspecified Credits of the
  Artists its entries name replaced; documented attribution), Track values, the
  Album's Credits (entries take the replaced positions in entry order, extras
  follow the last of them and lead a list without any; the label replaces the
  first label Credit's subject, keeping its phrase, or follows the last Artist
  Credit; other Credits keep their order, orders are renumbered, a phrase
  stays only while its successor is unchanged and an entry's own phrase only
  before the next entry; an entry showing a captured Credit keeps its Credit ID
  and Artist, new Credit IDs derive from the review, operation and entry;
  documented attribution, and each Artist's `albumIds` follows the primary
  Credits), the Album's values, order and expected tracklist (`source` from the
  application, `appliedAt` now), and the receipt with `catalogApplied`
  (`memberCredits` stored, not projected). A list that changed only in
  MusicBrainz IDs writes those IDs and no Credit. Album Credits are never copied
  to members and member Credits never promote an Artist to the Album. A
  MusicBrainz ID that another record took meanwhile (a holder that is not
  ready included) is refused by the unique index:
  `409 ADMIN_CATALOG_REVIEW_IDENTITY_CHANGED`, writing nothing; a reference
  fence or Credit lifecycle conflict is
  `409 ADMIN_CATALOG_REVIEW_SOURCE_CHANGED`. Retries use the original intent and
  replay the receipt; any failure aborts the whole transaction. Applied projects
  become read-only; no upload, S3 or publication endpoint exists for them.
  Reload open admin Web tabs across a deploy or rollback of this API (the Web
  accepts the new applied fields and the `decisions` receipt).
- `POST /catalog-reviews/:id/discard`: exactly `{operationId, expectedRevision}`
  (the default 96 KB JSON limit; anything else is
  `400 ADMIN_IMPORT_INVALID_INPUT` before any database read), with the guards of
  every review route; the transaction rechecks the administrator. A tombstone at
  the ID answers the discard's original intent (operation ID, body fingerprint
  and administrator) with its original `200` and anything else with
  `404 ADMIN_CATALOG_REVIEW_DISCARDED`; a malformed or unknown ID, an import's
  included, is `404 ADMIN_CATALOG_REVIEW_NOT_FOUND`. Then, in order: an applied
  review is `409 ADMIN_CATALOG_REVIEW_APPLIED` whatever `expectedRevision` says;
  an operation ID any receipt of the review used (ordinary, recovery or
  automatic) is `409 ADMIN_IMPORT_OPERATION_CONFLICT`; a newer draft format is
  `409 ADMIN_IMPORT_RELOAD_REQUIRED`; an `expectedRevision` before the last
  receipt's revision or above the current one is
  `409 ADMIN_IMPORT_REVISION_CONFLICT` (Luna ticks and lookup writes add no
  receipt, so they never refuse it); a Luna analysis queued or running is
  `409 ADMIN_IMPORT_ANALYSIS_ACTIVE` (a stopped call still settling is
  admitted). Any source status is admitted, and a discard is never counted
  against the receipt limit. One transaction then replaces the review, guarded
  by the revision it read, with a tombstone at the same ID
  (`purpose: 'catalogReviewDiscarded'`, `actorId`, `createdAt`, `updatedAt`,
  `revision` one past the review's, `albumId`, `discardedAt`, `discardedBy` and
  `receipts` holding only the creation receipt, without its selection, and the
  `discard` receipt) and deletes the review's `adminImportLookups` record; a
  failure aborts both (`503 ADMIN_CATALOG_REVIEW_UNAVAILABLE`), and a write
  conflict is retried, so two requests of one intent sent together both answer
  its original result. It answers `200` with `discarded` (`{id, albumId}`) and
  `receipt` (`{operationId, kind: 'discard', revision}`). Every other `/:id`
  route answers a 404 for a tombstone as `404 ADMIN_CATALOG_REVIEW_DISCARDED`, a
  retried earlier change included, while the candidate artwork preview stays a
  bodiless `404`; the list, the eligibility read, the import routes and the
  lookup worker filter `purpose`, and the Luna worker's claim needs an
  `analysis` a tombstone does not have, so none of them reads a tombstone. A
  replayed creation of a discarded review is
  `404 ADMIN_CATALOG_REVIEW_DISCARDED` (another intent with its operation ID
  `409 ADMIN_IMPORT_OPERATION_CONFLICT`) and inserts nothing. Tombstones stay, a
  few hundred bytes each, with no cleanup job.

The publisher reserves immutable approvals and catalog IDs before copying
objects. It uses version-bound GET and conditional checksum PUT to canonical
storage. Canonical destination PUT uses one SDK attempt and a 90-second deadline
within its five-minute lease, preventing a late SDK retry from recreating a
confirmed-clean object. The publisher checkpoints unknown outcomes and publishes
the ready graph in one MongoDB transaction. An unresolved object never loses its
import evidence. Stopping the server stops new steps and awaits admitted worker
work before closing MongoDB. Required indexes and the global admission record
initialize with normal server startup. Imported Album order follows the catalog
rule: Disc Number, then Track Number, then MediaTrack ID. A new imported
MediaTrack stores its reviewed Disc Number with
`discNumberSource: 'admin-import'`. A track whose Disc Number is unknown,
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
`{operationId, expectedRevision, fields?, visibility?, clearExpectedTracklist?}`
(the last for Albums only; see below). Credits and attribution
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
transaction as the receipt. `GET /catalog/album/:id/tracks` returns that Tracks
list as `{albumId, order, truncated, skipped, tracks, expected}`. `order` is
`declared` (the `Album.audioTrackIds` order, skipping malformed and repeated
IDs as the listener read does) or `legacyAlbumLinks` (a legacy Album without
declared IDs: its ready linked MediaTracks by title, the listener fallback). At
most 500 members are read, the listener Album bound; `truncated` reports more,
and `skipped` counts the malformed or repeated declared entries within that
bound (always 0 for `legacyAlbumLinks`). Each member is `{position, id, title,
discNumber, trackNumber, duration, mediaType, visibility, state,
linkedElsewhere}`, where
`state` is `ready`, `pending`, `failed`, `deleting`, `unpublished` or
`unavailable` (uploaded and published, but its stored object does not belong to
it) and `linkedElsewhere` reports that its own `albumId` is absent or names
another Album, or `{position, id, state: 'missing'}` for an ID without a
record. `expected` is `null` when the Album keeps no expected tracklist or a
malformed one (an `appliedAt` outside years 0000-9999 included), and otherwise
`{source, appliedAt, rows, outsideMemberIds}`: `source` is `musicbrainz` or
`itunes`, `appliedAt` an ISO 8601 UTC instant with milliseconds, and each row
`{discNumber, trackNumber, title, durationMs, memberIds}` in Disc then Track
Number order. The rows are matched when read to the same listed member records
(for `declared`, every lifecycle state and visibility; for `legacyAlbumLinks`,
the ready linked MediaTracks it lists; at most the 500 listed): a member fills
the row at its stored Disc Number (missing or invalid counts as disc 1) and
Track Number, `memberIds` and `outsideMemberIds` (members at no row's position)
follow the Album order, an empty `memberIds` is a row without a file, and an ID
without a record is in neither list (it stays a `missing` member). `tracks`, its
numbering and its states are the same with or without a tracklist. No storage
key, URL, filename, MusicBrainz ID, release, recording or iTunes ID, or revision
is returned; the read writes no catalog record and changes no revision. A
missing or non-ready Album is
`404 ADMIN_CATALOG_NOT_FOUND`. `GET /pages/:slug` and
`PATCH /pages/:slug/items/:itemId` address one Page placement, preserving
reusable definitions and order. Each placement includes bounded `name`,
`sourceMode` (`manual`, `dynamic` or null) and `referenceStatus`
(`ready`, `missing` or `unsupported`) display metadata. The Page digest binds
that resolved metadata, so a referenced name/source change requires fresh
confirmation. A named target is write-fenced with the visibility mutation.
`/artwork` and `/media`
are private previews with current-source and current-role stream revocation.
Unknown commit responses retry the original intent; stale revisions require
reviewing the latest saved state. Client confirmation dialogs retain the opened
revision and exact publication/asset identity; a background refresh invalidates
the confirmation rather than replacing its approved target.

An Album may store an expected tracklist (`expectedTracklist`; format, writers
and privacy in
[catalog.md](../architecture/catalog.md#album-expected-tracklists)). The
administrator Tracks read shows it as `expected`, matched to the members, and
`PATCH /catalog/album/:id` clears it. An existing-Album review admitted to
metadata lookup captures a copy of its rows (see the catalog review routes),
which lookup may fill, or propose another as a conflict, in the review's
private draft (its lookup summary shows them with their missing-file rows);
only applying that review, through its **Update original Album** confirmation
(`POST /catalog-reviews/:id/apply`), sets or replaces it.
`GET /imports/:id/lookup` also
reads an append target's tracklist for its summary (`appendTracklist`, see
[Lookup routes](#lookup-routes)), and the Web shows it in an append's summary
and confirmation. A clear is a top-level `clearExpectedTracklist:
true` with `expectedRevision`, never a field: any other value, the key on
another kind or inside `fields` is `400 ADMIN_CATALOG_INVALID_INPUT` before any
transaction or receipt. After the full revision check (`409
ADMIN_CATALOG_REVISION_CONFLICT`), an Album with no stored value (or `null`)
answers `409 ADMIN_CATALOG_EXPECTED_TRACKLIST_ABSENT` and writes nothing;
otherwise the key is removed (a malformed value too), the Album revision changes
and the response is the ordinary `{item, receipt}`, whose snapshot never names
the tracklist. A clear may be combined with `fields` and `visibility` in one
update; the Web sends it alone. The receipt replays a same-body retry, and the
same `operationId` with another body is `409
ADMIN_CATALOG_IDEMPOTENCY_CONFLICT`. Catalog item, list, PATCH and cover
snapshots never include it, and a PATCH that names the `expectedTracklist` key,
as a field or at the top level, is `400 ADMIN_CATALOG_INVALID_INPUT` like any
other unknown key. It enters the Album revision only when one is stored, so
Albums without one keep their revisions. Rollback floor: none; reload admin Web
tabs across deploy or rollback. A tab from before this release refuses a Tracks
response with `expected`, and a current tab reads a response without the key as
no tracklist.

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
  value. A strange tag never refuses the audio. Evidence stored before version 2
  reads as `version: 1` with its five original values and empty extended fields;
  it is never re-read or backfilled. Luna still receives only the five original
  values.
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
  the import, so it is stable. Placeholder credits such as Various Artists,
  Unknown Artist, `[unknown]` or `[no label]` are never written; a company-like
  album artist is written and flagged in `possibleLabelEntryKeys`. The step runs
  once (`automation.albumAt`): a later replay, check or replaced file never
  repeats it.
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
  (see [Triggers and grants](#triggers-and-grants)). A file removed and uploaded
  again runs its per-file step again, replacing its automatic values and keeping
  the administrator's own. A new upload to a converted format-1 project fills
  only that track's empty values, and no album step runs while other files keep
  version-1 evidence.
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
  their approvals. It reads draft formats 1 and 2, draft format 3 for catalog
  reviews only, and approval formats 1 to 3, and treats a higher number, or any
  value that is not a positive whole number, as newer. Catalog reviews are
  created as format 2 too: a format-1 review is shown converted and stored as
  format 2 at its first admitted change other than stopping analysis. Format 3
  is written only for a catalog review, when metadata lookup is first admitted
  for it (Draft v2 plus its expected tracklist and member Artist entries, with a
  server-only capture); for reviews 4 or higher is newer, and for import
  projects 3 or higher is. An approval is format 1 only with a v1 snapshot (a
  string `artistName`, no artist entries and no Disc Numbers), format 2 only
  with a Draft v2 snapshot of one primary Artist entry, no label and a
  `discNumber` field (a Disc Number or null) on every track, and format 3 only
  with a Draft v2 snapshot whose entries each have a key, a name and a primary
  or featured role, a label that is null or named, a `discNumber` field on every
  track, 1 to 50 frozen `artists` and a frozen `label` that is null or a record;
  anything else is treated as newer, and deeper inconsistencies are a catalog
  conflict at commit. A later release must write a higher number for any other
  shape.
- **Read-only newer drafts.** A project saved in a newer draft format admits
  only staged cleanup and upload reconciliation, publication recovery and
  cancellation, and analysis cancellation, plus replays of stored receipts.
  Every other change, including an upload, cover selection or approval, returns
  `409 ADMIN_IMPORT_RELOAD_REQUIRED` before admission. Its analysis is never
  claimed or sent to the provider and does not count against this release's
  analysis concurrency, so neither a queued analysis nor a chunk a newer
  release left in flight blocks other projects; it waits for a release that
  knows the format. An upload admitted earlier still completes and can be
  reconciled, but no new automatic cover staging is admitted, and the project
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
  [Lookup routes](#lookup-routes)). A decision whose scope this release does not
  know is dropped. Review responses copy the Draft v2 fields of the draft and
  suggestions (plus, for a format-3 review only, the expected tracklist rows
  and each track's Artist entries; never its capture), the source with a Disc
  Number only on a track that captured one, and applied Track `discNumber`
  fields. The import workbench inventory copies only v1 fields, so a Draft v2
  project's row shows its first primary Artist as `artistName`. Fields and
  values a later release adds are dropped; an unknown state reads as needs
  attention; and a newer format offers no `capabilities`. An open tab of this
  release therefore keeps parsing a newer format instead of asking for a reload,
  while a tab opened before this release fails its strict schema on a Draft v2
  response and shows the reload-required state.
- **Draft v2 view.** The same module presents a v1 project as Draft v2:
  `artistName` becomes one primary entry with a deterministic per-project key,
  label and Disc Numbers are unknown, and every value counts as the
  administrator's own. The view is computed on read; the first admitted change
  stores it (see `PATCH /imports/:id`).

### Rollback floors

Each change below says whether it raises the oldest release that is safe to
roll back to:

- Once Draft v2 projects or format-3 approvals are saved, never roll back
  below the first release that keeps such projects read-only and holds their
  approvals in needs attention instead of misreading them. That release reads
  `discNumberSource: 'admin-import'` without issue, and it links a completed
  import of several Artists or a label only to its Album and first Artist,
  which the approval mirrors as `artistId`. Every project created since is
  stored as Draft v2 at creation, so after a rollback to that release it is
  read-only even if it was never edited. That release refuses field saves and
  one-step approvals before receipt lookup (as invalid input, or as too large
  over its 96 KB JSON limit) and never replays them, so after a rollback reload
  open workbench tabs before retrying a save or approval whose response was
  lost.
- This release stores catalog reviews as Draft v2, at creation or at their
  first admitted change. The oldest release that reads Draft v2 imports (the
  floor above) keeps such reviews read-only: it never dispatches their
  analysis, so stop a queued or running analysis there (stopping stays
  admitted), and it omits applied Disc Number fields from the applied list.
  Reviews this release neither created nor changed stay format 1 and editable
  there.
- Per-path catalog review saves and format-3 reviews raise no floor. A release
  before them treats a format-3 review as newer: read-only, with stopping its
  analysis admitted and its analysis never dispatched. It answers a per-path
  review save with `400 ADMIN_IMPORT_INVALID_INPUT` (`413` above its 96 KB
  review body limit) and never replays one, and a Web tab opened before them
  sends whole-draft saves, which a format-3 review refuses with
  `409 ADMIN_IMPORT_RELOAD_REQUIRED`; reload open admin Web tabs after deploying
  or rolling back across them. A review becomes format 3 only when metadata
  lookup is first admitted for it.
- Metadata lookup runs for reviews raise no floor. The release before them
  keeps format-3 reviews writable, and its worker ends a review's queued run
  `superseded` (`projectClosed`), because its import-only read finds no
  project, without updating the review's `lookupGate`; applying a review and
  the review's lookup summary therefore read the run's own state, never that
  gate, so a gate left blocking never holds apply after rolling forward again.
  Releases before format-3 reviews treat them as newer: read-only, with
  stopping their analysis admitted.
- Applying metadata lookup values to existing-Album reviews raises no floor. The
  release before it applies nothing to a review: its worker completes a review
  run without applying the preselection, a review save or Luna acceptance
  re-ranks nothing, it has no review choose or resolve route, and its review
  lookup view drops the review-only applied keys (paths, flag reasons,
  `precision` and `pairs`) and no longer counts conflicts on them. Values
  already written stay in the review draft as automatic values (appended Album
  entries and answers as the administrator's own), which that release can still
  save and apply, Disc and Track Numbers included, since it lacks the apply
  guards for unanswered conflicts and pairing-filled numbers. Reload open admin
  Web tabs after deploying or rolling back across it.
- Applying existing-Album reviews' Artist entries, label, member Artist entries
  and expected tracklist, and their identity rows and decisions, raise no
  floor. The release before them has no candidates or decisions route, ignores
  `catalogIdentityDecisions` and `catalogApplied.memberCredits`, refuses an
  apply body with the new keys or fields as invalid input, and shows applied
  `artists`, `label` and `expectedTracklist` fields only through its lenient
  applied view (it drops them); the records and Credits an apply wrote are
  ordinary catalog data. Reload open admin Web tabs across it.
- Creating reviews with their automatic lookup, the eligibility read and the
  Album page's entry raise no floor. The release before them creates format-2
  reviews without a run and continues runs already queued, answers the
  eligibility route as not found and refuses a creation body with `another` as
  invalid input; its strict Web schema refuses the identity read's `selection`
  and `keptTracklist`. Reload open admin Web tabs across deploy or rollback.
- Discarding Album completions raises no floor. The release before it has no
  discard route (its Web shows a generic error), never reads tombstones, because
  its review, import and lookup queries filter `purpose` and its Luna claim
  needs an `analysis`, and refuses a replayed creation of a discarded review
  without writing anything (at the latest with a duplicate-key `503`). Reload
  admin Web tabs across deploy or rollback, because the list item gains
  `albumTitle`.
- Offering review lookup on the Web raises no floor: every route its summary
  calls, and the `expectedValueRevision` its apply sends, exists in the release
  before it. Looking up from the Web converts an older review to format 3,
  which releases before format-3 reviews show read-only (see above). The
  `valueRevision` of the review detail and of its lookup read is new to the
  Web's strict schemas: reload admin Web tabs across deploy or rollback.
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
- The name box's Artist field needs no floor of its own; no collection or
  index changes. The release before it refuses a lookup body with `artist` as
  `400 ADMIN_IMPORT_INVALID_INPUT` and leaves `artist` out of its lookup views,
  which this Web reads as no Artist. A retry there repeats the stored queries,
  a submitted Artist name included, while an import's automatic rerun after a
  submitted run plans the submitted name without it. A Web tab opened before
  it cannot parse a lookup view whose run carries an Artist name, so reload
  open admin Web tabs after deploying or rolling back across it. Every earlier
  key and its variables are kept, so Web, iOS and Android clients accept this
  release's remote bundles. A Web tab opened after it keeps its active bundle
  instead of accepting a remote bundle from a release before it, which lacks
  the `admin.lookup.artist`, `admin.lookup.artist_hint_import` and
  `admin.lookup.artist_hint_review` keys. After deploying it, a Web client's
  cached bundle from before it is refused once for lacking those keys, so it
  shows English until the new bundle loads.
- Luna ticks need no floor of their own: an approval applies them to ordinary
  suggestion decisions and draft values. A release before them refuses the
  `suggestionTicks` this Web sends as invalid input and holds an approval
  while a shown suggestion is pending, and a Web tab opened after them cannot
  parse a lookup read without its `summary` (from a release before them), so
  its Review and publish summary shows an error and its confirmation cannot be
  approved while a suggestion is pending; reload open workbench tabs after
  deploying or rolling back across them.
- The Luna AI labels and the lookup-first summary need no floor of their own:
  they change message values and the order and styling of buttons, add one
  message key (`admin.catalog_review.analysis_confirm_title`) and store nothing.
  A release before them offers Luna as the summary's next step again, with the
  earlier labels. Every earlier key and its variables are kept, so Web, iOS and
  Android clients accept this release's remote bundles. A Web tab opened after
  them keeps its active bundle instead of accepting a remote bundle from a
  release before them, which lacks the new key, so reload open workbench tabs
  after rolling back across them. After deploying them, a Web client's cached
  bundle from before them is refused once for lacking that key, so it shows
  English until the new bundle loads.
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
- Luna schema v2 needs no floor of its own. A release before it hides stored
  `label` and `discNumber` suggestions, which never hold publication there,
  ignores `analysis.lookupContext` and each suggestion's `lookupContext`, and
  dispatches a queued analysis with its v1 prompt. A Web tab opened before it
  cannot parse a detail carrying a label or Disc Number suggestion, or a
  candidates response over its old bounds, so reload open workbench tabs after
  deploying or rolling back across it.
- After MusicBrainz IDs are stored, never roll back below the release before
  them; its index stays, and listener DTOs already drop unknown fields. That
  release ignores `musicBrainzIdWrite` and `musicBrainzNames` on a frozen
  format-3 approval: it publishes an approval that creates records, or reuses
  records without an ID, without writing any ID, and rechecks preselections
  without alias candidates. An approval that reuses an Artist or Organization
  holding an ID (an exact-ID reuse, a kept ID or a replace) becomes needs
  attention there instead: its reviewed revisions include the ID, and that
  release never preselects by ID. Roll back only while no such publication is
  preparing or in needs attention. Before rolling back, confirm in `mongosh`
  that this returns 0 (it counts every such publication that reuses an Artist
  or the label, a superset), or check and cancel those publications first:

  ```js
  db.adminAlbumImports.countDocuments({
    "media.publication.state": { $in: ["preparing", "needsAttention"] },
    $or: [
      { "media.publication.artists": { $elemMatch: { newArtist: false, entryKey: { $ne: null } } } },
      { "media.publication.label.newOrganization": false }
    ]
  })
  ```

  That release completes a lookup record left in the alias phase through its
  details-done branch, ignoring `aliases`; an unanswered Artist or label
  conflict whose lookup value carries MusicBrainz IDs is not shown there but
  still holds publication, so choose the candidate again or choose none to
  clear it. Its editor cannot parse a `replace` decision or the new candidate
  fields, and it refuses the `musicBrainzIds` this Web sends with its approvals
  as invalid input, so reload open workbench tabs after deploying or rolling
  back across them. Decisions saved while rolled back for an entry or label
  that carries a MusicBrainz ID bind none after rolling forward and are
  cleared; decide those rows again. Its catalog editor shows no MusicBrainz ID
  and its index revision is older, so it verifies its own indexes and leaves
  both MusicBrainz ID indexes in place.
- Lookup covers need no floor of their own. The release before them keeps
  `media.lookupCover` as it reads it but never runs it, so Publish no longer
  waits for a staging there, and it leaves the optional
  `admin_import_lookup_cover_worker` index in place. It lists only `cover`,
  file and `embedded-*` assets, so it hides `lookup-*` covers, shows one chosen
  explicitly as No cover and an automatic choice without the lookup cover, and
  refuses to reconcile one; an approval that already froze one still
  publishes it. It counts lookup staging receipts toward the 16 embedded
  stagings, and its completion sweep finishes an import without removing its
  lookup covers, so after rolling forward remove those with
  `DELETE …/assets/:slotId`. A release chosen, preselected or re-ranked
  while rolled back does not update `media.lookupCover`, so after rolling
  forward an import whose applied release changed meanwhile may still select,
  and keep, the earlier release's lookup cover; before publishing it, choose
  Use none of these and then the release again, or choose the cover
  explicitly. A Web tab opened before them cannot parse a detail with a
  `lookup-*` asset, a candidate's `artwork` or the summary's `waiting.cover`,
  so reload open workbench tabs after deploying or rolling back across them.
- The iTunes fallback needs no floor of its own; no collection or index
  changes. The release before it ignores a record's `itunesStage`,
  `exhausted` and `attempts.itunes` and resumes a run stored mid-stage through
  its details-done branch. It never shows, chooses (`itunes:` keys are invalid
  input there) or applies an iTunes-only candidate, and values an application
  wrote stay as automatic values: its summary shows such an application as an
  applied release without a title and folds its values without the iTunes-only
  or not-checked flag, so check those values, or choose Use none of these,
  before publishing there; a re-rank there may still count such a
  candidate as a matching group the view does not show, leaving a tie that only
  Use none of these answers, so choose none there or retry the lookup. It
  ignores `localizedNames` on the import and on a frozen approval, so its
  recheck lists no localized-name candidate; roll back only while no
  publication that froze `localizedNames` is preparing or in needs attention.
  Before rolling back, confirm in `mongosh` that this returns 0, or cancel
  those publications first:

  ```js
  db.adminAlbumImports.countDocuments({
    "media.publication.state": { $in: ["preparing", "needsAttention"] },
    "media.publication.localizedNames.0": { $exists: true }
  })
  ```

  It fails a queued `lookup-itunes:*` staging as invalid, hides such covers,
  refuses to reconcile them and its completion sweep keeps them, so after
  rolling forward choose the candidate again or remove a leftover cover with
  `DELETE …/assets/:slotId`. Its preview route answers an `itunes:` key as not
  found. A Web tab opened before the fallback cannot parse a lookup view with an
  iTunes-only candidate, `itunes`, `source` or `notChecked`, or a candidates
  response with `localizedName` items, so reload open workbench tabs after
  deploying or rolling back across it.
- Expected tracklists need no floor of their own. A release before them
  ignores a stored `expectedTracklist`: its listener DTOs are allowlisted and
  its Album writers set fields with `$set`, so it keeps the tracklist without
  showing or clearing it. Its revisions leave the tracklist out, so an
  existing-Album review, MP3 conversion, catalog edit or catalog cover
  operation captured on one side of a rollback across them reads an Album
  holding one as changed on the other (a catalog edit or cover operation
  answers `409 ADMIN_CATALOG_REVISION_CONFLICT`); capture it again or reload
  open workbench tabs. A release before the Album page shows them can neither
  show nor clear one: its Tracks read omits `expected`, and its catalog PATCH
  refuses `clearExpectedTracklist` as an unknown key.
- Track artist credits need no floor of their own; no collection, index or
  Web schema changes. The release before them drops each release track's
  artist credit and each medium's pregap and data tracks from MusicBrainz
  answers again and reads stored releases without a schema, so it ignores
  the track credits, same-as-release markers and pregap and data-track
  counts stored since; its import rankings, groups and values are the same
  as this release's, except where this release omitted a fetched release
  because its track credits no longer fit the candidate budget (see
  [Deployment todos](../deployment/todos.md)). A record it stores has
  tracks without a credit, which this release reads as no usable credit. No
  response carries a track credit or such a count, so open workbench tabs
  need no reload.
- Expected tracklist rows in an append's summary need no floor of their own;
  no collection, index, approval format or publication commit changes, and the
  numbering is an ordinary field save. The release before them sends no
  `summary.appendTracklist`, which this Web reads as null, so its summary and
  confirmation show no rows or flags and offer no numbering, and it keeps
  numbers saved through numbering as ordinary administrator values. Every other
  summary read keeps its earlier shape, since the key is sent only for an
  append to an Album with an expected tracklist whose publication is not
  complete. A Web tab opened before them cannot parse such a read, so the
  workbench asks for a reload, that import's summary shows an error and its
  confirmation cannot be approved while a Luna suggestion is pending; reload
  open workbench tabs after deploying or rolling back across them. Every
  earlier key and its variables are kept, so Web, iOS and Android clients
  accept this release's remote bundles. A Web tab opened after them keeps its
  active bundle instead of accepting a remote bundle from a release before
  them, which lacks the `admin.append_rows.*` keys. After deploying them, a Web
  client's cached bundle from before them is refused once for lacking those
  keys, so it shows English until the new bundle loads.
- Credit join phrases and Disc Numbers have their own floor in the
  [catalog Credit rollout runbook](../deployment/catalog-credit-rollout-runbook.md#join-phrase-and-disc-number-rollback-floor).

## Metadata lookup

A server worker runs metadata lookups for import projects automatically (see
[Lookup runs](#lookup-runs)) and applies a preselected candidate's values (see
[Value application](#value-application)). It also runs them for existing-Album
reviews, once automatically when a review is created and through the review
routes, and applies a candidate's values to the review's private draft, never
to the catalog (see the catalog review routes
above and Existing-Album reviews under Lookup runs and Value application).
[Routes](#lookup-routes) and the `metadataLookup` capability expose them; the
import's Review and publish summary (see the import page above) and an
existing-Album review's Metadata lookup summary are their Web controls.
MusicBrainz is the primary source; only when it returns no matching candidate
is the iTunes
Search API queried and the names it shows searched again in MusicBrainz (see
[iTunes fallback and MusicBrainz
bridge](#itunes-fallback-and-musicbrainz-bridge)). Cover Art Archive is queried
only for a release's front artwork, and the iTunes artwork hosts only for an
iTunes-only candidate's (see Cover Art Archive artwork and iTunes artwork
below). The source layer, the jobs and their routes live in
`src/administration/lookup/`.

- **Sources and hosts.** MusicBrainz (`https://musicbrainz.org/ws/2/` only), the
  iTunes Search API (`https://itunes.apple.com/search` and `/lookup`, in the
  fixed storefronts `jp`, `us`, `kr` and `tw`, ordered by the query's script)
  Cover Art Archive listings and front artwork (see Cover Art Archive
  artwork below) and an iTunes-only candidate's artwork on
  `is1-ssl.mzstatic.com` through `is5-ssl.mzstatic.com` (see iTunes artwork
  below). A listing starts at `coverartarchive.org/release/<mbid>` and may
  redirect only to `archive.org/download/mbid-<mbid>/index.json` and then to the
  same item on an `ia….us.archive.org` or `dn….ca.archive.org` storage node, all
  bound to the requested MBID. Any other destination is refused before DNS.
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
  2 MiB (MusicBrainz), 1 MiB (iTunes), 256 KiB (listings) and 4 MiB (front
  or iTunes artwork, or the cover upload limit `MAX_IMAGE_UPLOAD_MB` if
  lower). A candidate preview, including its gate wait and WebP conversion,
  must finish within 20 seconds.
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
  the whole response. The lenient fields are a release track's own artist
  credit (`artist-credit` on each track of a release lookup) and a medium's
  `pregap` and `data-tracks`, of which only the positions are read, to count
  them: an invalid one, such as a credit of more than 50 entries, a name over
  1000 characters, a join phrase over 200 or a lone surrogate, is dropped
  alone (that track then has no credit, or the medium counts no such
  tracks), and the release still parses. MBIDs, barcodes (GTIN check
  digit, all-zero rejected), ISRCs, iTunes IDs and Cover Art Archive image IDs
  are format-checked before they are sent or compared. A failure is reported
  as `unavailable`, `invalidResponse`, `rateLimited`, `busy`, `cancelled` or
  `notConfigured`, never as an empty result.
- **Cache.** Validated JSON answers, including 404 answers, stay in a
  process-local LRU of 128 entries, 8 MiB and 15 minutes. Failures and artwork
  bytes are never cached.
- **Cover Art Archive artwork.** Front artwork is fetched from a URL the server
  builds from a candidate's release MBID, never one a response named:
  `https://coverartarchive.org/release/<mbid>/front-1200` for a staged cover
  and `front-500` for a preview. Later hops may only reach the same release's
  thumbnail of that size: `coverartarchive.org/release/<mbid>/<image>-<size>.jpg`,
  `archive.org/download/mbid-<mbid>/mbid-<mbid>-<image>_thumb<size>.jpg` or the
  same item path on an `ia….us.archive.org` or `dn….ca.archive.org` storage
  node, with no query. The request accepts JPEG, PNG and WebP and sends the
  contact User-Agent; the gate admits two Cover Art Archive requests at once
  without spacing. The body is capped at 4 MiB within the 10-second deadline,
  must match its declared type's signature, may hold at most 16 megapixels,
  may be no wider or taller than the thumbnail size asked for and must decode
  completely, which runs in the shared cover-art scheduler; anything else is
  `invalidResponse`, and 404 is no artwork. A preview is converted to WebP
  within 500 pixels; a staged cover keeps the validated bytes unchanged, so it
  is never larger than 1200 pixels.
- **iTunes artwork.** Only an iTunes-only candidate's artwork is fetched, never
  for a MusicBrainz candidate (one the bridge found included). The server takes
  the candidate's stored 100-pixel address, which must be strict HTTPS on
  `is1-ssl.mzstatic.com` through `is5-ssl.mzstatic.com` with an
  `/image/thumb/…/<w>x<h>bb.jpg|png|webp` path and no query, and rewrites only
  its last segment: `1200x1200bb.jpg` for a staged cover, `500x500bb.jpg` for a
  preview. Hop 0 is exactly that address; a redirect may only reach another of
  those hosts at the same path, without a query. Requests go through the
  `itunes` gate (one at a time, 3 seconds apart; 403, 429 and 503 are
  rate-limited) within its 8-second deadline and send `Finitude/1.0` alone, with
  no contact. Byte, signature, pixel, size and decoding bounds are those of
  Cover Art Archive artwork; a 404 is no artwork, and the bytes are never
  cached. A staged cover is `lookup-itunes:<collection ID>`, named
  `itunes-front.<ext>`.
- **Discarded links.** iTunes preview, track, collection and artist links never
  enter the response shape, so they never reach evidence or fixtures. A
  100-pixel iTunes artwork URL survives only on `is1-ssl.mzstatic.com` through
  `is5-ssl.mzstatic.com`, as internal evidence: it is stored only on an
  iTunes-only candidate (`candidates.itunes.artworkUrl`) and its lookup cover
  job (`media.lookupCover.artworkUrl`), and is never projected. Cover Art
  Archive listings yield image IDs, flags, types and sizes, never URLs.
- **Planning and ranking.** Both are pure. The planner turns embedded
  identifiers shared by every file (release MBID, barcode, catalogue number and,
  for one file, an ISRC), then album or song text, then a cleaned folder name
  into at most six MusicBrainz queries, in that order, so the cap drops
  trailing fallbacks first. It never accepts file names. Submitted text and a
  submitted Artist name are only normalized (NFC, collapsed whitespace), so a
  link, a name over 200 characters or a control or format character in either
  is reported instead of planned (an empty submitted Artist name too); tag and
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
  - A submitted Artist name replaces the credited names of a submitted search,
    which are otherwise the shared album-artist or artist tags (with any label
    term) or a review's first usable primary Artist name: the release search, or
    a song's recording search, is credited to it alone, with no label term, and
    the bare search follows. It is sent as typed, never respelled, split on
    ` / ` or dropped as a placeholder credit. Only those searches and the run's
    iTunes term carry it; identifier searches keep the tag label (a
    catalogue-number search still carries it). As with tag credits, a credited
    search whose query would exceed MusicBrainz's 500-character bound is not
    planned, so only the bare search runs, and the iTunes term keeps the Artist
    only while name and Artist together fit its 200 characters. It never enters
    the draft, `musicBrainzNames`, identity candidates, the ranking's artist
    comparison or Luna's context.
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
    unknown local, MusicBrainz or iTunes duration is unverified and never
    preselected.
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
  - The ranking also offers a subset comparison (`comparison: 'subset'`, with
    pairing in `src/administration/lookup/lookupSubset.ts`) for completing an
    existing Album, which review runs use (see Existing-Album reviews under
    [Lookup runs](#lookup-runs)) and the review's candidate chooser shows;
    imports keep the exact comparison above, and their rankings, groups and
    values are
    unchanged apart from releases newly omitted for the candidate budget (see
    the track artist credit rollback note). It counts only a release's tracks
    on audio media: a medium whose format is DVD, DVD-Video, Blu-ray,
    Blu-ray-R, HD-DVD, VCD, SVCD, VHS, Betamax, LaserDisc, VHD, CED, UMD,
    CD-ROM, DVD-ROM, Data CD or Data DVD (compared case-insensitively) is left
    out with its tracks counted, as is a track whose position is not a
    positive integer and each pregap or data track, which MusicBrainz lists
    apart from a medium's tracks. Discs keep the numbering an import of the
    release gives them, among the media that have tracks, so a CD after a
    DVD-Video with a tracklist is Disc 2. Those tracks, with these Disc
    Numbers and their durations when they are whole positive milliseconds
    (otherwise unknown), are the rows of the release's expected tracklist; a
    release without audio tracks offers none. Each member pairs with a
    distinct track whose disc and position equal the member's own Disc and
    Track Number where it has them and whose duration agrees within the same
    tolerance where both are known. One pairing of every member is found by
    augmenting paths (at most 100 by 100); it is the only one when no member
    could take an unpaired track and no members could exchange tracks in a
    cycle. A candidate does not match when it has fewer audio tracks than the
    Album has members, or none (`trackCount`), no expected tracklist within
    its bounds or no pairing (`pairing`). The bounds are at most 100 audio
    tracks and 32 KiB of serialized rows (`tooManyTracks`), and distinct
    positions, Disc Numbers up to 999, Track Numbers up to 9999 and non-empty
    NFC, trimmed titles of at most 300 characters without control, invisible
    formatting or lone surrogate characters (`tracklistInvalid`). Otherwise it
    matches when its pairing is the only one, the Album has members and every
    paired duration is known, and it is unverified (listed, never preselected)
    when several pairings exist, a paired duration is unknown or the Album has
    no members (the empty pairing, so any candidate can still be chosen). The
    comparison lists the pairs, the tracks no member pairs with (the
    missing-file rows it would add, also counted), the tracks left out and the
    members no audio track can pair with (for releases of at most 100 audio
    tracks). Equal proposals form different groups, so a tie, when their
    pairings, their expected rows with durations or their paired tracks'
    Artist entries differ. Groups compare the proposal's Album values with
    those rows, pairs and paired tracks' entries, never the proposal's own
    tracks, so equal Album values with equal rows, pairs and paired-track
    entries form one group whatever the video media: a CD edition and its
    CD+DVD edition share a group, and the exact-count preference below applies
    to it. A paired track's entries come from that track's own artist credit
    through the loop that gives the Album's (roles, placeholders, repeats and
    MusicBrainz IDs as in [Value application](#value-application)), or carry a
    left-out reason when the track has no usable credit or no entry remains.
    Two completeness flags (`completeness`) replace the single test: `exact`
    holds when the search left out no release that could have exactly as many
    audio tracks as members (`exactSearchComplete`, which defaults to
    `searchComplete`) and no incomplete candidate could, and `subset` when no
    left-out or incomplete release could have at least as many; without
    `subset` the comparison is partial. An incomplete candidate's audio count
    is its release's audio tracks, else its search summary's audio media, else
    a reported total, and an unknown count could be anything; a release or
    summary whose every medium is video or data has none and can hide no
    group. After the identifier rules, while `exact` holds, the one matching
    group whose release has exactly as many audio tracks as members is
    preselected (`exactTrackCount`) even beside matching groups with more
    tracks; otherwise the only matching group of a complete comparison is
    (`onlyMatchingGroup`). Admission helpers for these comparisons accept a
    release with an unknown count or at least as many audio tracks as members,
    never one known to have none, and order them by fewest extra tracks,
    unknown counts next and smaller counts last. The pairs every largest
    pairing contains (forced pairs) are computed for numbering appended files.
- **Fixtures.** `npm run record:metadata-lookup-fixtures -- --live` re-records
  the trimmed public responses in `test/fixtures/metadataLookup/`. It contacts
  the live services with a recorder User-Agent and the contract rates, so only
  an operator runs it; tests and CI never do. Lookup tests install
  `test/support/networkGuard.ts`, which fails any non-loopback DNS query,
  socket or `fetch`. The recorded release lookups were trimmed before track
  credits were kept and carry none; a live re-record keeps them, since the
  recorder trims with the same shapes. The synthetic
  `musicbrainz/synthetic-release-track-credits.json` holds track credits: one
  equal to the release's, a featuring credit, Various Artists, none, one with
  an invalid artist ID and one with 51 entries.

### iTunes fallback and MusicBrainz bridge

`src/administration/lookup/lookupItunesStage.ts` holds the stage's pure model;
`lookupRunStep.ts` sends its requests as steps of the same run.

- **When.** Only after MusicBrainz returned no matching candidate: the run's
  planned searches and the release lookups they led to left no matching group
  (unverified, non-matching and incomplete candidates do not count). It also
  starts when MusicBrainz stayed unavailable through its automatic retries
  during the planned searches (reason `searchUnavailable`). A run whose only
  queries are a release MBID or an ISRC has no iTunes stage. The stage is
  derived from the run's stored planned queries, so a manual retry repeats it.
- **Requests.** First, for a valid barcode every file shares (a placeholder,
  meaning an all-zero, malformed or bad-check-digit GTIN, is never sent),
  `lookup?upc=<digits>&entity=song` in at most two storefronts chosen by the
  GS1 prefix of its GTIN-14 (digits 2 to 4): `jp` then `us` for 450–459 and
  490–499, `kr` then `us` for 880, `tw` then `us` for 471, otherwise `us` then
  `jp`; a storefront that answers a collection ends the UPC lookups. Then the
  run's first non-fallback text search (album, folder or song text) in at most
  three storefronts chosen by the term's script: `jp` then `us` for kana, `kr`
  then `us` for Hangul, `jp`, `tw` then `us` for other Han text, otherwise `us`
  then `jp`. The term is the text and its credited artist (never a label
  term), or the text alone when that is over 200 characters; a recording
  search becomes `entity=song`, anything else `entity=album`.
- **Results.** A collection (album search or UPC lookup) is kept when its track
  count can equal the number of files (or is unknown); a song when, for a
  one-file import with a known duration, its milliseconds are within the
  3-second tolerance (plus a legacy file's 1-second precision). At most four
  results are kept, in request then answer order, each once by its track or
  collection ID with the title and artist every storefront showed (one entry
  per storefront). A full page (25 results) never makes the comparison
  partial, since iTunes reports no total; a plausible result left out by the
  four-result bound does.
- **Bridge.** Each kept result's distinct title and artist pairs are searched
  again in MusicBrainz, at most four searches: a recording search for a song,
  a release search for a collection with only a trailing ` - Single` or ` - EP`
  dropped from its title; a placeholder artist is left out; searches equal
  except for letter case are merged; pairs whose title differs from the
  searched text (the Japanese title of a romanized search, or the reverse) go
  first. Bridge text is never respelled (the normalized spelling stays for tag
  and folder text only). Found releases join the candidates like any search's
  (plausible track counts first, within the shared 25 bound) and their release
  lookups follow; a bridge search that returned fewer hits than it reported, or
  whose plausible hits the bound left out, makes the comparison partial. Each
  result's bridge ends `found` (a search for it found a MusicBrainz release),
  `noRelease` (every search for it answered none), `notRun` (a search was
  refused, could not be built or was over the bound) or `unavailable`
  (MusicBrainz's retries ran out before its search was sent).
- **iTunes-only candidates.** A `found` result is evidence only. Any other
  result is resolved through
  `lookup?id=<collectionId>&entity=song&country=<its first storefront>`, so a
  song result's own collection name, which may name a box set's sub-album, is
  never taken as the album; the answer becomes candidate
  `itunes:<collection ID>` (`source: 'itunes'`, `releaseId` the collection ID)
  while fewer than 25 candidates are known and the candidates fit their byte
  budget. At most four collection lookups are sent per attempt (every result
  whose lookup has an outcome counts). A result either bound leaves out is
  skipped without a request, making the comparison partial. An answer with
  fewer songs than the collection's `trackCount` (songs that storefront does
  not offer), or one that fills the 200-result limit without a `trackCount`,
  is no complete release: the candidate is stored `omitted`, incomplete and
  unranked, with that track count, so a comparison it could match stays
  partial and it is never preselected or chosen. Its values: the collection name
  as given (draft text is never stripped), its single artist string as one
  primary entry without a MusicBrainz ID (never split, even at `、` or `feat.`),
  no label, the iTunes release date at day precision as the release's own date
  (no first-release date; an iTunes date is used only for an iTunes-only
  candidate), no country, the UPC as barcode only when a UPC lookup found it,
  media by disc number with tracks in track-number order, durations in
  milliseconds and each song's artist string as that track's one credit entry
  (never split), and front artwork only for an allowlisted artwork address.
- **Preselection.** Groups never mix sources: an iTunes group's key also names
  the source, and MusicBrainz group keys are unchanged. An iTunes-only
  candidate may be preselected (by a shared barcode its UPC lookup found, or as
  the only matching group of a complete comparison) only when its check is
  `noRelease` or `unavailable`; a lone identifier hit that is `notRun`
  preselects nothing. One preselected while MusicBrainz was `unavailable` is
  flagged `notChecked`; `notRun` and `unavailable` candidates show as "Not
  checked against MusicBrainz".
- **Bounds.** Beside MusicBrainz's 6 planned searches, 25 release lookups
  (shared by both sources' candidates) and 16 alias lookups, a run attempt
  sends at most 4 bridge searches, and to iTunes at most 2 UPC lookups, 3
  searches and 4 collection lookups: at most 60 requests, each through its
  source's deployment-wide gate (MusicBrainz 1.1 seconds apart, iTunes 3
  seconds apart, one at a time each), so the iTunes stage spends at most about
  27 seconds of gate time. The worker's safety bound is 80 steps per tick.
- **Failures.** Each source counts its own failed attempts (`attempts.itunes`
  beside `attempts.musicbrainz`) with the same schedule: a first 503, 429 or
  403 is retried within 2 to 10 seconds, then after 2 and 5 minutes, bounded by
  the run's grant; the run waits as `retrying` (phase `itunes`, holding
  Publish). When iTunes's retries run out (`exhausted.itunes`), its remaining
  requests are skipped and its pending collection lookups fail (a result left
  without its collection lookup makes the comparison partial; skipped searches
  do not), and the run completes with what it has, reporting iTunes as
  unavailable; iTunes never makes a run unavailable on its own. When
  MusicBrainz's run out (`exhausted.musicbrainz`), nothing more is sent to it:
  no planned or bridge search, release or alias lookup; its unsent bridge
  searches leave their results `unavailable`, and a run whose
  searches it ended still runs the iTunes stage, ending `unavailable` (never
  "no release") only when no iTunes-only candidate results. A refused iTunes
  request is skipped, a refused bridge search leaves its results `notRun`, and
  a refused collection lookup offers no candidate. A submitted run uses busy
  mode until the first failed attempt of either source.
- **Status.** The lookup view's `itunes` is `notQueried`, `running`,
  `retrying` (an iTunes request waits for its automatic retry), `answered` or
  `unavailable`. The summary says when lookup searches iTunes (without saying
  why: the stage also runs after MusicBrainz stayed unavailable) or retries
  it, when MusicBrainz answered without a match and iTunes stayed unavailable
  (the name box next), and when an iTunes-only result was applied, checked (no
  next step) or not checked against MusicBrainz (a free retry next; the copy
  names no cause, since a `notRun` candidate chosen explicitly is not checked
  either). A completed run that keeps MusicBrainz's issue (`sourceUnavailable`
  or `sourceBusy`: its retries ran out) and has no matching group or applied
  candidate is never "no match": it reports release details that could not be
  fetched (the retry next) when a candidate is incomplete, else lookup
  unavailable (the retry next). Values resting on an applied iTunes-only
  candidate are flagged "iTunes only" (and "Not checked against MusicBrainz")
  outside the fold, and the chooser marks such candidates the same way. In each
  case **Use Luna AI (paid)** follows the lookup controls as a secondary button.
- **Localized names.** The distinct artist names one kept result showed across
  storefronts (case-folded, without placeholders, at most 200 characters) form
  a localized name group when there are at least two: at most four groups of
  four names per run. Ranking counts an artist tag equal to another name of a
  group that holds a credited, canonical, joined or alias name as agreement.
  Applying any candidate (or none, or answering conflicts), and completing or
  re-ranking a run that applies nothing, keeps on the import (`localizedNames`,
  at most 21 groups) the groups that hold a current Artist entry's name, without
  a value change; a publication freezes them, only when there are some. Review
  lists Artists named with another name of an entry's or a pending proposal's
  group as `localizedName` candidates (see the duplicate candidates above).
  Localized names never keep a MusicBrainz ID on a renamed entry (that reads
  `musicBrainzNames` only).
- **Luna.** Neither an iTunes-only candidate nor any iTunes data (collection
  ID, storefront, artwork address or localized names) reaches Luna: its
  lookup context is only an applied MusicBrainz release's, and an applied
  iTunes-only candidate sends none.

### Lookup runs

`src/administration/lookup/metadataLookupService.ts` runs the jobs,
`metadataLookupRecord.ts` beside it holds their pure model, and
`lookupRunStep.ts` performs each step's request and decides, without a
database, what the step stores and which request comes next.

- **Record.** `adminImportLookups` keeps one record per import project or
  existing-Album review (its `_id` is the project's): the run number, state,
  issue and outcome, the grant, the bound file set (`fileSetDigest` and each
  manifest slot's confirmed upload intent and SHA-256), the input (`tags`,
  `folder`, `submitted` with its kind, text and any submitted Artist name or,
  for a review, `catalog`), at most six planned queries with their progress and
  `phase` (`search`, `details`, `itunes`, `bridge`, `aliases` or `done`), the
  failed attempts per source (`attempts.musicbrainz` and `attempts.itunes`), the
  sources whose retries ran out (`exhausted`), the iTunes stage (`itunesStage`:
  its requests and progress, at most four results with their storefront names,
  bridge searches and outcomes; see [iTunes fallback and MusicBrainz
  bridge](#itunes-fallback-and-musicbrainz-bridge)), at most 25 candidates (each
  with its `source`; an iTunes-only one also keeps its storefront, artwork
  address and check under `itunes`, never projected), whether every release its
  searches offered was compared (`searchComplete`; a record from an earlier
  release counts as partial when it is re-ranked or resumed), the ranking with
  its groups, the applied candidate (or none) with its values, conflicts and
  flags (see [Value application](#value-application)), stale slots, the
  automatic-run count and whether a folder-name query was handed to the worker.
  A new run (an automatic rerun, a submitted name or a manual retry) replaces
  the previous run's results, its iTunes stage, attempts and exhausted sources
  included; only the automatic-run count, the folder use and the applied values
  carry over. No history is kept, and records are never deleted. `aliases` lists
  the credited artists and labels whose MusicBrainz aliases the run looked up,
  `{kind, id, state, names}` with `state` `pending`, `fetched`, `missing`
  (404 or an answer for another ID) or `failed`; a record from an earlier
  release has none and completes without them, as one without `itunesStage`,
  `exhausted` or `attempts.itunes` does without those.
- **States.** `queued`, `running` and `retrying` are active; `complete`,
  `unavailable`, `stopped` and `superseded` end a run. A stopped run's issue is
  `permissionLost` or `grantExpired`, an unavailable one's `sourceUnavailable`,
  `sourceBusy` (a refused gate, or a rate-limited source after its retries) or
  `notConfigured`, and a superseded one's `fileSetChanged` or
  `projectClosed`. A completed run's outcome is `candidates`, `noRelease` or
  `noQuery` (nothing to look up, so nothing was sent); an unavailable run has
  no outcome and is never reported as no release, nor is a completed run
  without a matching group whose iTunes fallback stayed unavailable.
- **Steps.** The worker polls every 2 seconds, claims a due run with a
  180-second lease and advances it one request per stored step: the planned
  MusicBrainz queries in order until 25 distinct releases are known, skipping
  the fallbacks when a candidate is known as they start, then each candidate's
  release lookup; then, without a matching group, the iTunes stage (its UPC
  lookups and searches, its bridge searches, the bridged releases' lookups and
  its collection lookups); then the alias lookups, then ranking. Releases
  whose reported track count can match the files (or is unknown) are admitted
  first and their details fetched first, so the bound is spent on plausible
  editions; a recording hit's reported track count is stored with its candidate,
  since its release has no summary. After the details (unless they ended
  unavailable) the run looks up `GET /ws/2/artist/<MBID>?inc=aliases&fmt=json`
  or `/ws/2/label/<MBID>?inc=aliases&fmt=json` for at most 16 entities, in
  ranked order (the preselected candidate first): each fetched release's
  credited artists in credit order, then its first label (and, in a review
  run, its tracks' credited artists), each once, never a placeholder. Each
  alias lookup waits for the gate (within the step deadline,
  so a gate held by another run does not drop the aliases); a source failure
  (busy, throttled or unavailable) records that target and every remaining one
  as `failed` and ranks in the same step, never retried or counted as an
  attempt, so a source outage never holds value application or Publish, and
  an identifier MusicBrainz refuses fails only its own target. Kept names are
  the entity name, then primary aliases, then the others, each group in
  folded-name order, deduplicated by folded name, at most 32; aliases of type
  "Search hint" (misspellings) are excluded. Ranking then counts an artist tag
  that equals an alias of a credited artist as agreement. A run attempt sends at
  most 6 searches, 25 release lookups and 16 alias lookups to MusicBrainz, plus
  at most 4 bridge searches and 9 iTunes requests (60 requests); in wait mode
  each request is sent at most 3 times within one call for a 503 or 429 (iTunes
  also 403), and a failed step is retried automatically at most 3 times per
  source. Each step's transaction first rechecks the lease, the grant, the
  granting administrator's current role, that the project still accepts lookup
  and that no bound file changed. Requests run outside any transaction, each
  bounded by a 120-second step deadline. A worker whose lease was taken over
  writes nothing, and search progress survives retries, takeovers and restarts.
  Stopping the server aborts the request in flight and releases the lease; the
  next claim resumes at the stored step. The step that ranks a run also applies
  its preselection (see [Value application](#value-application)).
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
  attempt of either source, then waits. Each source counts its own attempts.
  When MusicBrainz's third retry fails too, or the next retry would come after
  the run's grant expires, nothing more is sent to it: during the planned
  searches the iTunes stage still runs when MusicBrainz has no matching group,
  and the run ends `unavailable` with no ranking unless it finds an iTunes-only
  candidate (it then completes with the MusicBrainz issue); during release
  lookups the remaining candidates become incomplete and the run completes
  with `sourceUnavailable`. When iTunes's retries run out, the run completes
  with what it has and no issue of its own (the view's `itunes` is
  `unavailable`). A manual retry starts a new run with the same queries.
- **Candidates.** Releases are stored without ISRCs, within 4 MiB of JSON for
  all candidates together, and candidates plus ranking stay within 12 MiB: while
  over it, the largest fetched releases are omitted and the rest ranked again. A
  release-ID query is stored under the ID MusicBrainz returns, so a release
  merged into another is ranked under its current ID. A 404 is `missing`, an
  exhausted lookup `failed` and a release over a budget `omitted`; all three
  are incomplete and unranked. An iTunes-only candidate is stored in the same
  release shape, built from its collection lookup within the same budgets (see
  iTunes fallback and MusicBrainz bridge above). The front-artwork flag comes
  from the release lookup, or for an iTunes-only candidate from its
  allowlisted artwork address. Ranking compares each file's known duration
  (version-2 milliseconds, else a stored `mm:ss` with 1-second precision), the
  draft's Disc and Track Numbers, the version-2 artist and album-artist tags and
  the identifiers every file shares. Each stored track also keeps its own
  artist credit (MusicBrainz's, or an iTunes song's artist string); one equal
  to the release's credit, entry for entry, is stored as the same-as-release
  marker `"release"`, so only tracks credited apart from their release, as on
  compilations, add bytes. A track stored without one, as in a record from
  before track credits, has no usable credit. A medium with pregap or data
  tracks also keeps how many (`hiddenTracks`, absent when none). Import
  ranking, groups and values never read track credits or that count, and no
  import response or Luna context carries them; a review's member Artist
  values come only from its paired tracks' credits (see Existing-Album reviews
  under [Value application](#value-application)).
- **Limit.** A project runs at most three automatic lookups: the first and two
  reruns after file-set changes. Submitted names and manual retries do not
  count.
- **Existing-Album reviews.** A review's run (its automatic run on creation, or
  one submitted or retried from the Web review summary) binds
  one identity per member with no upload intent or SHA-256, its digest covering
  the member IDs and their media evidence, so no file check ever marks one
  stale or supersedes the run; the members are bound through the review's
  source check instead. Its input is `catalog` (the Album's saved title as the
  review captured it, with its first usable shown primary Artist name) or a
  submitted name, with the submitted Artist name in place of that primary Artist
  name when one was given, and it compares in subset mode (a release may have
  more audio tracks than the Album has members). Searches and bridge searches
  admit releases by audio track count, fewest extra tracks first, then unknown
  counts, then those with fewer tracks than members, and pending details are
  fetched in that order. Beside `searchComplete`, which for a review means that
  no release left out could have at least as many audio tracks as members, the
  record keeps `exactSearchComplete`: no release left out could have exactly as
  many (an unknown count or an equal one; absent on import runs, false when a
  review record lacks it). A refused search, and the candidate bound stopping a
  planned search, clear both, so a release left out with more tracks blocks only
  the preselection of the only matching group, never the exact-count one. Its
  iTunes stage keeps collections with at least as many tracks as members or an
  unknown count, fewest extra first across the stage's answers (unknown counts
  last, earlier answers first on a tie), within the bound of four, and keeps
  both flags too (`complete` and `exactComplete`, with each kept collection's
  reported `trackCount`; an import's stage has neither key): a collection left
  out by that bound, or whose collection lookup was skipped or failed, clears
  `exactComplete` only when its reported count is unknown or equals the member
  count, and a song always does. Its alias lookups add each fetched release's audio-track artists, in
  track order after that release's credit and first label, within the same 16.
  Each stored step also requires a format-3 review that is not applied and whose
  source is current (the Album ready and unchanged, its membership, member
  revisions and media evidence unchanged); otherwise the run ends `superseded`
  (`projectClosed`) without a request, keeping earlier candidates. The step
  that completes a review run applies its preselection to the review's draft,
  in the same transaction as the record and the gate (see Existing-Album
  reviews under [Value application](#value-application)); nothing reaches the
  catalog. A review runs at most one
  automatic lookup (the catalog trigger, a `noQuery` run included); submitted
  names and manual retries do not count.
  Discarding a review deletes its run's record in the discard transaction: a
  stored step then finds no record and stores nothing, the answer of a request
  in flight is dropped, and a queued or retrying run is never claimed again.
- **Fence.** Starting a run (including one that completes at once as
  `noQuery`) and every state change write `lookupGate`
  `{ fence, run, state, blocking }` on the project document in the same
  transaction, the gate before the record, with `fence` incremented so the
  write always conflicts with a concurrent transaction that also writes the
  document. A re-rank of stored candidates writes it too, and the publish gate
  reads and writes it. A lookup cover staging that settles increments an
  existing gate's `fence` without changing `blocking` (see Lookup cover
  staging above). A transaction that only reads the document does not
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
  lookup, and a format-1 project's conversion never does either. Existing-Album
  reviews never take these triggers: their one automatic run is the catalog
  trigger, which creating a review calls where lookup is available (see the
  catalog review routes above), and their submitted and retried runs use the
  review lookup routes.
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
  rerun after a submitted run repeats the submitted text with any submitted
  Artist name.
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
  | An existing-Album review's catalog trigger | `create` | the review's creator |

  Admitting a submitted or retried run, a choice or conflict answers rechecks
  that administrator's role in the same transaction, and every stored step
  rechecks the grant and that administrator's current role. Choosing a
  candidate or none moves the run's grant to the one choosing for another hour
  without starting a run. A role loss, a deleted account or an expired grant
  stores nothing from that step and ends the run as `stopped`; earlier
  candidates stay as evidence and are never ranked or applied. A project that no
  longer accepts lookup (a publication lock, completion, a newer format or a
  malformed draft), or a review that is applied, not format 3 or whose source
  is not current, ends it as `superseded` (`projectClosed`). Discarding a review
  instead deletes its run's record, so its next step stores nothing and the run
  is never claimed again.
- **Refusals.** Submitted and retried runs are admitted inside the caller's
  administrator transaction, which the [routes](#lookup-routes) provide. They
  are refused with 503 `ADMIN_IMPORT_LOOKUP_UNAVAILABLE` while lookup is not
  configured, 400 `ADMIN_IMPORT_INVALID_INPUT` for an unknown request kind or
  a malformed account or intent, 403 `ADMIN_IMPORT_ADMIN_REQUIRED` when the
  granting account is not a current administrator, 409
  `ADMIN_IMPORT_LOOKUP_REFUSED` for a project that does not accept lookup, 400
  `ADMIN_IMPORT_LOOKUP_INVALID_NAME` for a link or an empty, over-long or
  invisible-character name or submitted Artist name (an Artist name with an
  empty name included), 409 `ADMIN_IMPORT_LOOKUP_ACTIVE` for a retry while
  a run is queued or running, and 409 `ADMIN_IMPORT_LOOKUP_NOTHING_TO_RETRY`
  without an earlier run's queries or with a stored input this release cannot
  read (a stored Artist name that is not a string included). A manual retry
  while a run waits for an automatic retry replaces that run at once, so the
  free retry is available while Publish waits.
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
  as it is. Only a fetched candidate whose release (or, for an iTunes-only
  candidate, collection) has the candidate's own ID is applied; one answered
  under another ID (such as a merged release) ranks as incomplete and is never
  preselected or chosen. A role loss, an expired grant or a publication lock at
  that step applies nothing.
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
  decisions on unchanged entries survive. Each entry and the label carry the
  MusicBrainz ID the release credits (never a placeholder's; proposals carry
  them as `musicBrainzId` and `labelMusicBrainzId`, so candidates crediting
  different artists or labels under one name are different groups). An
  iTunes-only candidate supplies its collection name as given, its single
  artist string as one primary entry without an ID, no label, its iTunes date
  and each file's title, Disc and Track Number matched by milliseconds; a
  MusicBrainz candidate the bridge found keeps its release group's date and
  Cover Art Archive artwork.
- **MusicBrainz IDs.** IDs come only from a MusicBrainz response: the parser
  admits an ID on an entry or the label only when the applying server step
  introduces it. Where the administrator's own entries or label equal the
  candidate's in names (case-insensitively), roles and join phrases, the
  candidate's IDs are added, without a decision, to those carrying none, keeping
  the value's origin (an automatic write: `valueRevision`, never `revision`, and
  the path joins `paths`). Such an addition keeps an explicit decision on that
  entry that stays valid, rebound to the ID (reusing the ready record holding
  it, or creating or reusing a record without an ID while no ready record holds
  it), and clears any other, which Review shows again. An ID another entry
  already carries is not added (two Artists never record one ID; an approval
  whose entries would still record one ID twice needs review again). An ID that
  differs from one already carried is a conflict marked `musicBrainzId`; a
  missing ID on either side is no difference. Before applying another candidate
  or none, each ID the previous application supplied (`applied.musicBrainzIds`)
  that an entry or the label still carries is removed, unless a decision the
  administrator saved since binds it, or the new candidate offers it for the
  same entry and that value already equals the candidate's in names, roles and
  phrases (so the addition would write it again). A decision value application
  only rebound to an ID it added is marked `boundBy: 'lookup'` and binds that ID
  for nobody: removing the ID leaves the decision bound to its entry without
  one, and saving decisions or an approval stores the decision without the
  mark. A decision stored without `boundMusicBrainzId` binds none. Answering
  `lookup` on a conflict writes the lookup value's IDs too. The names found for
  each carried ID (credited and canonical names, the label name and the run's
  aliases; at most 21 IDs of 32 names, NFC, at most 200 characters, without
  control or format characters) are kept on the import as `musicBrainzNames`; a
  renamed entry or label keeps its ID only under one of them, and Review lists
  records so named as alias candidates.
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
  answers, the flagged values and the MusicBrainz IDs it supplied that the
  draft still carries (`musicBrainzIds`). For an iTunes-only candidate,
  `releaseId` is the iTunes collection ID, `source` is `itunes` and
  `notChecked` marks one MusicBrainz did not rule out (`unavailable` or
  `notRun`); its values stay flagged in the summary. Each application, and a
  completed or re-ranked run that applies nothing, also keeps on the import
  (`localizedNames`) the run's localized name groups that hold a current
  Artist entry's name. Automatic values equal to an applied value
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
- **Publish.** An approval waits while a run is queued, running or retrying,
  or a lookup cover staging is queued or running within its grant
  (`409 ADMIN_IMPORT_LOOKUP_ACTIVE`), and for a tie (a completed run with two
  or more matching groups, no preselection and no choice for that run) or an
  unanswered conflict of the applied candidate, whatever the current run's
  state (`409 ADMIN_IMPORT_REVIEW_REQUIRED`). An append ignores Album
  conflicts. The only matching group of a partial comparison is no tie and
  never holds an approval; left unchosen, nothing from it is applied.
- **Existing-Album reviews.** A review's values reach only its private draft
  (`/catalog-reviews/:id/lookup/choose` and `/resolve`, which the Web review
  summary calls, the completing worker step and the re-rank of a save or Luna
  acceptance). They are computed against the review's own evidence: Disc and
  Track Numbers that lookup wrote (automatic) never constrain pairing, so
  choosing B after A writes B's pairing and a re-rank right after an application
  changes nothing. The Album title, Artist entries, label and date are offered
  always; the expected tracklist (`album.expectedTracklist`) and each paired
  member's title, Disc Number, Track Number and track Artist entries
  (`tracks.<slotId>.artists`) only through a single pairing of the members with
  the release's audio tracks, which the application records as `applied.pairs`
  (`{slotId, discNumber, trackNumber}` in manifest order; `[]` for an Album
  without members, which takes the whole tracklist as missing-file rows; `null`
  without a single pairing, when only Album values apply). A release over the
  tracklist bounds is flagged on `album.expectedTracklist` (`size` over 100
  audio tracks or 32 KB, `format` for an invalid one) and offers no member
  values. An Artist entry agrees with a saved one when its role is the same and
  the saved entry's Artist keeps its MusicBrainz ID, or the saved name equals,
  case-insensitively, the credited name or a credited name, canonical name or
  alias the run found for its ID, whatever ID the saved entry keeps; join
  phrases compare as bylines present them (a missing or invalid one is `, `, the
  last entry's is ignored). A lookup entry takes the key of the first saved
  entry it agrees with, wherever that stands, else a key derived from the review
  (and the member's slot), never a saved entry's. An empty value is filled as an
  automatic value, except a member's entries while it has an Artist Credit of
  any role. Agreeing lists only gain the release's IDs on entries without one
  (each ID a review records in `musicBrainzIds` names its `path`:
  `album.artists`, `album.label` or `tracks.<slotId>.artists`); an agreeing
  entry whose Artist keeps another ID keeps it, and its list (extended or not)
  gets a conflict marked `musicBrainzId` that only an explicit `lookup` answer
  replaces; entries a release appends after the agreeing saved Album entries are
  written into the saved list with the connecting phrase, keeping it the
  administrator's own, and recorded in `applied.values` with `kept` (the saved
  list), which the next application, or none, restores first while the list is
  still as written. A `lookup` answer to an extended list's ID conflict keeps
  `kept`, so choosing another candidate or none still restores the saved list
  with the IDs its Artists keep, and applying the same candidate again writes
  that answer again. Any other difference, a saved list holding two names equal
  case-insensitively included, is one conflict on the whole list. Members never
  take appended entries: a member without an Artist Credit is filled from its
  own paired track's credit (never the release's or the Album's, whatever its
  attribution state; an iTunes-only track's one artist string stays one entry),
  an agreeing member only gains IDs (or gets an ID conflict), and every other
  difference (Credits of other roles only, a featured artist added, another
  name) is one conflict. A member whose track has no usable stored credit is
  flagged `noTrackCredit` (or `placeholder`, or a format reason), a member or
  Album whose capture does not show every primary and featured Artist Credit,
  and a read-only label, `notApplicable`, and a member list that would take the
  distinct identities (by MusicBrainz ID, else by name case-insensitively, the
  Album's entries first, then members in manifest order) past 512 `size`; these
  keep their value and get no conflict. A label of the same name and another ID
  is a `musicBrainzId` conflict too. A date that only adds precision to the
  saved one is a conflict marked `precision`. Reverted values return to empty (a
  review has no file tags), a review stages no artwork, IDs it found already on
  the saved entries are never recorded as supplied (neither by an application
  nor by a `lookup` answer, so choosing another candidate or none never removes
  them), and the 48 KB cap, for automatic values and answers alike, measures the
  review's capped draft (without Artist entries, label and expected tracklist),
  so a tracklist is never flagged `size`. A completed run's preselection is
  applied by its completing worker step; a re-rank applies one only while the
  run has applied nothing. Conflicts on the review-only paths are listed in
  `needsAnswer` until answered; applying waits only for unanswered conflicts of
  the values it is asked to apply. Up to 406 answers fit one request. A review
  keeps the names found for the IDs its members' entries carry too, up to 513
  IDs (one per identity and the label), so a track-only artist gets alias and
  localized-name candidates. Its identity rows bind member entries and find
  candidates by these names and its localized-name groups, so an application
  that changes only those, or a completed run that applies nothing (which
  keeps the names the run fetched for the applied release), still bumps
  `valueRevision`: a confirmation read before is stale. Only applying the
  review writes these values to the catalog (`POST /catalog-reviews/:id/apply`).
- **Scope.** Value application writes only the project document (an import
  or an existing-Album review) and its lookup record, never a catalog
  collection. A published Album or MediaTrack
  and its search projection carry only the reviewed names and values, never
  a release, recording or iTunes identifier. In the catalog, only an Artist or
  Organization keeps a MusicBrainz ID, written by the publication commit, an
  applied existing-Album review or an explicit catalog edit (see
  [MusicBrainz IDs](../architecture/catalog.md#musicbrainz-ids)); an Album's
  expected tracklist, which an applied review stores, carries none.

### Lookup routes

All are under `/imports/:id`, behind the same administrator, current-viewer
and `no-store` guards as every import route, parsed after those guards. They
never accept a review's ID; a review's runs have their own routes (see the
catalog review routes above).
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
| `GET /lookup` | — | `200 {lookup, revision, valueRevision, summary, musicBrainzNames}`; `lookup` is `null` before any run; `musicBrainzNames` lists `{musicBrainzId, names}` for each ID the saved draft carries | `404 ADMIN_IMPORT_NOT_FOUND` for a review or a bad id |
| `POST /lookup` | `{operationId, expectedRevision, kind, text, artist?}`, `kind` `album` or `song`; text and an optional `artist` string of at most 1000 characters each | `202` import response, receipt `lookup` | `503 ADMIN_IMPORT_LOOKUP_UNAVAILABLE`, `400 ADMIN_IMPORT_LOOKUP_INVALID_NAME`, `409 ADMIN_IMPORT_LOOKUP_REFUSED` |
| `POST /lookup/retry` | `{operationId, expectedRevision}` | `202`, receipt `lookup-retry` | `503 …UNAVAILABLE`, `409 …LOOKUP_ACTIVE`, `409 …NOTHING_TO_RETRY`, `409 …REFUSED` |
| `POST /lookup/choose` | `{operationId, expectedRevision, run, candidateKey}`, key `musicbrainz:<mbid>`, `itunes:<collection ID>` (1 to 12 digits, no leading zero) or `null` for none | `200`, receipt `lookup-choose` | `409 ADMIN_IMPORT_LOOKUP_STALE` (another run, an active run, an unknown candidate, a candidate before completion), `409 ADMIN_IMPORT_LOOKUP_CANDIDATE_INCOMPLETE` (no fetched details, or a release or collection fetched under another ID), `409 …REFUSED` |
| `POST /lookup/resolve` | `{operationId, expectedRevision, run, candidateKey, answers}`, 1 to 305 distinct `{path, answer, base}`, `answer` `mine` or `lookup` | `200`, receipt `lookup-resolve` | `409 …LOOKUP_STALE` (another application or a path that is no conflict), `409 ADMIN_IMPORT_FIELD_CONFLICT` (the current value is not `base`), `409 …REFUSED` (the project no longer accepts lookup or its draft cannot be read), `400 ADMIN_IMPORT_INVALID_INPUT` (an answer that grows the draft past 48 KB) |
| `GET /lookup/candidates/:key/artwork` | — (an image element names the viewer with `?viewer=<account id>`, as staged previews do) | `200 image/webp`, the candidate's 500-pixel thumbnail (Cover Art Archive's `front-500`, or an iTunes-only candidate's iTunes artwork at 500 px) within 500 pixels, `Cache-Control: private, no-store`, `nosniff` | `403` (not a current administrator, rechecked after the fetch), `404` (a bad id or key, an unknown candidate, one whose key, source and collection ID disagree, one whose fetched release reports no front artwork, or an artwork host's 404), `503` (lookup unavailable or the fetch failed); no body |

The artwork preview is read-only: it checks the role (and a live session),
the import and the candidate without a fence write, stores no bytes, writes
nothing to storage or to the import, lookup or catalog collections (only the
deployment-wide gate's bookkeeping in `adminMetadataLookupGates`), and sends no
credential to the artwork host; the browser never loads a lookup address. It
is counted in the media delivery metrics but stays out of the per-IP media
admission pool, which refuses at once instead of queueing: the source's gate
(Cover Art Archive two at a time; iTunes one at a time, 3 seconds apart; both
waiting), the preview deadline and the shared cover scheduler already bound
it, so a chooser listing many releases never starves the same administrator's
staged-cover previews or listener artwork.

A malformed body is `400 ADMIN_IMPORT_INVALID_INPUT` before its intent is
fingerprinted. Answering `lookup` writes the lookup value as the
administrator's own; `mine` keeps the current value. The lookup view is an
allowlist: the run, state, issue, outcome and input (a submitted run's
`submitted` is `{kind, text}`, plus `artist` only when the run carries a
submitted Artist name of at most 1000 characters); at most 25 candidates
(ranked order, else stored order as incomplete) with key, release ID,
`source` (`musicbrainz` or `itunes`, agreeing with the key), `notChecked`
(an iTunes-only candidate MusicBrainz did not rule out), title, joined credit,
label, catalogue number, barcode, country, date, at most 20 formats, track
count (an iTunes-only candidate shows no label, catalogue number, country or
medium, and only a barcode its UPC lookup found), the comparison counts and
differences, group and artist mismatch, and `artwork` (whether the fetched
release reports front artwork, or an iTunes-only candidate has an allowlisted
artwork address, so a protected preview exists; never an address); at
most 25 groups with their proposals (each entry's and the label's MusicBrainz
ID, `null` for a proposal stored before them); the preselection; the
disclosure (unknown local durations and Disc Numbers, and `partialComparison`);
the preselection's `notChecked`; the iTunes stage's status (`itunes`); the
applied candidate's `source` and `notChecked`, choice, value paths, conflicts
(lookup value re-read through the draft rules, its MusicBrainz IDs read as
introduced, and `musicBrainzId` marking a conflict only in IDs) and flags; stale
files; and `needsAnswer` and `blocking`. It carries no URL, ISRC, recording ID,
storefront, localized name, account, grant, lease, fence, file-set digest or
query.

An existing-Album review's view (`GET /catalog-reviews/:id/lookup`) is the same
allowlist with the `catalog` input trigger, the `exactTrackCount` basis for the
preselection and the applied candidate, the subset differences `pairing`,
`tooManyTracks` and `tracklistInvalid`, and on each candidate's comparison a
`subset` object: `leftOutTracks` (video, data and pregap tracks),
`pairing` (`unique`, `ambiguous`, `none`, or `null` when the track count or the
tracklist ruled the release out first), `pairs` (`{slotId, discNumber,
trackNumber}` per paired member, at most 100), `missingTrackCount` (the
missing-file rows the release would add, or `null`) and `unpairableSlotIds`
(members no audio track can pair with). Pairs and members of another slot are
dropped; any other value out of bounds shows `subset` as `null`. Its
`needsAnswer` never treats the review as an append. Its `applied` also admits
the review-only paths `album.expectedTracklist` and `tracks.<slotId>.artists`
among values, conflicts and flags (at most 406 of each), the flag reasons
`notApplicable` and `noTrackCredit`, a `precision` boolean on each conflict
(a date that only adds precision) and `pairs`: the applied single pairing
(at most 100 pairs of this review's slots, each once, within the tracklist's
number bounds), or `null` without one or for any value out of bounds. An
import's view never carries these keys, and a run with the `catalog` input has
no import view. The Web parses a review's view with its own strict schema
(`reviewLookupViewSchema` in `importLookupApi.ts`, read through
`catalogReviewLookupApi.ts`), which admits exactly these keys beyond the import
view's, so the import page still refuses them.

The `summary` is the import's Review and publish state, computed by
`src/administration/import/adminImportSummary.ts` from the same snapshot:
`append` (a saved Album reuse), `waiting` (`uploads` while any staged upload,
a file's or a manual cover's, is still in flight, pending with a transfer that
can still land, or any manifest file whose track is neither skipped nor reused
lacks a confirmed upload, a lookup cover never counting; `lookup` while a run
is queued, running or retrying; `cover` while the applied candidate's front
artwork is being staged, queued or running within its grant; `analysis` while
Luna is queued or running), `placeholderOnly` (no Album reuse, no primary Artist
entry, and every file's album-level credit, album artists else artists, is a
placeholder such as Various Artists, or the applied candidate was flagged
`placeholder`), `luna` (each pending suggestion the editor shows with its tick
state), `analysis` (`runs`, `attempts` and `daily`: what is left of the
project's two runs and 22 calls and of the deployment's 220 calls today),
`lookupAvailable` (whether this server's configuration lets lookup run),
`identityAnswers` (the identity rows of the saved draft that neither a saved
decision nor a preselection answers, read with the same candidates as Review)
and, only where it applies, `appendTracklist` (below).
The lookup view's `needsAnswer` remains the list of lookup answers Publish waits
for. A stored manifest in a shape this release does not know is read through its
sanitized view. The publish transaction rechecks all of it; an upload still in
flight, or a file a published track needs without a confirmed upload, is
`409 ADMIN_IMPORT_UPLOAD_INCOMPLETE`, writing nothing.

`appendTracklist` is absent unless the saved decisions reuse an Album that is
ready, stores a valid expected tracklist and lists at most 5000 member IDs
(publishing refuses a larger target with `ADMIN_IMPORT_TARGET_TOO_LARGE`; both
read one bound, `ADMIN_IMPORT_LIMITS.appendTargetMembers`), and the import's
publication is not complete: once it is, the import's own new members fill the
rows, so the target is not read. Every other summary keeps the shape it had
before; the Web schema reads a missing key as null. The Album and the Disc and
Track Numbers of its declared members, whatever their lifecycle state or
visibility, are read in the summary's snapshot; member IDs are trimmed and
lower-cased as the Album page and listener reads take them, whether stored as
text or as an ObjectId, and a legacy Album without declared IDs has no members,
as the append commit keeps only declared ones. It is
`{albumId, durationToleranceMs, rows, files, numbering}`:
`durationToleranceMs` is the metadata lookup duration tolerance (3000);
`rows` (1 to 100) are the tracklist in Disc then Track Number order, each
`{discNumber, trackNumber, title, durationMs, filled}`, where `filled` says a
member sits at that position (a missing Disc Number counting as 1); `files`
are each manifest file's `{slotId, durationMs, durationPrecisionMs, appended}`,
where the duration is the evidence lookup ranking uses (`null` when unknown,
precision 0 for version-2 tag milliseconds and 1000 for a legacy `m:ss`
duration) and `appended` says that its saved track decision, else the
preselection Review shows, neither skips nor reuses it; and `numbering` (at
most 100) holds the values that numbering from the tracklist saves, each
`{slotId, discNumber, trackNumber, title}` (`title` is `null` where the file
keeps its own). `numbering` comes from `lookupForcedPairs` between the
appended files whose Disc and Track Numbers are not both the administrator's
own and the rows that are neither filled nor taken by an appended file with
both of its own numbers: a file's numbers constrain the pairing unless lookup
wrote them (`lookupPaths`), durations agree within the tolerance where both
are known, and only a file that every largest pairing places at the same row
is proposed, with the row's title when its own title is empty or automatic
(`automaticPaths`). A row an appended file keeps is never offered: a file the
numbering does not move (file-tag numbers whose duration fits no row, or lookup
numbers that pair nowhere) keeps its position, so a file proposed for that
position is left out, and it then keeps its own position in turn. None is
proposed when it would grow the draft past its 48 KB cap. The Web derives each appended file's row and flags from these keys
(`importAppendRows.ts`), for the shown draft in the summary and in the
publication confirmation. The approval and the publication commit never read
`appendTracklist`.

### What lookup sends

- To MusicBrainz, only the planner's URLs under `https://musicbrainz.org/ws/2/`:
  the shared album text and album-artist names, or a one-file import's title
  and artist; shared identifiers that pass their format checks; a submitted
  name and any submitted Artist name; for an existing-Album review, the
  Album's saved title as the review captured it with its first usable shown
  primary Artist name (never split on ` / ` or read as a label), or a
  submitted name with the submitted Artist name, else with that name; the
  cleaned folder name only when no usable tags exist, only for
  folder-chosen imports and automatically only once per project (a manual
  retry of that run repeats it); release MBIDs from earlier results of the
  same run; artist and label MBIDs credited by releases the same run fetched
  (alias lookups, at most 16; a review's also the artists their audio tracks
  credit); normalized spellings of tag, folder or saved-title text
  as fallbacks; and the bridge terms, the titles and artist names the iTunes
  Search API showed for the same run (at most 4 searches). The
  number of selected files, or of a review's members, is never sent; the run
  uses it only locally.
- To Apple's iTunes Search API, only when MusicBrainz returned no matching
  candidate, and only `https://itunes.apple.com/search` and `/lookup` (at most
  9 requests per run attempt): the run's search term (its text and credited
  artist, a submitted Artist name included while both fit the 200-character
  term, never a respelling), the fixed storefront code, the digits of a valid
  barcode every file shares (never a placeholder such as all zeros), and
  collection IDs from earlier results of the same run. To the iTunes artwork
  hosts, only the rewritten path of an iTunes-only candidate's stored artwork
  address.
- Cover Art Archive front-artwork URLs the server builds from release MBIDs of
  the same import's or review's lookup candidates (a staged cover or a
  preview; a review only previews), and the
  archive.org redirects they lead to.
- A review never sends its Track titles, original filenames, folders, labels,
  catalog IDs or identifiers.
- Never file names, relative path segments, account data (including any
  account's email address) or audio. The only contact sent is the operator
  contact configured in `FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT`, in the
  User-Agent of MusicBrainz and Cover Art Archive requests only.
- Requests carry only `Accept`, `Accept-Encoding: identity` and
  `User-Agent: Finitude/1.0 ( <contact> )` (`Finitude/1.0` alone to Apple's
  hosts): no cookie, authorization or referrer.
- Stored records contain no URL except an iTunes-only candidate's validated
  artwork address (and its lookup cover job's), which is never projected.
