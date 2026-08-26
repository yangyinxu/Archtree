# Finitude Web Listener Design QA

## Verdict

**final result: passed**

The current local candidate, including the 2026-08-19 Web palette, typography,
and filled-pause amendment, has no open P0, P1, or P2 visual finding. This
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
- The 2026-08-19 amendment was reviewed from deterministic production-build
  Playwright captures at 320, 390, 844, 857, 1280, 1440, 1728, and 1920 CSS px.

## Required fidelity surfaces

| Surface | Result |
| --- | --- |
| Typography | Passed. Body and display roles now share a Helvetica Neue/Helvetica/Arial-led system stack with explicit CJK and emoji fallbacks. Mixed-script density, truncation, and tabular time remain intact without a proprietary font payload. |
| Shell geometry | Passed. The default 1728 px state uses 8 px outer and panel gutters, 303 px side tracks, and the remaining 1090 px main track. Each side track can grow to 420 px while preserving an 856 px main track. |
| Spacing and density | Passed. Overflowing Home rows use 24 px column gaps, a deliberate partial-card cue, and a 48 px section rhythm. |
| Color hierarchy | Passed. Canvas, panel, raised, hover, primary-text, and secondary-text roles remain distinct; selected states use Spotify green `#1ed760` with black foregrounds, while focus remains a separate white outline. |
| Artwork and crop | Passed. Square artwork is crisp and consistently cropped, Artist art remains circular, and missing-artwork behavior is covered. |
| Icons and controls | Passed. Controls use one icon family, stable targets, real actions, accessible names, disabled states, and visible focus. Play and Pause now both use filled glyphs on the same circular surface. |
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

- Focused strict Chromium gate for visual regression, responsive shell, touch
  orientation, and accessibility: 34 passed with no snapshot update.
- `CI=1 npm run test:e2e --workspace @archtree/finitude-web -- --update-snapshots=none`:
  199 passed and 10 documented capability-specific skips across Chromium,
  Firefox, and WebKit. One unrelated Chromium Archtree logout-header assertion
  was classified flaky; its isolated CI rerun passed.
- `npm test`: 280 server tests and 208 Web tests passed.
- `npm run build`: server and Web production builds passed; the largest
  initial listener route is 148.2 KiB gzip against the 150 KiB budget.
- Static listener assets: 26.9 KiB gzip CSS, 0 bundled font payload, and
  0 bundled image payload.
- `npm run typecheck:e2e --workspace @archtree/finitude-web`: passed.
- Reviewed Playwright evidence: active Home and compact Album states passed;
  the filled Pause glyph is visible in both; exact breakpoint order passed at
  1008, 1007, 800, 799, 768, and 767 px.

## Intentional product deviations

- Finitude keeps its own name, mark, copy, account model, catalog, Playlists,
  and supported controls while the Web interaction accent aligns with Spotify
  green.
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

---

## 2026-08-26 Album now-playing row amendment

### Comparison target

- Source visual truth: user attachment `codex-clipboard-4a60a024-7cca-4921-9dbc-be5708b88967.png`.
- Source dimensions: 2308 × 1482 pixels; source CSS viewport and density are not available.
- Implementation route: `http://127.0.0.1:4174/finitude/albums/e2e-quiet-hours`
- Implementation default-state screenshot: `~/.codex/visualizations/2026/08/26/01a03be4-2679-7c50-8277-b6fb6753e29d/finitude-now-playing-default.jpg`
- Implementation highlighted-state screenshot: `~/.codex/visualizations/2026/08/26/01a03be4-2679-7c50-8277-b6fb6753e29d/finitude-now-playing-hover.jpg`
- Implementation dimensions: 1440 × 900 pixels at a 1440 × 900 CSS viewport and device pixel ratio 1.
- State: dark desktop Album page with `Night Window` actively playing; default and pointer-highlighted row states were captured.
- Density normalization: the source is a different product shell and its CSS density is unknown, so the full views were compared for state hierarchy rather than pixel geometry. Focused row crops were opened in the same comparison input to verify the leading icon, title color, highlight treatment, and row rhythm without claiming false pixel precision.

### Full-view comparison evidence

The source and implementation screenshots were opened together. The implementation keeps Finitude's existing three-panel shell, typography, row density, dark tokens, and controls while adopting the requested now-playing hierarchy. No page-level layout, crop, wrapping, or persistent-player regression was visible at 1440 × 900.

The source uses a lighter hover surface from another product. The implementation intentionally uses Finitude's existing `--color-surface-hover` token so the new state belongs to the current design system instead of copying an unrelated surface value.

### Focused region comparison evidence

- Source row crop: `~/.codex/visualizations/2026/08/26/01a03be4-2679-7c50-8277-b6fb6753e29d/reference-now-playing-row.png` (2180 × 180 pixels).
- Implementation row crop: `~/.codex/visualizations/2026/08/26/01a03be4-2679-7c50-8277-b6fb6753e29d/implementation-now-playing-row.jpg` (540 × 110 pixels).
- Browser measurements: row 504 × 60.625 CSS pixels; music-bars icon 16.797 × 16.797 CSS pixels; active title `rgb(30, 215, 96)`.

The focused comparison confirms a stable Track Number column, green active title, aligned secondary metadata, and a compact green indicator. The supplied image visually retains bars in its captured highlighted frame, while the user's explicit request requires Pause when highlighted; the implementation follows the explicit interaction requirement.

### Required fidelity surfaces

- Fonts and typography: existing Finitude platform sans stack, title weight, line height, truncation, and metadata hierarchy are unchanged. The accent changes only semantic state color.
- Spacing and layout rhythm: the existing 2rem number track and 3.75rem minimum row height remain intact. Swapping number, bars, and Pause does not shift title, duration, or trailing actions.
- Colors and visual tokens: active title and indicator use the canonical Web accent `#1ed760`; highlighted background uses the existing Finitude hover surface; keyboard focus retains the distinct white outline.
- Image and icon quality: the indicator uses Lucide's `AudioLines` asset and the established Finitude Pause icon. No custom SVG, CSS-drawn asset, emoji, or placeholder was introduced.
- Copy and content: no new listener-facing copy was needed. The active primary action reuses the localized `Pause` label and exposes `aria-current="true"`.

### Interaction and accessibility evidence

- Resting active row: animated music bars are visible and the Track Number is hidden.
- Pointer highlight: the row receives its standard hover surface and the indicator transitions to Pause.
- Keyboard focus: the same Pause state appears with the existing white focus outline.
- Pause activation: pauses the shared player without relaunching the Album queue.
- Reduce Motion: the bars remain visible but their path animation becomes `none`.
- Browser console: no error-level messages were recorded during playback, hover, and pause checks.

### Findings

No actionable P0, P1, or P2 differences were found. The visual differences in shell proportions, content, and hover brightness are intentional product-context differences rather than fidelity defects.

### Comparison history

- Pass 1: compared both full views and both focused row crops in the same visual input. No P0/P1/P2 finding required a visual correction, so no post-fix comparison iteration was necessary.

### Follow-up polish

No P3 follow-up is required for this scope.

### Residual repository gate

The strict no-update browser matrix completed with 204 passing checks and 10 documented skips. Eight existing Darwin Chromium goldens failed: seven show the previously implemented language selector missing from their stored baselines, and the active Album golden also contains this amendment's intentional title and music-bars change. Those unrelated/stale baselines were reviewed but not bulk-updated in this focused change.

### Final result

final result: passed
