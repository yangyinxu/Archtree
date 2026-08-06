# Finitude Web Listener Visual System

## Direction

Finitude Web uses a dense, media-first dark interface informed by the supplied
Web listener reference while retaining Finitude branding, the mint interaction
accent, original components, and the product behavior in
`../business-rules.md`.

The reference governs information density, panel hierarchy, spacing rhythm,
typographic proportions, media treatment, and motion quality. It does not add
source-product branding, assets, fonts, copy, promotional surfaces, downloads, following,
friends, device handoff, lyrics, Smart Shuffle, or editable queue behavior.

## Source reference and baseline

- Approved source: the user-supplied 3456 × 1778 Web listener screenshot from
  2026-08-04.
- Responsive source: the signed-in live reference player inspected on
  2026-08-04. Its loaded production CSS and rendered grid were measured at
  multiple viewport widths so the breakpoint contract is based on live layout
  behavior rather than the screenshot alone.
- Target state: wide desktop, dark theme, active queue, left Library pane,
  media-first central Home, right Now Playing context, fixed bottom player.
- Existing implementation baseline: Finitude Home, desktop Search, and mobile
  Search screenshots captured before the visual-system migration.
- The live source declares an 800 px body minimum. That is a measured source
  implementation fact, not a rule copied into Finitude: Finitude keeps a true
  responsive mobile composition below 768 px.
- Motion timing and reduced-motion behavior are defined below rather than
  treated as exact implementation details inferred from the reference.

## Tokens

### Color

| Role | Value |
| --- | --- |
| Canvas | `#000000` |
| Panel | `#121212` |
| Raised surface | `#1f1f1f` |
| Hover surface | `#2a2a2a` |
| Strong hover surface | `#333333` |
| Primary text | `#ffffff` |
| Muted text | `#b3b3b3` |
| Subtle text | `#8f8f8f` |
| Hairline border | `rgb(255 255 255 / 0.10)` |
| Strong border | `rgb(255 255 255 / 0.18)` |
| Finitude accent | Mint family rooted at `#73d9ca` |
| Focus | Bright mint with a non-color outline |

The accent communicates active, selected, saved, and focus states. It does not
replace readable text or become the only indication of status.

### Geometry

- Base spacing scale: 4, 8, 12, 16, 24, 32, 40, and 48 px.
- Shell and panel gap: 8 px on wide desktop.
- Panel radius: 8 px.
- Artwork radius: 4–8 px; Artist artwork remains circular.
- Pill and round-control radius: 999 px.
- At 1008 px and above, the left and right tracks both use
  `clamp(280px, calc(50vw - 224px), 303px)`. This preserves the measured
  303 px tracks at the 1728 px reference viewport while yielding the exact
  280 / 416 / 280 px minimum composition at 1008 px.
- The central pane has a 416 px minimum.
- From 800–1007 px, the left pane becomes a 72 px icon rail while the right
  pane remains 280 px.
- Central media grid: 168 px minimum cards with a 208 px outer cap, five
  measured columns at the 1728 px reference viewport, 24 px column gaps, and
  48 px row rhythm on wide screens.
- Top utility bar: 48 px on wide screens; the compact mobile row is 69.6 px.
- Desktop player: approximately 80–88 px.
- Global layer order is Player 20, Topbar 30, Menu 80, Modal 90, Skip link
  100, Expanded player 110, Destructive confirmation 120, and Shortcut help
  130. Component-internal stacking remains local to its own stacking context.

These measurements combine the same-viewport 1728 × 889 comparison with the
live responsive inspection. The resulting full-shell tracks are symmetric,
shrink only as needed from the measured 303 px reference width to their 280 px
minimum, and preserve the 416 px central-pane minimum.

### Typography

- Use a deterministic system stack with Latin, Chinese, Japanese, and emoji
  fallbacks. Do not load a proprietary third-party font or an external font CDN.
- Roles are display, page title, section title, card title, body, metadata,
  caption, and control label.
- Time and duration use tabular numerals.
- Visible truncation retains a complete accessible name and title where useful.
- Mixed Latin/CJK strings, long titles, missing metadata, and a 640 CSS px
  high-density reflow proxy are required local test cases. Real browser-UI
  200% zoom remains a release validation case.

The implemented semantic roles are:

| Role | Size contract |
| --- | --- |
| Display | `clamp(2.25rem, 5.5vw, 4.8rem)` |
| Page title | `clamp(1.9rem, 3.2vw, 2.7rem)` |
| Section title | `clamp(1.25rem, 2.2vw, 2rem)` |
| Card title | `0.92rem` |
| Body | `0.9rem` |
| Control label | `0.82rem` |
| Metadata | `0.76rem` |
| Caption | `0.68rem` |

The normal transition tokens are 120 ms for direct hover/control feedback and
200 ms for panes, dialogs, and player presentation changes, using
`cubic-bezier(0.2, 0, 0, 1)`.

## Responsive shell

### Full desktop, 1008 px and above

- The top utility bar spans the shell.
- The left pane contains primary navigation. When the separately delivered
  Playlist capability is available, New Playlist and the signed-in listener's
  Playlist list follow in the same pane.
- The central panel is the primary vertical scroll region.
- The right pane reads current player and queue state only and can be opened or
  closed through the real Now Playing control in the player.
- The player spans the viewport bottom without becoming part of a page scroll.
- Left and right tracks use
  `clamp(280px, calc(50vw - 224px), 303px)` around a central track with a
  416 px minimum, separated by 8 px gaps.

### Compact desktop, 800–1007 px

- The left pane becomes a persistent 72 px icon rail rather than disappearing.
- The right pane remains visible at 280 px and can still be toggled by the
  player control.
- The central pane retains a 416 px minimum at the 800 px boundary.
- Player identity, transport, timeline, and volume remain reachable.

### Compact tablet, 768–799 px

- The 72 px left icon rail remains visible.
- The right pane is hidden only after the viewport falls below 800 px.
- When the Playlist capability is available, Playlists remain reachable from
  Library and do not become a fourth tab.

### Mobile, 767 px and below

- One content column fills the available space.
- Home, Search, and Library remain the three bottom destinations.
- The compact player sits immediately above bottom navigation.
- Expanded playback is another presentation of the same audio element, queue,
  and store.

## Component language

- Panels use the canvas/panel contrast instead of large borders or ambient
  gradients.
- Media cards are transparent or raised at rest, reveal a real Play action on
  hover/focus, and do not lift the entire card or move its text.
- Rows highlight across their complete surface, including trailing controls,
  without creating overlapping actions.
- Carousel remains horizontal, Grid remains a grid, and List remains a
  single-column list at every breakpoint.
- Menus and dialogs use raised dark surfaces, compact spacing, visible focus,
  Escape handling, focus trapping, and focus return.
- Loading, empty, unavailable, buffering, success, and error states remain
  understandable without color or animation.

## Motion

| Surface | Normal | Reduced Motion |
| --- | --- | --- |
| Hover/focus | 100–150 ms color/opacity; small icon/action transform only | Immediate state |
| Menu/dialog | 180–240 ms opacity and 4–8 px transform | Immediate open/close |
| Right pane | 200–300 ms opacity/transform | Immediate layout change |
| Player expansion | 220–300 ms rigid surface transition | Immediate presentation change |
| Swipe settlement | 240–280 ms after direct axis-locked tracking | Direct state change |
| Progress/volume | 100–150 ms fill/thumb reveal | Immediate state |

Nonessential motion uses transform and opacity, produces no layout shift, and
is disabled through `prefers-reduced-motion`. Buffering remains semantically
announced even when its spinner is static.

## Route guidance

- Home is content-first and preserves configured section type and order.
- Search shares one draft/URL/history state between shell and page
  presentations, retains IME safety, and has no separate text Search button.
- Library remains the complete server-backed Saved Album/Soundtrack union with
  existing filters, sorts, pagination, and signed-out behavior.
- Album and Artist use artwork-led tonal headers and dense release/track
  layouts without changing readiness or Recently Played policy.
- Playlist retains owner-only access, limits, membership order, accessible move
  controls, unavailable-member positions, and queue-copy behavior.
- Account and authentication reuse the same tokens without changing capability
  discovery, privacy-safe responses, session handling, or avatar lifecycle.
- The right Now Playing pane shows only current artwork, title, artists, and an
  accurate effective next item. It never creates another player or activity
  event. Its player control is a real accessible toggle, and changing its
  presentation does not remount playback.

## Visual acceptance

- Compare source and implementation at matched wide-desktop dimensions and
  state, then use focused comparisons for topbar, left pane, card grid, right
  pane, and player.
- Verify the responsive boundaries at 1008, 1007, 800, 799, 768, and 767 CSS
  px, plus 1280 × 800, 1440 × 900, 1920 × 1080, 390 × 844, 320 × 568, and
  mobile landscape.
- Verify default, hover, focus-visible, pressed, selected, disabled, loading,
  empty, error, missing-artwork, long-text, and reduced-motion states.
- No final handoff is complete while actionable P0, P1, or P2 findings remain
  in the project-root `design-qa.md`.

The deterministic artwork used during local visual QA is original generated
test material and is not shipped by the application. Production cards continue
to render the catalog artwork supplied by Finitude listener DTOs.
