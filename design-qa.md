# Finitude Web Listener Design QA

## Verdict

**final result: passed**

The current local candidate has no open P0, P1, or P2 visual finding. This
verdict covers the implemented interface, Carousel navigation, wide-panel
resizing, and local browser evidence. It does not claim that the separate
staging, Web Vitals, device-lab, or rollback gates have run.

## Reference and comparison evidence

- Source visual truth: the user-supplied conversation attachment
  `codex-clipboard-45f7b630-e3bd-479f-8b85-ff43e41da1ef.png`, a 3456 × 1778
  wide reference reviewed at its native 2× density and normalized
  1728 × 889 CSS viewport. Source identity:
  SHA-256 `a898513709f8f9286b114de86e5f6711a874a785573dfb5c89e5d6cc9c6a1b86`.
- Wide active-state baseline:
  `web/e2e/visual-regression.spec.ts-snapshots/darwin/reference-home-active-1728x889-dpr2.png`.
- Compact active Album baseline:
  `web/e2e/visual-regression.spec.ts-snapshots/darwin/reference-album-active-857x888-dpr2.png`.
- Compact source truth: the user-supplied 1714 × 1776 attachment
  `codex-clipboard-5b79053a-b4f2-4e18-a844-f8a3f6e50551.png`, normalized to
  857 × 888 CSS pixels at device scale factor 2. Source identity: SHA-256
  `44af9f284c5d0510058f47494381bec631391a804517e9f1090bf9b3907c9a3c`.
- Responsive baselines: 1280 × 800, 1440 × 900, 1920 × 1080,
  390 × 844, 320 × 568, and 844 × 390 CSS pixels in the same snapshot
  directory.
- The source and candidate were reviewed together at identical dimensions.
  The source image is not copied into the repository; only original Finitude
  fixture artwork and reviewed candidate baselines are retained.
- Snapshot paths are platform-scoped. The reviewed `darwin` baselines are not
  silently reused on Linux, where the system-font fallback and antialiasing can
  differ; the first Linux CI baseline requires separate design review.
- Final interactive review used the production build at
  `http://127.0.0.1:4174/finitude` in the in-app browser.

## Required fidelity surfaces

| Surface | Result |
| --- | --- |
| Typography | Passed. The deterministic system/Avenir-compatible fallback reproduces the reference hierarchy, mixed-script density, weight contrast, truncation, and tabular time without a proprietary third-party font. |
| Shell geometry | Passed. The default 1728 px state uses 8 px outer and panel gutters, 303 px side tracks, and the remaining 1090 px main track. Each side track can grow to 420 px while preserving an 856 px main track. |
| Spacing and density | Passed. Overflowing Home rows use 24 px column gaps, a deliberate partial-card cue, and a 48 px section rhythm. |
| Color hierarchy | Passed. Canvas, panel, raised, hover, primary-text, and secondary-text roles remain visibly distinct; focused and selected states retain the Finitude mint accent. |
| Artwork and crop | Passed. Square artwork is crisp and consistently cropped, Artist art remains circular, and missing-artwork behavior is covered. |
| Icons and controls | Passed. Controls use one icon family, stable targets, real actions, accessible names, disabled states, and visible focus. |
| Motion | Passed. The expanded player was sampled at start, midpoint, and end with no measurable layout shift; reduced motion removes presentation animation without removing controls or focus return. |
| Responsive behavior | Passed. The left pane compacts before the right pane disappears; mobile activates only below 768 px. No target viewport has horizontal page overflow. |
| Playback continuity | Passed. One real Audio object, source, queue, and elapsed time survive pane toggles, route history, responsive transitions, and mobile expansion. |
| Accessibility | Passed. Axe, keyboard, forced-colors, touch, orientation, reduced-motion, menu, dialog, and focus-return gates pass across the automated Playwright engine matrix. |
| Console health | Passed. The final interactive Browser session contained no warning or error entries. |

## Carousel and panel-resize enhancement

- The live source and implementation were reviewed together at the same
  1728 × 836 CSS viewport. The candidate preserves Finitude artwork, copy, and
  controls while matching the source's overflow grammar: a clipped trailing
  card, contextual circular direction controls, and no visible scrollbar.
- The default 303 px side tracks expose four complete recommendation cards and
  part of the fifth. Expanding both side tracks to 420 px still exposes three
  complete cards and a meaningful portion of the fourth.
- Carousel controls were exercised from start to end and back. Direction
  buttons appear only when content exists in that direction; Page Up, Page
  Down, Home, and End remain available from the focused list; native scrolling
  remains enabled.
- Both named vertical separators were exercised with pointer and keyboard
  input. Their 280–420 px preferences survive reload, hide safely at compact
  breakpoints, and never reduce the main pane below 416 px.
- The separator's central grab target is 24 × 44 px for precise pointers and
  44 × 44 px for coarse pointers, where its direction cue remains visible.
  The remaining full-height separator stays inside the 8 px gutter so it does
  not intercept adjacent content or scrollbars. A constrained 1280 px
  no-op click and cancelled touch drag both retained the original 420/420 px
  preferences instead of persisting temporary 416 px effective widths.
- The two separators are contained by a named landmark and pass the full axe
  surface matrix. Forced colors and reduced motion retain visible, immediate
  controls.
- The final local Browser session used production assets, retained the expanded
  widths across reload, showed no horizontal document overflow, and emitted no
  warning or error entries.

## Responsive shell contract

All values below were verified both by deterministic Playwright assertions and
the final rendered Browser session. Visible tracks use 8 px gaps.

| CSS viewport | Left | Main | Right | Result |
| --- | ---: | ---: | ---: | --- |
| 1008 px | 280 px | 416 px | 280 px | Both full side panes remain visible. |
| 1007 px | 72 px | 623 px | 280 px | The left pane becomes an icon rail first. |
| 800 px | 72 px | 416 px | 280 px | The compact three-pane minimum fits exactly. |
| 799 px | 72 px | 703 px | Hidden | The right pane dismisses only below 800 px. |
| 768 px | 72 px | 672 px | Hidden | The persistent left rail remains. |
| 767 px | Hidden | 767 px | Hidden | The mobile shell and bottom navigation activate. |
| 320 px | Hidden | 320 px | Hidden | Single-axis reflow remains reachable without overflow. |

The player’s real Now Playing control was also exercised in the final Browser
session: it hid the complementary pane, exposed the matching Show control, and
restored the same pane without replacing playback.

## Verification evidence

- `npm run test:e2e:chromium --workspace @archtree/finitude-web -- e2e/visual-regression.spec.ts --update-snapshots=none`:
  10 passed with no snapshot update.
- `CI=1 npm run test:e2e --workspace @archtree/finitude-web -- --update-snapshots=none`:
  191 passed, 10 documented capability-specific skips, 0 failed across
  Chromium, Firefox, and WebKit.
- `npm test`: 222 server tests and 204 Web tests passed.
- `npm run test:integration`: 126 Mongo-backed integration tests passed on the
  current integrated source tree.
- `npm run build`: server and Web production builds passed; the largest
  initial listener route is 147.5 KiB gzip against the 150 KiB budget.
- Static listener assets: 26.7 KiB gzip CSS, 0 bundled font payload, and
  0 bundled image payload.
- `npm run typecheck:e2e --workspace @archtree/finitude-web`: passed.
- Final in-app Browser review: active Home and compact Album states passed;
  exact breakpoint order passed at 1008, 1007, 800, 799, 768, and 767 px;
  no warning or error log entries.

## Intentional product deviations

- Finitude keeps its own name, mark, mint accent, copy, account model, catalog,
  Playlists, and supported controls.
- Protected reference artwork, branding, proprietary typography, promotions,
  provider/follow surfaces, social activity, lyrics, editable queue, download,
  and device controls are absent.
- The Album tonal surface uses Finitude data and original deterministic test
  artwork rather than copying a source-specific gradient or cover.
- Original QA artwork lives only in browser fixtures and is not emitted into
  the production application bundle.

## Separate release gates

The local redesign is approved, but the release stage remains blocked until an
authorized target and commit-identified artifact exist. Remaining release-only
work is real 200% browser-UI zoom, physical safe-area and
assistive-technology device checks, staging p75 LCP/CLS/INP and weak-network
media checks, exact-artifact promotion, and rollback rehearsal. The current
candidate also still requires a separately reviewed Linux baseline followed by
a strict no-update CI pass; these release-only gaps are not open visual defects
in the local macOS candidate.
