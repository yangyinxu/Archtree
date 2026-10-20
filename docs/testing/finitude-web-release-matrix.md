# Finitude Web Browser and Accessibility Release Matrix

This checklist records release evidence for the Finitude Web listener. It does
not define product behavior; `docs/business-rules.md` remains the canonical
behavior contract.

<!-- @catalog -->
**Contents**

- [Automated browser gate](#automated-browser-gate)
  - [CI scope change — 2026-10-15](#ci-scope-change--2026-10-15)
  - [Verified release status — checked 2026-10-12](#verified-release-status--checked-2026-10-12)
- [Shared Audio recovery and sustained playback](#shared-audio-recovery-and-sustained-playback)
- [Media Range load evidence](#media-range-load-evidence)
- [Deployment artifact evidence](#deployment-artifact-evidence)
- [Manual browser matrix](#manual-browser-matrix)
- [Core manual flows](#core-manual-flows)
- [Media Session observations](#media-session-observations)
- [Release gate](#release-gate)
<!-- @end-catalog -->

## Automated browser gate

The Playwright suite runs the production `web/dist` bundle through Archtree's
Express application and uses deterministic browser-only API and audio fixtures.
Its parallel workers share that one process, so each forwards its own synthetic
client address through the one trusted proxy hop and keeps its own per-IP rate
windows, as separate listeners would; no production limit is reset or relaxed.
It runs in bundled Chromium only, and covers critical/serious axe
findings, keyboard skip navigation, reduced motion, direct route refreshes, and
320 px, 768 px, and 1440 px reflow checks. It also verifies that wheel input
over the desktop player cannot move the application shell while the main content
remains independently scrollable. Player coverage includes persisted
Shuffle/Repeat state, hover-only seek preview, release-time pointer seeking,
keyboard seeking, 24 px seek hit targets, and axe scans of the expanded mobile
player and shortcut-help layers. Video coverage must additionally verify one
shared media element (decorative card hover previews are separate muted
elements that never touch the player, and are excluded from that count), automatic Audio browse and Video theater presentations,
Audio-to-Video and Video-to-Audio queue transitions, a full right-side Video
queue, recoverable failure without a fabricated fallback, no media-mode switch,
and no duplicate activity write. Responsive-shell coverage verifies the exact
1008, 1007, 800, 799, 768, and 767 px panel boundaries, the 72 px compact
Library rail, delayed Now Playing dismissal, the narrow Album hero, and player
identity while the real Now Playing control closes and restores the pane.
Search coverage verifies cancellable debounced result previews without history
writes, explicit history commits, and committed query restoration through
browser Back and Forward on the narrow page field. At 1440 px it verifies the
shell typeahead: inline suggestions on the current route, arrow-key highlight
kept in view, Enter on a highlight, Enter and Escape without one, recent
searches, result-type filters, and axe scans with the suggestion list open.

The Engineering Guide browser spec verifies its hosted login return destination,
then reads the same generated bundle through the loopback documentation preview.
It checks deep links, refresh/back navigation, keyboard focus, operation without
JavaScript, WCAG axe checks, and 320/768/1440 px reflow. Server tests separately
verify real session and administrator middleware for every guide page and asset.
Run `npm run build` before the browser gate; the guide build validates its curated
source references and internal links. The preview verifies document presentation,
not production account access or deployment.

The administrator workbench spec covers the one-approval import upload queue:
creating an import uploads every selected file one request at a time with no
per-file dialog, and Resume after reselection reports each file's own result.
An unknown outcome is reconciled without bytes and then retried with its
original operation, and switching to User view during an upload stops the queue
after that file without restarting it on return. Files chosen without a folder
show no folder field. The local MP3 conversion spec verifies that an import
created from converted MP3s uploads through the same queue. The administrator
workbench spec also checks that a new import's draft opens with Public
visibility and that saving the draft sends only the changed fields. It also
moves an Artist entry with the keyboard, checking that the move is announced
and keeps focus on the moved entry and that the reordered entries and a new
label save as just `album.artists` and `album.label`, with axe scans and
reflow at 320, 768 and 1440 px. Another test publishes an import with two
primary Artists, a featured Artist and a new label in one step, expanding each
row Review collapsed as preselected and deciding each entry, the label, the
Album and each track on its own row without a separate save, checks that the
confirmation lists the entries with their roles and join phrase, the label and
the tracks in disc order, that the single publish request carries those
decisions, and the links to the Album, each Artist and the label Organization,
with axe scans of the page and the confirmation. Another publishes an unsaved
title edit without Save and checks that the one publish request carries it and
the editor then shows it saved. Another loads a draft whose values came from
file tags and checks that the editor marks them From file tags, notes that a
company-like Artist entry looks like a label and drops a value's marker once it
is edited, and that the confirmation marks the entry and the label From file
tags only, with axe scans of the page and the confirmation. Another opens Review
on an import with no candidates and checks that its matches load without a find
step, that the entry, the label, the Album and each track are collapsed as
preselected new records with no decision asked, that the confirmation lists each
as New, and that the single publish request carries no decisions, only the
preselections the confirmation showed, with axe scans of the page and the
confirmation. Another loads an import whose files share one embedded image and
checks that Files and the summary show it chosen automatically, that choosing No
cover makes the choice explicit, and that the one publish request carries the
cover the confirmation shows. The Review and publish summary tests create an
import from a folder, upload it, and check that values prefilled from file tags
are flagged while a fixture lookup runs and Publish waits, that the one matching
release is preselected and applied, and that one confirmation publishes it with
no decision and no Luna tick; that a tie lists only the values that differ with
each release's barcode, catalogue number, country and medium and is chosen from
the keyboard; that a conflict with the administrator's label is kept from the
keyboard while the summary reflows at 320, 768 and 1440 px; that an unavailable
lookup offers Luna first beside a free retry, that a retry that stays
unavailable keeps both, and that Luna starts only after its confirmation shows
the budget, its suggestion for an empty title then arriving ticked; that an
import without a folder or usable tags offers Luna beside an empty name box that
looks up a typed name from the keyboard and stores nothing; and that after a
lookup finds no release Luna is offered, and its ticked Artist entries, label
and Disc Number are preselected in one confirmation, which offers no Apply
ticked suggestions now and approves with their preselections and ticks, with axe
scans throughout. Another shows a candidate whose release reports front artwork
through the protected administrator preview (a mocked WebP; no request reaches a
lookup host), checks that the summary says Publish waits while the applied
release's cover is staged and keeps Publish disabled, and that once the staged
lookup cover arrives it is chosen automatically, named in the summary and the
confirmation, and carried by the one publish request. Another applies an
iTunes-only result after MusicBrainz stayed unavailable: the summary says it
was not checked against MusicBrainz with Luna first beside a free retry, its
values are flagged as iTunes only and not checked, the chooser marks the
candidate the same way with an axe scan, the summary reflows at 320, 768 and
1440 px, and one confirmation publishes it.

The catalog reviews spec checks that an existing-Album review shows the Album's
Artist Credits and label read-only and applies a Disc Number change, and that a
Luna label suggestion shows only as an identity hint that Keep current rejects.

The historical 2026-08-19 MediaTrack amendment passed
304/304 server tests, 214/214 Web unit/component tests, 148/148 integration
tests, both production builds, and E2E TypeScript. The focused Audio/Video
continuity, responsive-shell, and accessibility Chromium gate passed 24/24;
the reviewed visual suite then passed 10/10 in strict no-update mode. Firefox
and WebKit completed with 130 passes and 10 documented Chromium-owned skips.
The full Chromium run completed all 70 cases with 69 stable passes and the
pre-existing Archtree logout-header timing assertion passing its automatic
retry; because CI deliberately fails on flaky tests, that command was
non-zero even though the same assertion passed an isolated CI rerun. A clean
commit-identified CI matrix was still required at that point. The largest
initial route was Playlist Detail at 148.4 KiB gzip against the 150 KiB budget;
CSS was 28.3 KiB gzip against the 32 KiB budget, and that build shipped no bundled
font or image payload. CI repeats the browser gate through
`.github/workflows/finitude-web-release.yml`; the platform-scoped path prevents
Linux CI from silently comparing against macOS font rendering. The current
strict no-update Linux result is recorded below; the historical failure remains
separate evidence.

### CI scope change — 2026-10-15

The listener and social gates now run Chromium only, retry a failed test once,
and no longer fail a run for a test that passes on retry. The Firefox/WebKit
projects, the Linux PulseAudio/GStreamer setup, the native-playback preflights
and the tests that asserted the workflow's YAML shape were removed: they made
pull-request CI fail repeatedly on audio timing without finding product bugs.
The visual-regression goldens, the room-playback feasibility spec, the motion
(layout-shift) spec and the separate room soak gate were also removed. The
evidence below predates this change.

### Verified release status — checked 2026-10-12

The latest pull-request and merged-main release workflows both completed all
five jobs on Ubuntu 24.04: production build/type check, unit/Mongo integration,
real social/media/WebSocket scenarios, three-engine listener/axe checks, and
retained Elastic Beanstalk artifact staging.

| Run | Exact source | Result |
| --- | --- | --- |
| [Pull request 38169379414](https://github.com/yangyinxu/Archtree/actions/runs/38169379414), created 2026-10-11 19:45:43 UTC | `7fd123132a45869c20ba68679db0abe2303d5bcc` | All five jobs passed; social 17/17; listener 347 passed, 10 intentional skips |
| [Merged main 38170519764](https://github.com/yangyinxu/Archtree/actions/runs/38170519764), created 2026-10-11 20:02:22 UTC | `2c1cf6e37e9ea95bf13b8218a153f3e3aa5b45cc` | All five jobs passed; social 17/17; listener 347 passed, 10 intentional skips |

The social results include `firefox-audio-formats`, `webkit-audio-formats`,
`firefox-rooms-recovery` and `webkit-rooms-recovery`, with zero retries and no
non-blocking quarantine step. The listener gate ran Chromium, Firefox and WebKit
with `--update-snapshots=none`; its ten skips are the existing Chromium-owned
visual, keyboard-order and layout-shift cases in the other two engines.

The 2026-10-12 public check matched `/finitude/` HTML and all four directly
referenced JS/CSS resources byte for byte against the retained main artifact
above. This identifies those served Web bytes, not the backend's on-instance
`RELEASE.json` or production email/Rooms acceptance. Separate 2026-10-12 production
checks completed QA registration and verified-email login, rejected the original
registration link on replay within its validity period, and received the
already-registered and six-digit reset emails. Three approved audio fixtures are
public; each passed canonical HEAD plus two Range checks against its original
bytes, including AAC's supplemental check for the stored `audio/x-m4a` MIME type.
The administrator analysis page confirmed all three new sources **Ready for rooms**
after automatic upload analysis; this does not establish fresh decoding of the
older catalog. All three also passed ordinary play, pause, paused seek to 60
seconds and explicit resume in an isolated signed-in in-app browser with both
flags off. Each used one media element and its canonical URL, reported a
120-second duration with no error, and advanced its clock only when playing.
Each test had a single-track queue, so Next was disabled and queue advancement
was not tested. Audible output, other browsers and physical devices remain
unverified. Pinned Room media (including AAC's `audio/mp4` response), Room playback,
reset completion/session revocation, remaining authentication flows, and controlled
Rooms/deployment/rollback checks remain open. Exact fixture identities and limits
are in the [production acceptance record](../deployment/finitude-web-rollout-runbook.md#production-authentication-and-media-checks--2026-10-12).

Passing these projects does not prove support for a branded browser release.
Playwright WebKit is not Safari, and bundled Chromium is not a substitute for
current and previous Chrome or Edge. The production-equivalent account and
media-store suite is a separate release gate.

## Shared Audio recovery and sustained playback

`npm run test:e2e:social --workspace @archtree/finitude-web -- --project=chromium-rooms --project=chromium-rooms-recovery`
keeps the strict native-background case in `chromium-rooms` and, in its own fixture
process and rate windows, `chromium-rooms-recovery` independently verifies reload without
autoplay or command echoes, simultaneous Next/selection arbitration, explicit
device takeover, native HTTP 429 media failure and explicit pinned-source retry,
and running host transfer without replacing the queue/timeline. Linux CI with `CI=true` or `CI=1` adds
`firefox-rooms-recovery` and `webkit-rooms-recovery`, selecting the focused recovery/transfer case
with both accounts in that project's engine. Preserve the CI null audio sink and
Xvfb setup; these projects are deliberately absent from local Windows/macOS.
Retries remain zero. A platform that keeps a genuinely background native page
visible cannot supply evidence for the strict visibility case; retain that failure
separately from the focused recovery result.

`npm run test:e2e:social --workspace @archtree/finitude-web -- --project=chromium-room-lifecycle`
covers host absence with two real accounts and actual media. In Host control it
waits through the real 30-second grace while the guest's audio keeps advancing
and its countdown ticks, then requires a server suspension no earlier than the
grace deadline, paused media and a closing countdown. The returning host's device
reclaims control and the room stays suspended until an explicit host playback
command (Play, Seek, Select, Previous or Next). Everyone
control keeps guest controls during the grace and disables them after suspension;
a guest who leaves Together for six seconds while no snapshot arrives returns to a
closing countdown at least that much lower, not one restarted from the old snapshot.
Five-minute closure is checked in both modes, together with transfer-offer
countdowns, an observer-session logout that leaves the playing device in the room,
and a host's sign out everywhere that ends the room. Only this project's disposable
fixture can age a recorded host absence; it changes no limit, timer or snapshot,
and the application's sweep performs every transition.

The 2026-10-01 uncommitted `develop` candidate passed `npm test` (710 backend
and 989 Web tests), `npm run test:integration` (580 tests), `npm run build`, and
`npx tsc -p tsconfig.e2e.json --noEmit` from `web`. The focused Windows command
below passed both selected native cases with their existing assertions and zero
retries:

```sh
npm run test:e2e:social --workspace @archtree/finitude-web -- --project=chromium-rooms --project=chromium-audio-formats --grep "real room command races|uploaded MP3 and AAC"
```

The rooms recovery case has since moved to its own project; the same selection is
now `--project=chromium-rooms-recovery --project=chromium-audio-formats`.

The eight-member, 600-second smoke gate completed 12 control cycles and five
recovery checks. Its maximum sampled drift was 43.398 ms, and participant cleanup
reported zero upgraded sockets, active media requests, and queued playback reads;
owned fixture listeners also closed. It recorded 124 read 429s (116 concurrency,
eight request-window), with no media-admission denials. Shared controls retained
their strict HTTP 200/applied and one-POST assertions. Earlier setup and
shared-selection 429 failures are failed attempts, separate from this pass;
read reservations and bounded known-concurrency GET recovery are in the tested
candidate. That run predates per-account room HTTP limits: all eight members then
shared one loopback request window and per-client concurrency pool. Later runs give
each member's account its own, so this run's 429 counts are not a baseline for
them.

The longer run was stopped at the user's request. Its last complete progress
sample was at 8,528 seconds (2 h 22 min 8 s), with 171 control cycles, 16 recovery
checks, 42 polling-fallback checks, eight upgraded connections, and maximum
sampled drift 284.143 ms. The process exited after interruption; owned fixture
processes and listeners on ports 4187/4188 were absent afterward. No final
aggregate or zero-resource teardown assertion was emitted for the interrupted
run. Source and production-bundle hashes were unchanged throughout the run and
verified again before this documentation update. This is partial evidence, not a
completed eight-hour pass. No further long test is requested for this change.
That historical Windows run did not close the Linux/cross-engine gate; the later
Linux acceptance is recorded above. Physical-device output, production-equivalent
S3, and deployment/rollback gates remain separate requirements. The tested
production entry bundle was `index-BMUnW763.js`; the largest
initial route was 149.5 KiB gzip and CSS was 30.8 KiB gzip, within their existing
150/32 KiB budgets.

## Media Range load evidence

`npm run test:media-load` provides a bounded workload for ready Audio and Video
MediaTracks through the same canonical
stream route,
fixed-width public WebP artwork, overlapping seek cancellation, and
media-health recovery. Artwork checks cycle through every supported width and
verify content type, length, ETag, and mandatory cache revalidation. The command
defaults to loopback, rejects remote targets without both explicit opt-in and
an exact hostname allowlist, caps the run at 32 clients and 1,000 requests, and
prints only aggregate results. Record the approved target class, runner count,
configuration counts, timestamp, result JSON, and corresponding server metrics
without recording media IDs or signed URLs.

The checked-in harness is not itself staging evidence. Before release, run it
against the production-equivalent S3 path from approved multiple source hosts
and verify that playback-reserved slots, Range contracts, error rates, and
two-second active-request recovery remain within the documented thresholds.

## Deployment artifact evidence

`npm run stage:eb-artifact` copies only the reviewed Elastic Beanstalk runtime
allowlist, validates the Vite manifest and hashed assets, rejects environment,
dependency, report, and symbolic-link pollution, verifies platform-hook
permissions, and writes bounded source/build identity to `RELEASE.json`. The CI
release gate retains a commit-named archive for 30 days after all automated
gates pass. Its final `release-artifact` job runs only after the parallel
`build`, `unit-integration`, `social-e2e` and `browser-e2e` jobs succeed. It
stages the same production build those browser jobs tested. The `social-e2e`
gate runs every Linux social project in one blocking step, including
`firefox-audio-formats` and `webkit-audio-formats`, and keeps evidence under
`social-real/` in the `finitude-social-browser-evidence` artifact. The complete
gate retains zero social retries and unchanged drift/readiness thresholds. The
pull-request and merged-main runs recorded in the 2026-10-12 check above passed
the Linux decoder gate. Production rooms remain disabled; controlled rollout
checks are still required before public enablement (see the
[social rollout runbook](../deployment/social-rollout-runbook.md#cross-engine-audio-acceptance-blocks-enabling-rooms)).

Follow
[`../deployment/finitude-web-rollout-runbook.md`](../deployment/finitude-web-rollout-runbook.md)
to promote the exact same archive, retain the immediately previous successful
archive, execute smoke/observation gates, and roll back without rebuilding. The
artifact contract has successful Linux CI evidence, and the served Web entry
and directly referenced assets match the latest main artifact. The staging
rollout and rollback rehearsal still require their own evidence. A temporary
structural rehearsal also proved that an archived revision can build, stage, zip, pass
`unzip -t`, and reproduce its staged tree without touching the working tree.
It is deliberately not accepted as rollback evidence: an older retained
release uses `/listen/assets/`, while the current stager requires
`/finitude/assets/`. Rebuilding an old commit with a newer script would
therefore change the artifact contract; the previous original CI archive is
mandatory.

## Manual browser matrix

Record the exact browser, operating-system version, build identifier, tester,
date, and result for every row.

| Platform | Required browsers | Assistive technology | Result/evidence |
| --- | --- | --- | --- |
| macOS | Current and previous Safari; current Chrome and Firefox | VoiceOver and keyboard | Pending |
| Windows | Current and previous Edge and Chrome; current Firefox | NVDA and keyboard | Pending |
| iOS | Current Safari on the oldest supported phone width and a current device | VoiceOver, Dynamic Type/browser text zoom | Pending |
| Android | Current Chrome on a narrow and a current device | TalkBack and keyboard where available | Pending |

Use real browsers or an approved browser-device service. Document any Media
Session action that is unavailable and confirm that the equivalent visible
player control still works.

## Core manual flows

- Navigate Home, Search, Library authentication state, Album, Artist, Account,
  and browser back/forward using only the keyboard.
- On a phone width, in the Search page field, type and delete without
  submitting, confirm results update after the debounce while Recent searches
  remains unchanged, then use Enter or the mobile-keyboard Search action and
  confirm only that final query is recorded. Repeat with a Chinese or Japanese
  IME and verify composition text is not searched or submitted before the
  candidate is committed.
- At 768 px and wider, type in the shell field on Home: confirm suggestions
  appear without leaving Home, arrow keys highlight and scroll them, Enter
  opens a highlight or otherwise full results, Escape closes and then clears,
  typing after a highlight clears it, and a screen reader announces the
  active option and the suggestion count. Repeat with an IME and confirm arrow
  and Escape keys stay with the composition.
- Confirm focus is visible, follows route changes sensibly, remains trapped in
  modal dialogs, and returns to the invoking control when a dialog closes.
- Start Album playback, select an individual MediaTrack, use Previous/Next,
  cycle Shuffle and Repeat Off/All/One, and confirm Previous restarts the
  current MediaTrack at or after three seconds but otherwise follows actual
  playback history.
- Start an Audio MediaTrack and confirm the current browse route remains
  visible. Start a Video MediaTrack and confirm the same player automatically
  moves into the central theater, the right panel shows the full playback
  order beginning with Up Next, and no Audio/Video or cover-only switch is
  present. Advance Video → Audio → Video and confirm elapsed time, queue,
  Shuffle, and Repeat remain owned by one player while the presentation follows
  each item. A simulated Video failure must remain recoverable without
  fabricating an Audio fallback.
- Hover the seek track without changing playback, commit pointer seeking only
  on release, seek by keyboard, change volume, mute, open keyboard help, and
  recover from a stream failure without a gesture-only dependency.
- Confirm signed-out Save remains visible, announces the sign-in requirement,
  and does not open Login automatically.
- Confirm signed-out New Playlist remains visible, announces the sign-in
  requirement, and does not open Login automatically.
- With a signed-in listener, create and rename a Playlist, add multiple
  MediaTracks, reject a duplicate without moving it, use Move Up/Down, start
  playback from the middle, remove one member, and delete the Playlist. Confirm
  the active queue remains unchanged after the source Playlist is edited or
  deleted.
- Repeat a mutation after simulating a lost response, then force a stale
  revision from a second browser session. Confirm replay is idempotent and the
  conflict refreshes current state without silently overwriting it.
- Switch accounts and confirm Playlist summaries, details, dialogs, and cached
  membership state never cross the account boundary. An ID owned by the first
  account must look missing to the second account.
- In two same-origin tabs, repeat login, refresh, logout, and account switching
  across both Listener and Content Manager. Confirm old private DOM and caches
  disappear before the replacement account renders, no stale mutation reaches
  the new account, and only the departed account's Search history is cleared.
- At 200% browser zoom, confirm all content remains reachable without
  two-dimensional page scrolling. Repeat the narrowest flow at 320 CSS pixels.
- Resize through 1008, 1007, 800, 799, 768, and 767 CSS px. Confirm the full
  Library pane becomes a 72 px rail before the right pane disappears, the rail
  persists after that dismissal, and the dedicated mobile shell appears only
  at 767 px and below. Toggle Now Playing at a wide width and confirm the
  current track, elapsed time, queue, and route do not reset.
- Enable Reduce Motion and confirm navigation, player, dialogs, crop controls,
  and status announcements remain understandable and operable.
- Verify missing artwork, long and missing text, loading, empty, partial-error,
  and retry states with a screen reader.
- On mobile, open and close the expanded player, use every visible transport
  control, and confirm queue swipes have equivalent buttons.
- As an administrator, create an import from a folder of several audio files
  and confirm they upload one at a time, each with its own progress and result,
  without a per-file confirmation. Switch to User view during an upload and
  confirm that file finishes and no other file starts. Reload during an upload
  and confirm reopening shows each interrupted file as ready, of unknown
  outcome (reconciled without bytes) or not uploaded, and never resends bytes
  on its own. Reselect the folder and resume: only incomplete files upload, an
  unconfirmed file is resent only under its original operation, and a file
  whose content changed is refused. Repeat at 320 CSS px with a screen reader
  and confirm progress and per-file results are announced.
- As an administrator, use only the keyboard and a screen reader to add three
  Artist entries to an import draft, move one up and down, make one Featured,
  and set a join phrase, a label and a Disc Number, then save. Confirm each
  move is announced with the entry's new position, focus stays on the moved
  entry and no primary entry follows a featured one. Repeat at 320 CSS px.
- As an administrator, publish an import with two primary Artists, a featured
  Artist and a new label, where only one primary name matches an existing
  Artist, in different letter case. Confirm Review loads its matches without a
  find step, shows the other entries, the label, the Album and each track
  collapsed as preselected new records, asks for a decision only for the
  matching entry, refuses reusing one Artist for two entries, and that the
  completed import links to the Album, each Artist and the label Organization.
  In User view, confirm the Album byline keeps the join phrases, the tracks
  credit only the primary Artists, the Album appears in each primary Artist's
  Discography, the featured Artist's Collaborations and the label's Releases.
  Then append one new file and one file already on that Album and confirm the
  identical file is preselected to reuse its track and the new one as a new
  member, the draft's Album values, entries, label and cover are shown as not
  applied, the confirmation lists the new track with its Disc and Track Number,
  and the new track takes the Album's primary Artists, order and visibility.
- As an administrator, make each Review decision without Save decisions, then
  edit the import's title without saving and choose Publish. Confirm the
  confirmation says the unsaved changes are included and lists the title, the
  entries in order with their roles and join phrases, the label, the date,
  the visibility, the cover, the tracks by Disc and Track Number, and each
  identity, with a hidden reused record marked Hidden. Approve, refresh the
  page and confirm the saved draft holds the edited title and the decisions.
  Repeat with a screen reader at 320 CSS px.
- As an administrator, open the publication confirmation of an import whose rows
  are all preselected, create an Artist named like one of its entries in another
  letter case from a second tab, then approve. Confirm the approval is refused
  and nothing is published, and that Review, once it reads its matches again,
  asks for a decision on that entry.
- As an administrator, create an import from a folder of tagged audio files
  that share their album, album artist, year and label tags, with the tracks
  in `Disc 1` and `Disc 2` folders and no disc tags. Confirm each track's
  title, Disc Number and Track Number appear, marked From file tags, as its
  upload is confirmed, and that once every file is confirmed the Album title,
  year, label and one primary Artist entry appear, marked From file tags in
  Draft, with the entry and the label marked From file tags only in the
  publication confirmation. Save an edited automatic track title while other
  files still upload and confirm the save keeps it, no conflict appears, and
  Review decisions and the cover choice stay available. Repeat with files
  whose album tags disagree and with a Various Artists album artist, and
  confirm those values stay empty and no Artist entry is written. Repeat with
  a screen reader at 320 CSS px.
- As an administrator, create an import from audio files that all embed the
  same cover image. Once every file is confirmed, confirm Files and the
  summary show that image chosen automatically, that saving an append to an
  existing Album in Review deselects it and that saving a new Album again
  restores it. Repeat with files whose images differ: confirm no cover is
  chosen, choose one, publish, and confirm Files then lists only the chosen
  image and the Album shows it.
- As an administrator, with metadata lookup configured against MusicBrainz in a
  development environment, create imports from a folder of a tagged Album with
  one matching release, of an Album with several matching editions, and of
  files without usable tags chosen without a folder. Confirm each opens on the
  Review and publish summary; that the first shows Looking up, then the applied
  release with nothing to answer, and publishes after one confirmation; that the
  second lists only the values that differ with each edition's barcode,
  catalogue number, country and medium, and that Publish waits until one or
  none is chosen; and that the third offers Luna beside an empty name box.
  Type a name of your own for one Artist entry or the label before the lookup
  applies and confirm Keep mine and Use lookup value appear and Publish waits
  for the answer. Make lookup unavailable and confirm Retry lookup comes first,
  then Analyze with Luna once the automatic retries end, and that Analyze shows
  the project and daily budget and starts nothing until confirmed; confirm
  Luna's suggestions for empty or tag values arrive ticked, others unticked, and
  that unticking keeps the current value at approval. With no tags and no
  match, let Luna suggest the Album title, the Artist entries and the label, and
  confirm the same publication confirmation preselects them as new; then name an
  existing Organization like the suggested label and confirm its row needs a
  decision and Apply ticked suggestions now appears only then. Confirm the name
  box refuses a link, keeps no history and that no global search appears.
  Without an operator contact, confirm the summary says lookup is not
  configured, offers Luna and shows neither a retry nor the name box. Repeat
  with a screen reader at 320 CSS px.
- As an administrator, with metadata lookup configured against MusicBrainz in a
  development environment, import a popular Album with many editions (for
  example Hotel California by Eagles) whose files match exactly one edition
  among those compared. Confirm the summary says one release matches but was
  not applied because not every release found was compared, that the chooser
  shows the release with every value, says not every release was compared and
  offers Use none of these, that Publish is available without a choice, and
  that choosing the release applies it.
- As an administrator, with metadata lookup configured against MusicBrainz and
  Cover Art Archive in a development environment, import an Album whose
  matching release has front artwork. Confirm the chooser shows the release's
  front artwork through the protected preview and the browser requests no
  Cover Art Archive or archive.org address; that the summary says Publish waits
  while the cover is staged; and that once staging ends Files lists the Cover
  Art Archive front artwork, chosen automatically over an image every file
  shares. Choose another release and confirm the earlier cover is cleaned up
  and the new one chosen; choose none and confirm the shared embedded image is
  chosen again. Repeat for a release without front artwork, and with Cover Art
  Archive unreachable, and confirm Publish stops waiting with the current cover
  choice kept. Publish and confirm the Album shows the chosen cover and Files
  keeps no other lookup cover. Repeat with a screen reader at 320 CSS px.
- As an administrator, with metadata lookup configured in a development
  environment, import a one-file song whose title tag is romanized and which
  MusicBrainz lists only under its Japanese title (for example "Pandora Call"
  by ヰ世界情緒). Confirm the summary says lookup searches the iTunes Search
  API, that the MusicBrainz release found through the Japanese title is applied
  with no iTunes-only mark, and that Review lists an Artist named with the
  artist's other localized name as an iTunes localized name. Then import files
  that MusicBrainz does not know but iTunes does, and confirm the chooser
  marks the result iTunes only, the summary flags its values as iTunes only,
  its iTunes artwork is staged and chosen automatically while the browser
  requests no mzstatic address, and Publish needs one confirmation. With
  MusicBrainz unreachable, confirm the result is also marked Not checked
  against MusicBrainz with Luna first beside a free retry; with iTunes
  unreachable, confirm the summary says iTunes was unavailable and Publish
  stops waiting once its retries end. Repeat with a screen reader at 320 CSS px.

## Media Session observations

For each target browser, record support and behavior for play, pause, seeking,
ten-second skips, Previous, Next, metadata/artwork, backgrounding, lock-screen
controls, and route navigation. Browser or operating-system suspension is an
expected platform limitation; it must not be reported as guaranteed Finitude
background parity.

## Release gate

- No open critical or serious automated accessibility finding.
- No release-blocking keyboard, screen-reader, responsive, authentication, or
  playback defect in the manual matrix.
- Full-stack E2E passes against an isolated Mongo database and a
  production-equivalent media store.
- Playlist owner isolation, account deletion, MediaTrack-reference cleanup,
  idempotency replay, stale-revision recovery, and maximum-size behavior pass
  against a transactional Mongo replica set.
- Current and previous branded-browser results are attached to the release.
- Any accepted browser-specific difference is documented with a visible-control
  fallback and an owner for follow-up.
