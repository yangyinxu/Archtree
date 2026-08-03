# Finitude Web Browser and Accessibility Release Matrix

This checklist records release evidence for the Finitude Web listener. It does
not define product behavior; `docs/business-rules.md` remains the canonical
behavior contract.

## Automated browser gate

The Playwright suite runs the production `web/dist` bundle through Archtree's
Express application and uses deterministic browser-only API and audio fixtures.
It covers bundled Chromium, Firefox, and WebKit engines, critical/serious axe
findings, keyboard skip navigation, reduced motion, direct route refreshes, and
320 px, 768 px, and 1440 px reflow checks.

Latest local automated evidence (2026-08-03): 36/36 Playwright projects passed
against the production bundle; server tests passed 72/72 and Web unit/component
tests passed 91/91; Mongo-backed integration tests passed 24/24. CI repeats the
browser gate through `.github/workflows/finitude-web-release.yml`.

Passing these projects does not prove support for a branded browser release.
Playwright WebKit is not Safari, and bundled Chromium is not a substitute for
current and previous Chrome or Edge. The production-equivalent account and
media-store suite is a separate release gate.

## Media Range load evidence

`npm run test:media-load` provides a bounded workload for ready audio tracks,
public artwork, overlapping seek cancellation, and media-health recovery. It
defaults to loopback, rejects remote targets without both explicit opt-in and
an exact hostname allowlist, caps the run at 32 clients and 1,000 requests, and
prints only aggregate results. Record the approved target class, runner count,
configuration counts, timestamp, result JSON, and corresponding server metrics
without recording media IDs or signed URLs.

The checked-in harness is not itself staging evidence. Before release, run it
against the production-equivalent S3 path from approved multiple source hosts
and verify that playback-reserved slots, Range contracts, error rates, and
two-second active-request recovery remain within the documented thresholds.

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
- Confirm focus is visible, follows route changes sensibly, remains trapped in
  modal dialogs, and returns to the invoking control when a dialog closes.
- Start Album playback, select an individual Soundtrack, use Previous/Next,
  seek, change volume, mute, open keyboard help, and recover from a stream
  failure without a gesture-only dependency.
- Confirm signed-out Save remains visible, announces the sign-in requirement,
  and does not open Login automatically.
- At 200% browser zoom, confirm all content remains reachable without
  two-dimensional page scrolling. Repeat the narrowest flow at 320 CSS pixels.
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
- Current and previous branded-browser results are attached to the release.
- Any accepted browser-specific difference is documented with a visible-control
  fallback and an owner for follow-up.
