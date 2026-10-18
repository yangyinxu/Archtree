# Finitude Web Listener Visual System

<!-- @catalog -->
**Contents**

- [Direction](#direction)
- [Source reference and baseline](#source-reference-and-baseline)
- [Tokens](#tokens)
  - [Color](#color)
  - [Geometry](#geometry)
  - [Typography](#typography)
- [Responsive shell](#responsive-shell)
  - [Full desktop, 1008 px and above](#full-desktop-1008-px-and-above)
  - [Compact desktop, 800–1007 px](#compact-desktop-8001007-px)
  - [Compact tablet, 768–799 px](#compact-tablet-768799-px)
  - [Mobile, 767 px and below](#mobile-767-px-and-below)
- [Component language](#component-language)
  - [Artwork tone](#artwork-tone)
- [Motion](#motion)
- [Route guidance](#route-guidance)
- [Visual acceptance](#visual-acceptance)
<!-- @end-catalog -->

## Direction

Finitude Web uses a dense, media-first dark interface informed by the supplied
Web listener reference. Its neutral surfaces, interaction green, and
typographic rhythm align with [Spotify's public design guidance](https://developer.spotify.com/documentation/design)
while Finitude retains its own identity, original components, and product
behavior in `../business-rules.md`.

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
| Media-card hover / pressed | `rgb(255 255 255 / 0.07)` / `rgb(255 255 255 / 0.04)`, translucent so the highlight stays correct over any tinted surface |
| Artwork tone | Derived per artwork (see [Artwork tone](#artwork-tone)); neutral hero `#535353`, neutral pane `#333333` |
| Primary text | `#ffffff` |
| Muted text | `#b3b3b3` |
| Subtle text | `#8f8f8f` |
| Hairline border | `rgb(255 255 255 / 0.10)` |
| Strong border | `rgb(255 255 255 / 0.18)` |
| Interaction accent | Spotify green rooted at `#1ed760`; hover `#3be477`; pressed `#1abc54` |
| Accent foreground | `#000000` |
| Focus | `#ffffff` outline, distinct from the green selected state |

The accent communicates active, selected, and saved states. Focus uses the
separate white outline and no status relies on color alone.

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
- Central media grid: 168 px minimum artwork, five measured columns at the
  1728 px reference viewport, 24 px artwork-to-artwork column rhythm, and
  36 px between one row's text and the next row's artwork (28 px at 480 px and
  below).
- Media cards inset their artwork and copy by a 0.65 rem card padding plus
  their 1 px border (the card inset), so the hover surface frames the whole
  card. Grid and Carousel collections, including Search Artist results, bleed
  outward by the same inset, so artwork stays aligned with the section title,
  Grid column counts are unchanged, and Carousel artwork keeps its clamped
  width. Responsive artwork `sizes` hints describe the artwork, not the card.
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

- Use the public Spotify fallback direction—Helvetica Neue, Helvetica, and
  Arial—followed by deterministic Chinese, Japanese, and emoji system
  fallbacks. Body and display roles share this stack so hierarchy comes from
  scale and weight rather than an unrelated Avenir face.
- Do not bundle or hotlink Spotify Mix, Circular, or another proprietary
  third-party font. The Web listener is a legal system-font approximation, not
  a copy of Spotify's proprietary typography files.
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
| Section title | `clamp(1.25rem, 1.8vw, 1.5rem)` |
| Card title | `0.92rem` |
| Body | `0.9rem` |
| Control label | `0.82rem` |
| Metadata | `0.76rem` |
| Caption | `0.68rem` |

The normal transition tokens are 120 ms for direct hover/control feedback and
200 ms for panes, dialogs, and player presentation changes, using
`cubic-bezier(0.2, 0, 0, 1)`. Media-card Play reveals use the 300 ms reveal
token with the emphasized `cubic-bezier(0.3, 0, 0, 1)` curve. Artwork tones
interpolate over the 600 ms `--motion-tone` token with the standard curve.

Section titles stay compact so the media, not the heading, carries a shelf.
They sit 8 px above the card surface, which places them about 19 px above the
artwork.

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

- Panels use the canvas/panel contrast instead of large borders. An
  artwork-derived tonal gradient may tint the top of the central pane and
  catalog headers, fading into the panel color. It is never a decorative
  full-page wash, it keeps text at WCAG AA contrast under the rules in
  [Artwork tone](#artwork-tone), and it is shared in spirit with the native
  clients' artwork-led backgrounds.
- Media cards are transparent at rest. On hover or focus their whole padded
  surface highlights with the translucent card-hover color, while the artwork
  keeps its own soft drop shadow. The card does not lift, its artwork and text
  do not move, and its copy aligns with the artwork edges.
- A media card's Play action is a filled circular accent control anchored to
  the artwork's bottom-right corner. It slides up 8 px and fades in on hover or
  focus, grows to 1.04× under the pointer, and shrinks to 0.96× while pressed.
  MediaTrack cards keep the whole card as their one Play target, with the
  control as its visual affordance. Album cards keep the card as a link to the
  Album and expose Play as a separate sibling button, never nested inside the
  link. The separate Album Play button is omitted when the device has no hover
  or has any touch pointer, so an invisible control can never capture a tap
  meant for the link.
- The MediaTrack card that is currently playing keeps its control visible as a
  filled Pause glyph, colors its title with the accent, exposes
  `aria-current`, and pauses on activation.
- A Video MediaTrack card that a mouse rests on for 500 ms fades a muted,
  `object-fit: cover` preview over its artwork (300 ms, under the Play
  control). It loops an 8 s window starting 20% in (at most 30 s), clamped to
  the clip's end, is hidden from assistive technology, stops on any press
  inside the card, and never starts with Reduce Motion, forced colors, touch,
  Save-Data, or a hidden page.
- Rows highlight across their complete surface, including trailing controls,
  without creating overlapping actions.
- Primary play and pause glyphs are filled transport icons on the same solid
  circular control surface, so state changes do not introduce a hollow glyph.
- Carousel remains horizontal, Grid remains a grid, and List remains a
  single-column list at every breakpoint.
- Menus and dialogs use raised dark surfaces, compact spacing, visible focus,
  Escape handling, focus trapping, and focus return.
- Loading, empty, unavailable, buffering, success, and error states remain
  understandable without color or animation.

### Artwork tone

- Derivation: the client decodes the managed, same-origin 96 px WebP variant,
  picks the most prominent color family (vivid hues outweigh a slightly larger
  grey field), and adjusts it in OKLCH. Color families are scored as sliding
  30° hue windows, so a shaded color is never split across a bin edge and
  outvoted by a smaller one. Chroma is capped at 0.16, lightness is floored at
  0.28 so dark artwork still shows, and only lightness is lowered, keeping hue,
  until the contrast rule holds. Tones are cached per image id for the 200 most
  recently sampled images.
- Fallback: missing, failed, transparent, cross-origin, and non-managed
  artwork use the neutral tone, never an error state.
- Contrast: each artwork yields two tones. The hero tone keeps primary white
  text at 4.5:1 or more; the darker pane tone also keeps muted `#b3b3b3` text at
  4.5:1 or more. Hero-tone surfaces carry only primary white text and accent
  controls. Pane-tone surfaces carry only primary, muted, and accent text;
  subtle `#8f8f8f` text falls to about 3:1 there and appears only on the plain
  panel or darker. Darkening veils may only lower a tone's lightness.
- Main pane: the top 20.5 rem (about 330 px) of the central pane is a gradient
  from the pane tone into the `#121212` panel that scrolls with the content.
  The color is a registered, non-inheriting `--tone-color` property, so tone
  changes interpolate over 600 ms (immediately with reduced motion) without
  restyling the page. Routes that set no tone keep the panel color, which makes
  the gradient invisible. Artist and Playlist use their artwork's tone and
  Organization uses the neutral tone. Album leaves the main pane untinted
  because its opaque header paints the tone itself; a pane gradient taller than
  a short header would show as a band below it.
- Home: the pane starts at the neutral tone and follows the hovered or
  keyboard-focused (`:focus-visible`) media card; the hovered card wins. A card
  whose tone is not yet known is sampled only after the pointer or focus rests
  on it for 150 ms, so sweeping across a shelf samples just the card it stops
  on. The tone returns to the focused card or the neutral tone 150 ms after
  the pointer leaves the cards. Touch pointers, and focus from a tap or click,
  do not change it.
- Album header: the hero tone sits under a black veil that deepens to 45% and
  then fades into the panel below the actions. Its eyebrow and metadata are
  primary white. The title fits its column: it starts at a size estimated from
  its length (CJK and full-width characters count double) and steps down until
  it fits within three lines at the current width, fitting again when the
  central pane resizes. The smallest step never clamps, so the complete title
  is always readable without the `title` tooltip.
- Compact header: once the Album header has scrolled under the top of the
  central pane, a sticky 4 rem bar on the pane tone fades in with the title and
  a Play control named "Play album {title}" (with the byline when there is
  one), so it never shares a name with a title track's Play. While the bar
  shows, the central pane reserves its height as scroll padding, so keyboard
  focus never scrolls under it (WCAG 2.4.11). While hidden it is inert and
  removed from the accessibility tree; if it hides while its Play has focus,
  focus moves to the header's Play first. Its title is presentational because
  the hero heading names the page. In forced colors the bar keeps a
  `CanvasText` bottom border.

## Motion

| Surface | Normal | Reduced Motion |
| --- | --- | --- |
| Hover/focus | 100–150 ms color/opacity; small icon/action transform only | Immediate state |
| Media-card hover | 300 ms surface highlight and Play reveal: opacity and an 8 px rise; 1.04× hover and 0.96× press scale on the control | Immediate highlight and reveal with no rise or scale |
| Artwork tone | 600 ms `--tone-color` interpolation on the main pane, Album header, and compact header | Immediate color change |
| Compact header | 200 ms opacity fade | Immediate show/hide |
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
  At 768 px and wider, the shell field is an ARIA 1.2 combobox away from the
  Search route: a raised suggestion panel under the field shows arrow-key and
  Enter hints, 48 px artwork rows (circular for Artists), an active row on the
  strong hover surface, and polite count, loading, empty, and error status.
  The Search route hides its duplicate page field at those widths, keeps live
  results driven by the shell field, and offers pill type filters shared with
  Library. Phones keep the page field and the Search tab.
- Library remains the complete server-backed Saved Album/Soundtrack union with
  existing filters, sorts, pagination, and signed-out behavior.
- Album and Artist use artwork-led tonal headers and dense release/track
  layouts without changing readiness or Recently Played policy. The Album
  compact header's Play starts the same canonical Album queue as the hero Play.
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
  empty, error, missing-artwork, long-text, and reduced-motion states, plus the
  neutral and artwork tones and the Album compact header.

The deterministic artwork used during local visual QA is original generated
test material and is not shipped by the application. Production cards continue
to render the catalog artwork supplied by Finitude listener DTOs.
