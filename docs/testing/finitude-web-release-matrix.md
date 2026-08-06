# Finitude Web Browser and Accessibility Release Matrix

This checklist records release evidence for the Finitude Web listener. It does
not define product behavior; `docs/business-rules.md` remains the canonical
behavior contract.

## Automated browser gate

The Playwright suite runs the production `web/dist` bundle through Archtree's
Express application and uses deterministic browser-only API and audio fixtures.
It covers bundled Chromium, Firefox, and WebKit engines, critical/serious axe
findings, keyboard skip navigation, reduced motion, direct route refreshes, and
320 px, 768 px, and 1440 px reflow checks. It also verifies that wheel input
over the desktop player cannot move the application shell while the main content
remains independently scrollable. Player coverage includes persisted
Shuffle/Repeat state, hover-only seek preview, release-time pointer seeking,
keyboard seeking, 24 px seek hit targets, and axe scans of the expanded mobile
player and shortcut-help layers. Responsive-shell coverage verifies the exact
1008, 1007, 800, 799, 768, and 767 px panel boundaries, the 72 px compact
Library rail, delayed Now Playing dismissal, the narrow Album hero, and player
identity while the real Now Playing control closes and restores the pane.
Search coverage verifies cancellable debounced result previews without history
writes, explicit history commits, and committed query restoration through
browser Back and Forward.

The current local uncommitted candidate, verified on 2026-08-05, passes 235/235
server tests, 204/204 Web unit/component tests, 126/126 Mongo-backed integration
tests, both production builds, and E2E TypeScript. The strict local
three-engine Playwright matrix passes 191 tests with 10 documented
capability-specific skips and no failures. Chromium passes all 67 planned
checks, including eight `toHaveScreenshot` golden comparisons without snapshot
updates; Firefox and WebKit each pass 62 checks with five intentional
capability-specific skips. The latest reviewed in-app Browser design checkpoint
had no warning or error log entries. The largest initial route is Playlist
Detail at 147.5 KiB gzip against the 150 KiB budget; CSS is 26.7 KiB gzip
against the 32 KiB budget, and the build ships no bundled font or image payload.
CI repeats the browser gate through `.github/workflows/finitude-web-release.yml`;
the platform-scoped path prevents Linux CI from silently comparing against
macOS font rendering. A separately reviewed Linux baseline and a subsequent
strict no-update CI pass remain required before release.

Passing these projects does not prove support for a branded browser release.
Playwright WebKit is not Safari, and bundled Chromium is not a substitute for
current and previous Chrome or Edge. The production-equivalent account and
media-store suite is a separate release gate.

## Media Range load evidence

`npm run test:media-load` provides a bounded workload for ready audio tracks,
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
gates pass.

Follow
[`../deployment/finitude-web-rollout-runbook.md`](../deployment/finitude-web-rollout-runbook.md)
to promote the exact same archive, retain the immediately previous successful
archive, execute smoke/observation gates, and roll back without rebuilding. The
artifact contract has local automated evidence; the staging rollout and
rollback rehearsal remain pending external evidence. A temporary structural
rehearsal also proved that an archived revision can build, stage, zip, pass
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
- In both Search fields, type and delete without submitting, confirm results
  update after the debounce while Recent searches remains unchanged, then use
  Enter or the mobile-keyboard Search action and confirm only that final query
  is recorded. Repeat with a Chinese or Japanese IME and verify composition
  text is not searched or submitted before the candidate is committed.
- Confirm focus is visible, follows route changes sensibly, remains trapped in
  modal dialogs, and returns to the invoking control when a dialog closes.
- Start Album playback, select an individual Soundtrack, use Previous/Next,
  cycle Shuffle and Repeat Off/All/One, and confirm Previous restarts the
  current soundtrack at or after three seconds but otherwise follows actual
  playback history.
- Hover the seek track without changing playback, commit pointer seeking only
  on release, seek by keyboard, change volume, mute, open keyboard help, and
  recover from a stream failure without a gesture-only dependency.
- Confirm signed-out Save remains visible, announces the sign-in requirement,
  and does not open Login automatically.
- Confirm signed-out New Playlist remains visible, announces the sign-in
  requirement, and does not open Login automatically.
- With a signed-in listener, create and rename a Playlist, add multiple
  Soundtracks, reject a duplicate without moving it, use Move Up/Down, start
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
- Playlist owner isolation, account deletion, Soundtrack-reference cleanup,
  idempotency replay, stale-revision recovery, and maximum-size behavior pass
  against a transactional Mongo replica set.
- Current and previous branded-browser results are attached to the release.
- Any accepted browser-specific difference is documented with a visible-control
  fallback and an owner for follow-up.
