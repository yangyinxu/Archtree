# Finitude Web Reference Redesign Plan

## Status

**Overall status: Stages 0–8 are complete for the local candidate as of
2026-08-05, and Stage 9 is in progress. An earlier narrow predecessor was
pushed and exercised the Ubuntu release workflow, but the current integrated
candidate is still local and includes visual-regression, Playlist, Carousel,
and resizable-panel work that predecessor did not contain. Completion still
requires a current commit-identified CI run, a separately reviewed Linux pixel
baseline, an authorized staging target, real-device/manual accessibility
checks, staging Web Vitals, exact-artifact promotion, and rollback rehearsal.**

The user confirmed Choice A on 2026-08-04: match the reference's information
density, dark hierarchy, typography rhythm, and motion quality while retaining
Finitude branding, original components, supported features, and the current
canonical product rules. Local implementation and design QA are complete;
release validation and rollback work remain open.

The 2026-08-05 continuation audit reopened any stage whose implementation had
landed but whose documented exit gate was still missing. A stage returns to
Complete only after its complete evidence is reproducible from the current
candidate.

This file is sequencing material. `../business-rules.md` remains the canonical
source for product behavior. Delete this plan after all planned work and its
required verification are complete.

## Objective

Redesign the Finitude Web listener so its information density, dark surface
hierarchy, typography rhythm, responsive shell, media cards, track rows,
transport controls, and motion feel as polished and coherent as the supplied
Web-player reference, while preserving Finitude's actual catalog, account,
Library, Playlist, and playback contracts.

The redesign is successful only when it:

- Produces one consistent visual system across Home, Search, Library,
  Playlists, Album, Artist, Account, authentication, dialogs, and player
  surfaces.
- Preserves the one long-lived audio element and queue across routes,
  breakpoints, player expansion, and account changes.
- Preserves administrator-configured Carousel, Grid, and List presentation
  types and their persisted order.
- Preserves public browsing, owner-scoped private data, streaming-only Web,
  Playlist ownership, Search history, and all current accessibility behavior.
- Does not add decorative controls for unsupported reference-product
  capabilities.
- Passes visual, responsive, interaction, accessibility, playback-continuity,
  performance, and release gates defined below.

## Stage 0 decision: fidelity versus Finitude identity

The current conflict is explicit:

- `../business-rules.md` says the desktop Playlist sidebar may use a reference
  layout for hierarchy without copying another product's branding or exact
  components.
- `finitude-web-listener-plan.md` says external music players are density and
  placement references, not skins to reproduce.
- The requested target says typography, animation, and color should be
  completely identical to the supplied source product.

Choose and record one of these definitions before implementation:

| Choice | Fidelity definition | Canonical documentation impact |
| --- | --- | --- |
| A — Recommended | Match the reference's density, panel hierarchy, spacing rhythm, typography proportions, interaction grammar, and motion quality; retain the Finitude name, mark, accent, original components, copy, and supported feature set. | The existing business rule remains valid; add only any newly agreed Web-specific layout behavior. |
| B — Exact replica | Reproduce the reference's brand color, navigation placement, typography metrics, component geometry, and motion as closely as available assets and licenses permit. | Update `../business-rules.md` and the existing Web plan before implementation, document font/asset rights, and define which exact-component restriction is being replaced. |

Both choices keep the following boundaries:

- No source-product logo, name, copyrighted artwork, proprietary font, or other
  third-party asset is added without explicit rights and a self-hostable file.
- Premium upsell, Install App, friends activity, Follow, device handoff,
  lyrics, voice search, Smart Shuffle, recommendation insertion, Web downloads,
  and editable queue controls are not added merely because they appear in a
  reference product.
- Any visible control must perform a real Finitude action and have an
  accessible name, focus state, loading state, error state, and touch target.
- Finitude Web remains streaming-only, and mobile Playlists remain owned by
  Library rather than becoming a fourth primary tab.

Stage 0 must also decide:

1. Whether the accent remains Finitude mint or changes to reference green.
2. Whether the desktop primary navigation remains in the left pane or moves
   into the top utility bar.
3. Whether the Search route keeps both shell and page search fields or uses one
   responsive presentation of the existing shared query state.
4. Whether the right Now Playing pane is default-open on wide screens, opens
   only after playback starts, or remains user-controlled.
5. Whether a licensed self-hosted typeface will be supplied. If not, the
   target is metric similarity through the system font stack, not font
   identity.
6. Whether motion fidelity will be judged only from the supplied still image
   plus the specification below, or from an approved live/video reference.

## Current implementation baseline

The existing foundation should be evolved rather than replaced:

- `web/src/app/AppShell.tsx` owns a long-lived shell with desktop sidebar,
  topbar, route outlet, bottom player, and mobile navigation.
- `web/src/player/playerStore.ts` owns the module-level player and the only
  `HTMLAudioElement`; route components launch queues but do not own playback.
- `web/src/components/PlayerBar.tsx` already provides desktop transport,
  mobile compact and expanded surfaces, keyboard shortcuts, and swipe actions.
- `web/src/components/PageSection.tsx`, `ContentCard.tsx`, and
  `ContentListRow.tsx` are the shared Carousel/Grid/List presentation layer.
- `web/src/styles/tokens.css` centralizes palette, typography, radii, shadows,
  motion, and shell dimensions, although route breakpoints remain fragmented.
- React Router routes are lazy-loaded, the initial-route JavaScript budget is
  150 KiB gzip, and the largest documented route is already close to that
  ceiling.
- The supplied 3456 × 1778 pixel still establishes the wide composition. A
  signed-in live source-product inspection now additionally establishes the
  responsive grid behavior from its rendered layout and loaded production CSS;
  motion timing, empty states, and accessibility behavior still follow the
  Finitude specification rather than being inferred from the source.

The current worktree contains unrelated and in-progress changes in the shell,
Home, Library, Album, player, Playlist implementation, tests, and documentation.
Implementation must preserve those changes. Before Stage 1, identify their
owner and record a scoped diff inventory. Because the user deferred commits,
use non-destructive diff audits as the temporary safeguard; do not reset,
clean, overwrite, or stage unrelated changes to manufacture a baseline.

## Target visual system

The values below are the proposed measuring baseline. Stage 1 converts them
into an approved design specification; Stage 0 may change the accent and brand
rules.

### Surface and spacing tokens

| Role | Proposed baseline |
| --- | --- |
| Canvas | `#000000` |
| Primary panel | `#121212` |
| Raised surface | `#181818` to `#1f1f1f` |
| Hover/selected surface | `#242424` to `#2a2a2a` |
| Primary text | `#ffffff` |
| Secondary text | `#b3b3b3` |
| Subtle text | `#8f8f8f` |
| Hairline border | `rgb(255 255 255 / 0.10)` |
| Accent, Choice A | Existing Finitude mint family |
| Accent, Choice B | Reference green family after Stage 0 approval |
| Focus indicator | A dedicated high-contrast token, never color-only state |
| Base spacing | 4 px scale: 4, 8, 12, 16, 24, 32, 40, 48 |
| Artwork radius | 4–8 px; Artist artwork remains circular |
| Panel radius | 8 px |
| Pills and circular controls | 999 px |
| Wide shell gutter | 8 px |
| Top utility bar | 48 px |
| Desktop player | Approximately 80–88 px |

### Typography

- Use one self-hosted, licensed variable font only if its legal source and
  WOFF2 files are supplied. External font CDNs remain incompatible with the
  current listener CSP.
- Otherwise use a deterministic system stack with compatible Latin, Simplified
  Chinese, Traditional Chinese, Japanese, and emoji fallbacks.
- Define semantic roles rather than page-specific sizes: display, page title,
  section title, card title, body, metadata, caption, and control label.
- Use tabular numerals for time and duration, two-line clamping only where the
  approved reference uses it, and complete accessible names for truncated text.
- Test mixed English/Chinese/Japanese titles, very long names, missing metadata,
  and the 640 CSS px high-density reflow proxy before approving the local
  scale. Retain real browser-UI 200% zoom for Stage 9 release validation.

### Responsive shell geometry

| Range | Composition |
| --- | --- |
| Full desktop, 1008 px and above | Top utility bar; full left navigation/Library pane; independently scrolling main panel; right Now Playing pane; fixed full-width player. Both side tracks use the responsive clamp below. |
| Compact desktop, 800–1007 px | Persistent 72 px left icon rail, main panel, and 280 px right Now Playing pane. The player retains its reachable identity, transport, timeline, and utility controls. |
| Compact tablet, 768–799 px | Persistent 72 px left icon rail and main panel; the right pane is hidden only below 800 px; no new Playlist tab. |
| Mobile, 767 px and below | One content column, compact player above Home/Search/Library bottom navigation, expanded player over the same store and queue. |
| Narrow and zoomed | Reflow to one axis at 320 CSS px and 200% zoom with every primary action reachable. |

The implemented shell contract is:

- `--shell-gap: 8px`
- `--left-pane-width: clamp(280px, calc(50vw - 224px), 303px)`
- `--right-pane-width: clamp(280px, calc(50vw - 224px), 303px)`
- `--main-pane-min: 416px`
- `--compact-left-pane-width: 72px`
- `--compact-right-pane-width: 280px`

The source product's loaded CSS declares an 800 px body minimum. This is
retained only as
source evidence: Finitude deliberately does not copy that constraint and keeps
its mobile layout responsive down to 320 CSS px.

### Motion grammar

Use CSS transitions or the Web Animations API. Do not add a shell-wide motion
framework unless a measured bundle review proves it fits the existing route
budget.

| Interaction | Normal motion target | Reduced Motion behavior |
| --- | --- | --- |
| Card hover/focus | 100–150 ms surface-color change; reveal a real Play action with opacity and small translate; no decorative card lift | Immediate state change; action remains visible on focus |
| Row hover/focus | 100–150 ms surface highlight across the full row, including trailing actions | Immediate highlight |
| Icon button hover/press | 100–150 ms color/scale with a stable hit area | Color/border state only |
| Menu/dialog | 180–240 ms opacity and small transform; focus moves only after the surface is interactive | Immediate open/close with the same focus management |
| Right pane show/hide | 200–300 ms opacity/transform or measured grid transition without changing player state | Immediate layout change |
| Compact-to-expanded player | 220–300 ms surface transition; the same queue and audio remain mounted | Immediate presentation change |
| Mobile swipe | Axis lock and a visually direct response; settle to only an available adjacent queue item | Direct state change with no inertial flourish |
| Progress/volume control | 100–150 ms fill/thumb reveal; seeking still commits only through the existing policy | Immediate visual state |
| Buffering | Bounded indicator plus `aria-busy` and stable text semantics | Static indicator plus the same semantics |

All nonessential motion should use `transform` and `opacity`, produce no CLS,
and be suppressed by `prefers-reduced-motion` without removing information or
controls.

## Route and surface mapping

| Finitude surface | Redesign direction | Behavior that must not change |
| --- | --- | --- |
| App shell | Black canvas, 8 px gutters, rounded panels, denser top utility bar, optional wide-screen right pane | Fixed shell, independent main scroll, skip link, route announcer, lazy routes, one player |
| Home | Replace the oversized marketing-first composition with a content-first header and denser configured sections after Stage 0 approval | Persisted Carousel/Grid/List order and presentation; signed-out public access |
| Search | Use the shell search proportions and dense grouped results; keep one shared query provider across visible fields | Debounce, IME safety, URL/history semantics, no voice search, no separate Search button |
| Library | Dense filter pills, sort control, media rows, and optional left-pane saved-content discovery | Complete Saved Album/Soundtrack union, owner scope, no 20-item cap, no Web downloads |
| Album | Artwork-led tonal header, prominent round Play control, compact metadata, dense track table | Canonical queue order, ready-only tracks, Save behavior, Recently Played policy |
| Artist | Artwork-led header with compact biography and dense release sections | Public ready content only and current Album/Soundtrack navigation |
| Playlist index/detail | Place summaries in the desktop left hierarchy and use a dense detail header/table | Owner-only access, quotas, duplicate behavior, persisted order, queue snapshot semantics |
| Account/auth | Reuse the same dark surfaces, type scale, buttons, fields, dialogs, and avatar treatment | Capability-driven methods, generic privacy-safe responses, session/account behavior |
| Player | Reference-like three-part bottom bar, stronger progress treatment, matching hover/focus states | One audio element, queue, Shuffle/Repeat, Previous threshold, seeking policy, logout continuity |
| Right Now Playing pane | Current artwork/title/artist plus an accurate read-only next item from the actual playback order | No second player, no fake Follow/provider/device controls, no activity writes |

The right pane requires a narrow player-store contract change if it shows the
next item. Shuffle order is private implementation state today, so the UI must
receive an explicit `upNext` or effective-order selector and must not infer
`queue[currentIndex + 1]`. The current queue item also lacks Album, provider,
follow, and device metadata; those reference cards stay absent unless a
separate product and API contract is approved.

Playlist summaries currently lack artwork. If the approved visual requires
packshots in the left pane, extend the owner-only summary DTO with server-
derived artwork in one bounded projection. Do not hydrate every Playlist with
N+1 detail requests and do not expose membership or private owner fields.

## Implementation stages

### Stage 0 — Resolve canonical product and identity decisions

**Status: Complete**

Choice A was confirmed on 2026-08-04. The existing canonical rule remains
valid, the Finitude mint accent remains the interaction accent, desktop primary
navigation remains above the Playlist list in the left pane, and unsupported
reference-product features remain absent. Search continues to use one shared
query state, and the wide-screen Now Playing pane may read only the existing
Finitude player and queue contract.

Tasks:

- Confirm Choice A or Choice B and the six open decisions above.
- If Choice B changes the canonical rule, update `../business-rules.md` and the
  conflicting visual-language sections in `finitude-web-listener-plan.md`
  before UI implementation.
- Record an asset policy for logo, font, icons, artwork, and reference captures.
- Confirm that unsupported reference-product features remain absent.
- Confirm the wide-screen right pane and Search-field presentation.

Exit gate:

- One written fidelity definition exists, canonical documentation is aligned,
  and no rule conflict remains.

### Stage 1 — Freeze evidence and produce the visual specification

**Status: Complete**

The supplied 3456 × 1778 source, matched source/candidate viewport captures,
the pre-redesign desktop Home/Search and mobile Search captures, and the
approved Choice A visual contract are recorded in
`../design/finitude-web-listener-visual-system.md` and `../../design-qa.md`.
The specification freezes the shell geometry, semantic tokens, typography,
responsive boundaries, motion grammar, and edge-state fixtures. The
implementation preserved the dirty worktree and applied scoped edits without
resetting or cleaning unrelated changes. A historical field-telemetry baseline
was unavailable; staging Web Vital comparison remains a Stage 9 release gate
rather than an implementation blocker.

Dependencies: Stage 0 and a non-destructive inventory of the existing dirty
worktree. The user explicitly deferred commit/staging, so scoped diff audits
and preservation of all unrelated changes replace a formal checkpoint until
Stage 9 authorization.

Tasks:

- Capture the current Finitude implementation and the approved reference at
  matched viewports and states. Do not use a static screenshot alone to infer
  motion.
- Measure panel widths, gutters, topbar/player heights, card dimensions,
  artwork ratios, line heights, truncation, radii, and visible states.
- Build a route/state reference matrix for signed-out, signed-in, idle,
  playing, buffering, error, empty, retry, dialog, and menu states.
- Include stable covers plus missing artwork, long CJK text, emoji, missing
  metadata, and mixed content types.
- Write an approved visual specification under `docs/design/` containing the
  final token table, responsive geometry, motion timings, and component-state
  sheets.
- Record the pre-redesign bundle sizes, Core Web Vitals, playback success/error
  rates, and browser screenshots for rollback comparison.

Exit gate:

- The reference and Finitude baseline can be compared at identical viewports;
  all token and motion values needed for Stage 2 are explicit.

### Stage 2 — Rebuild tokens and shared visual foundations

**Status: Complete**

The semantic tokens, computed-token contract fixture, and route/static-asset
budgets are implemented. At Stage 2 completion the candidate built with
24.3 KiB gzip CSS, no bundled font/image payload, and a 149.0 KiB largest
initial route against the 150 KiB JavaScript budget. Stage 9 records the final
integrated-candidate sizes.

Dependencies: Stage 1.

Primary files:

- `web/src/styles/tokens.css`
- `web/src/styles/global.css`
- `web/src/styles/Pages.module.css`
- `web/index.html`
- `src/middleware/securityHeadersMiddleware.ts` only if approved self-hosted
  font files require a documented CSP adjustment

Tasks:

- Replace page-specific color literals with semantic canvas, panel, raised,
  hover, text, border, accent, focus, danger, and disabled tokens.
- Define one spacing scale, type scale, radius scale, z-index map, shell sizing,
  and unified wide/desktop/tablet/mobile breakpoints.
- Add approved font assets only when licensed, self-hosted, subsetted, and
  bounded; otherwise freeze the system stack.
- Retain global reduced-motion and forced-colors behavior.
- Remove ambient gradients and decorative elevation that conflict with the
  approved dark panel hierarchy.
- Add a CSS payload measurement to the build or release evidence before the
  new baseline is accepted.

Exit gate:

- A token-only test page or fixture demonstrates every semantic state without
  route-specific overrides, and the initial route remains within budget.

### Stage 3 — Convert the application shell and responsive layout

**Status: Complete**

The responsive shell was recalibrated from a signed-in live source-product
measurement. The prior implementation hid the right pane at 1439 px, which was
too early. The measured compact desktop composition keeps a 72 px left rail,
a main pane of at least 416 px, and a 280 px right pane at an 800 px desktop
canvas. At 1008 px and above, both side panes use
`clamp(280px, calc(50vw - 224px), 303px)` with 8 px gaps. The right pane hides
only below 800 px, the left rail remains through 768 px, and Finitude preserves
its separate mobile composition at 767 px and below. Browser QA passed at
1008, 1007, 800, 799, 768, 767, and 320 CSS px without overlap or horizontal
overflow. The real Now Playing toggle also preserves the route and current
track while growing the 1280 px main pane from 642 px to 953 px.

The current application-browser pass additionally observed a 786 px canvas
with a 72 px left rail, 690 px main pane, hidden right pane, retained Playlist
artwork entry, and no document overflow. Exact breakpoint assertions pass at
1008, 1007, 800, 799, 768, and 767 CSS px. Wide, mobile portrait, mobile
landscape, 320 px reflow, and a 640 CSS px high-density proxy also pass without
overlap or horizontal page scrolling. Real browser-UI 200% zoom remains a
manual Stage 9 release check.

Dependencies: Stage 2.

Primary files:

- `web/src/app/AppShell.tsx`
- `web/src/app/AppShell.module.css`
- `web/src/app/AppShell.test.tsx`
- A new `web/src/components/NowPlayingAside.tsx` and CSS Module if approved
- A focused Library-pane component instead of adding more responsibility to
  `PlayerBar.tsx`

Tasks:

- Use named CSS grid areas for topbar, left pane, main pane, optional right
  pane, player, and mobile navigation.
- Keep `height: 100dvh`, `min-height: 0`, fixed player reservation, and clear
  scroll ownership so wheel input over the player cannot scroll the shell.
- Recompose Finitude brand, primary navigation, shared Search state, account
  entry, New Playlist, and Playlist/Library summaries according to Stage 0.
- Mount the right pane as a read-only consumer of player state; never create an
  audio element, queue, or Recently Played side effect there.
- Provide a real accessible Now Playing toggle in the player and preserve the
  mounted playback element while the right pane opens or closes.
- At 1008 px and above, retain both full panes; at 800–1007 px, reduce only the
  left pane to a 72 px icon rail while keeping the right pane at 280 px; at
  768–799 px, retain the rail and hide the right pane; at 767 px and below,
  switch to the existing mobile composition.
- Preserve Home/Search/Library as the three mobile primary destinations and
  keep Playlists within Library on tablet/mobile.
- Preserve skip-link, route-announcement, focus, deep-link, and browser-history
  behavior.

Exit gate:

- Empty and playing shells pass the 1008, 1007, 800, 799, 768, and 767 CSS px
  boundary checks plus wide desktop, mobile portrait, mobile landscape, 320 px
  reflow, and a 640 CSS px high-density proxy without overlap or horizontal
  page scrolling. Real browser-UI 200% zoom is retained as a Stage 9 manual
  release check.

### Stage 4 — Restyle shared media and interaction primitives

**Status: Complete**

The shared primitives are visually migrated, including a real Play reveal
inside the existing card action, semantic color/shadow/layer tokens, 44 px
coarse-pointer targets, forced-colors handling, and reduced-motion behavior.
Default, hover, focus-visible, pressed, selected, disabled, loading, error,
missing-artwork, long-text, coarse-pointer, and reduced-motion states are
covered by component tests, accessibility checks, and reviewed visual states.

Dependencies: Stage 3.

Primary files:

- `web/src/components/PageSection.tsx` and CSS Module
- `web/src/components/ContentCard.tsx` and CSS Module
- `web/src/components/ContentListRow.tsx` and CSS Module
- `web/src/components/Artwork.tsx` and CSS Module
- `web/src/components/Icon.tsx`
- `web/src/components/SaveButton.tsx` and CSS Module
- `web/src/components/ActionMenu.tsx` and CSS Module
- `web/src/components/ModalDialog.tsx` and CSS Module
- `web/src/components/Avatar.tsx` and CSS Module

Tasks:

- Implement approved card, row, play-overlay, icon-button, chip, field, menu,
  dialog, avatar, and loading/empty/error states.
- Keep one non-overlapping primary action for every card and list row; trailing
  actions remain separate accessible targets.
- Preserve Artist circular art, Album/Soundtrack square art, current responsive
  image variants, lazy loading, and placeholder behavior.
- Keep Carousel horizontally scrollable, Grid a grid, and List a single-column
  list at every width.
- Make hover-only affordances visible through keyboard focus and available
  through persistent controls on coarse-pointer devices.
- Replace unit/E2E assertions against old literal RGB values with semantic
  state assertions plus approved visual snapshots.

Exit gate:

- Every primitive has default, hover, focus-visible, pressed, selected,
  disabled, loading, error, missing-artwork, long-text, and reduced-motion
  evidence.

### Stage 5 — Recompose player surfaces and motion

**Status: Complete**

The player surfaces and effective Up Next contract are implemented. Compact
touch swipes now use axis locking, direct pointer tracking, edge resistance,
and reduced-motion settlement; the right pane uses a 200 ms opacity/transform
transition while exact closed geometry expands the 1280 px main pane to 953
px. Current-candidate browser checks prove playback continuity with active
audio, stable elapsed time, one audio element, zero motion-driven layout shift,
and no redesign-caused long task across route, breakpoint, pane, and player
presentation transitions.

Dependencies: Stages 3–4.

Primary files:

- `web/src/components/PlayerBar.tsx` and CSS Module
- `web/src/components/SeekSlider.tsx` and CSS Module
- `web/src/player/types.ts`
- `web/src/player/playerStore.ts`
- Relevant player, slider, and playback-launch tests

Tasks:

- Restyle the desktop player into identity, transport/timeline, and
  volume/auxiliary regions without remounting the shared store.
- Implement the approved compact, expanded, and right-pane transitions with
  the motion grammar above.
- Expose the actual effective next item when the right pane requires it,
  including shuffled and repeated order; do not infer private store order in a
  component.
- Preserve pointer seek preview, release-to-commit, keyboard seek, volume,
  mute, Shuffle, Repeat, Previous-at-three-seconds, error recovery, Media
  Session, and shortcut exclusion for editable controls.
- Preserve current soundtrack, source, elapsed time, status, queue/index,
  Shuffle, Repeat, volume, and mute through route changes, Back/Forward,
  compact/expanded changes, breakpoint resize, dialogs, and logout.
- Continue to expose every gesture action through a visible button.

Exit gate:

- Automated continuity tests prove one audio element and no time reset across
  every presentation transition; motion has no CLS or redesign-caused long
  task.

### Stage 6 — Migrate public discovery routes

**Status: Complete**

The public routes are visually migrated. Deterministic Home and compact Album
fixtures cover configured sections, active playback, long multilingual names,
missing artwork, dense track rows, and responsive source viewports. Current
behavior, retry, public-data, and presentation-type tests remain green.

Dependencies: Stages 4–5.

Primary files:

- `web/src/features/home/HomePage.tsx`
- `web/src/features/search/SearchPage.tsx`
- `web/src/features/catalog/AlbumPage.tsx`
- `web/src/features/catalog/ArtistPage.tsx`
- `web/src/features/catalog/CatalogPages.module.css`
- `web/src/styles/Pages.module.css`

Tasks:

- Make Home content-first and dense while retaining every configured section
  type, order, personalized resolution, error, retry, and public signed-out
  behavior.
- Harmonize shell and Search-page fields without splitting their shared draft,
  IME, debounce, URL, and history state.
- Apply the artwork-led Album and Artist headers, compact metadata, Play/Save
  actions, and dense track/release layouts.
- Preserve ready/published boundaries and use only allowlisted listener DTOs.
- Verify long multilingual content, missing art, zero sections/tracks, and
  partial errors.

Exit gate:

- Home, Search, Album, and Artist match approved screenshots at all target
  widths and retain their current behavior tests.

### Stage 7 — Migrate private, Playlist, and account routes

**Status: Complete**

Library, Playlist, account, authentication, avatar, and dialog surfaces are
visually migrated. Playlist summary/detail artwork uses one bounded owner-
scoped projection with batched ready-track/Album reads and no N+1 detail
hydration. The signed-in browser and automated matrix cover Playlist, Library,
Account, Sessions, Search, dialogs, focus return, ownership boundaries, axe,
keyboard navigation, and playback-preserving SPA navigation.

Dependencies: Stage 6 and the completed Playlist implementation baseline.

Primary files:

- `web/src/features/library/LibraryPage.tsx` and CSS Module
- `web/src/features/playlists/*`
- `web/src/features/account/*`
- `web/src/features/account/avatar/*`
- `web/src/api/playlists.ts` and owner-only backend projection only if approved
  Playlist artwork is missing from the required visual

Tasks:

- Restyle Library filters, sort, rows, pagination, signed-out, empty, loading,
  error, and unavailable states without adding Web Download behavior.
- Restyle Playlist sidebar, index, detail, member rows, Add-to-Playlist flow,
  create/rename/delete dialogs, and accessible move controls.
- If left-pane Playlist art is approved, extend the summary DTO in one bounded
  owner-scoped projection with schema validation and integration coverage.
- Restyle Login, registration, verification, recovery, Account, sessions,
  credential changes, avatar crop, and destructive confirmation surfaces.
- Confirm account switch/logout clears owner-scoped caches and Search history
  but does not stop an already-playing public stream.

Exit gate:

- No private cache crosses accounts; every signed-in/signed-out state and
  dialog passes keyboard, focus-return, ownership, and visual checks.

### Stage 8 — Add visual, responsive, motion, and accessibility gates

**Status: Complete**

The Stage 8 candidate includes deterministic local artwork, exact breakpoint,
keyboard, axe, motion, forced-colors, touch/orientation, active-audio
continuity, and Chromium screenshot gates. Eight platform-scoped snapshot
paths were generated from intentionally reviewed macOS Chromium captures; the
target visual run passes 10/10 without snapshot updates. The complete local
three-engine matrix at that checkpoint passed 173 tests with 10 documented
capability/ownership skips and no failures. E2E TypeScript also passed. Linux
CI snapshot execution, real browser-UI 200% zoom, and physical-device safe-
area/assistive-technology coverage remain Stage 9 release gates.

Dependencies: Stages 3–7.

Recommended new files:

- `web/e2e/visual-regression.spec.ts`
- `web/e2e/responsive-shell.spec.ts`
- `web/e2e/motion.spec.ts`
- `web/e2e/playback-continuity.spec.ts`
- `web/e2e/keyboard-navigation.spec.ts`
- `web/e2e/fixtures/visualCatalog.ts`
- `web/e2e/support/visual.ts`

Tasks:

- Add deterministic local artwork and multilingual fixtures for visual tests;
  do not depend on external image URLs.
- Use Chromium as the reviewed pixel baseline and keep Firefox/WebKit for
  behavior and accessibility. Freeze font, animation, time, caret, and fixture
  state. Keep OS baselines separate so Linux never silently approves macOS font
  rendering; review the first Linux baseline in CI before release.
- Require design review before updating snapshots; never bulk-refresh snapshots
  merely to make a failure green.
- Capture the 1008, 1007, 800, 799, 768, and 767 CSS px shell boundaries plus
  1280 × 800, 1440 × 900, 1920 × 1080, 390 × 844, 320 × 568, and 844 × 390
  states.
- Expand axe coverage to Search, Library, Artist, Account, signed-in Playlist,
  menus, dialogs, and loading/empty/error states.
- Test full Tab order, skip link, Escape, focus return, shortcuts, forced
  colors, Reduce Motion, touch, and orientation changes locally. Use the 640
  CSS px high-density proxy for deterministic reflow coverage; retain real
  browser-UI 200% zoom and physical safe-area checks for Stage 9.
- Measure motion start/mid/end behavior separately from stable-state visual
  snapshots.
- Update `../testing/finitude-web-release-matrix.md` with the new gates and
  exact evidence.

Exit gate:

- No critical or serious axe result, no unowned new moderate result, no visual
  diff outside the approved tolerance, no keyboard trap, and no supported
  viewport regression.

### Stage 9 — Performance, release, and rollback

**Status: In progress**

The latest local unit, integration, build, typecheck, and browser prerequisites
pass: 222 server tests, 204 Web tests, 126 Mongo-backed integration tests, both
production builds, E2E TypeScript, static asset budgets, and a strict
no-snapshot-update three-engine matrix with 191 passes, 10 documented skips,
and no failures. The reviewed Chromium visual gate remains 10/10. Staging Web
Vitals, a separately reviewed Linux baseline followed by strict no-update CI,
the real-browser/device/assistive-technology matrix, exact-artifact promotion,
and rollback rehearsal require an authorized staging target and immutable
candidate commit. Before commit authorization, the dirty candidate could not be staged as
a commit-identified release artifact. The local release attempt confirmed the
guardrail: `npm run stage:eb-artifact` stopped with
`Commit local changes before staging a release artifact.` before creating an
artifact directory. The current Darwin arm64 host has no Docker, Podman,
Colima, or `act` runtime, so the Ubuntu 24.04 CI pixel gate cannot be reproduced
locally without installing a new runtime or pushing a commit-identified
candidate. No dependency or runtime was installed for this check. A temporary
structural rollback rehearsal archived the real current `HEAD`, built it with
that revision's own scripts, generated a release-identified artifact, verified
the zip with `unzip -t`, and confirmed the extracted bundle matched its staged
tree byte-for-byte. The temporary files were removed. This does not satisfy the
release gate: the older revision emits `/listen/assets/` while the current
stager requires `/finitude/assets/`, proving that a previous release must use
its retained original CI archive rather than a locally rebuilt substitute.

The first pushed Ubuntu 24.04 gate completed 58 of 60 browser checks. Retained
trace evidence showed that Chromium treated two wheel actions issued about
87 ms apart as one latched gesture, even after the pointer moved from the
fixed player to the independently scrollable main pane. The same test passed
in Firefox and WebKit, and the main pane retained a valid overflow range. The
approved remediation separates the two wheel contracts into fresh-page tests.
Firefox separately reported `NS_ERROR_DOM_MEDIA_MEDIASINK_ERR` because the
headless runner had no usable audio output sink after loading valid duration
metadata. The approved seek-test remediation pauses playback before awaiting
metadata, keeping the seek contract independent of host audio hardware. These
are test-only changes; the product scroll and playback contracts are unchanged.

The wide-shell enhancement is locally complete. Overflowing recommendation
rows now retain direct scrolling while exposing a partial-card cue,
contextual direction controls, and list-level boundary keys. Both wide side
panels use named 280–420 px separators, versioned local preferences, and a
joint width budget that preserves at least 416 px for the main pane. Separator
central grab targets span 24 × 44 px for precise pointers and 44 × 44 px for
coarse pointers without widening the full-height 8 px gutter. Cancelled and
no-op gestures preserve the complete preference and
layout-priority snapshot under the constrained 1280 px shell. The latest local
candidate passes 222 server tests, 204 Web tests, 126 Mongo-backed integration
tests, the 191-pass three-engine matrix with 10 capability-specific skips, the
reviewed 10-check Chromium visual gate, a 147.5 KiB largest initial route, and
26.7 KiB CSS. The first strict matrix exposed a cross-tab login completion
race: the replacement account was authoritative and private data was isolated,
but a stale login callback left the initiating tab on Login. Navigation now
waits for the authoritative session to match the login result; positive and
negative unit coverage plus all three engines verify that a different viewer
cannot be redirected by the stale result. The 1280, 1440, and 1728
wide baselines were updated only after expected partial-card differences were
reviewed against their previous images. These results extend the local release
evidence but do not replace the remaining staging and physical/manual gates.

The isolated predecessor remediation passed both production builds, 138 server
tests, 136 Web tests, E2E TypeScript, the focused 36-check three-engine listener
matrix, and `git diff --check`. Commit `c51d5a4` contains only the listener
smoke-test change; its subject, path, and patch passed the required case-
insensitive name scan before push. Ubuntu 24.04 release-gate run `31023106131`
completed successfully with 62 browser checks passing directly and one passing
after a retry. That predecessor did not contain the current visual-regression
suite or its platform-scoped snapshots, so it proves the workflow path but not
the current candidate's Linux pixel gate. A current reviewed Linux baseline,
staging, and physical/manual release evidence remain open.

Dependencies: Stage 8.

Tasks:

- Keep every initial route at or below the existing 150 KiB gzip JavaScript
  budget; set and document an approved CSS/font/image budget from the Stage 1
  baseline.
- Keep p75 LCP at or below 2.5 seconds, CLS below 0.1, and INP below 200 ms on
  the documented supported release baseline, with no unexplained regression
  over the pre-redesign evidence.
- Run the complete unit, component, integration when applicable, three-engine
  browser, accessibility, visual, media, and build gates.
- Deploy the exact CI-built artifact to staging; test desktop/tablet/mobile,
  account transitions, playback, Media Session, weak-network/error recovery,
  and rollback without rebuilding.
- Use a dedicated deployment environment or real weighted traffic routing if
  a canary is required. Do not reuse the Playlist flag or a browser-local
  preference as a security or rollout boundary.
- Retain the previous known-good artifact and roll back immediately for player
  restart/time reset, account isolation, keyboard/accessibility blockers,
  320 px overflow, budget failure, or material Web Vital/error regression.
- Update README or operational documentation only when setup, dependencies,
  commands, CSP, asset delivery, telemetry, or deployment actually changes.
- After every stage and release gate is complete, remove the third-party
  product name from plan filenames, design/QA prose, test names, and the final
  commit subject. Keep only neutral wording such as `reference player` where
  source attribution is not legally or operationally required.

Exit gate:

- The approved artifact passes the release matrix and rollback rehearsal, all
  stage statuses are Complete, and this plan file is deleted before handoff.

## Verification commands

Use the narrowest checks during each stage, then run the complete gates before
release.

Focused Web development:

```bash
npm run test --workspace @archtree/finitude-web -- \
  src/app/AppShell.test.tsx \
  src/components/PlayerBar.test.tsx \
  src/components/SeekSlider.test.tsx \
  src/components/ContentComponents.test.tsx \
  src/features/ListenerPages.test.tsx
npm run build:web
npm run test:e2e:chromium
```

Completed implementation:

```bash
npm test
npm run build
CI=1 npm run test:e2e --workspace @archtree/finitude-web -- --update-snapshots=none
git diff --check
```

Also run `npm run test:integration` when the redesign changes authentication
persistence, owner-scoped Playlist/Library projection, account deletion,
content references, or another transactional contract. Run
`npm run test:media-load` against an explicitly authorized staging target when
artwork delivery, streaming, or media-admission behavior changes. Stage the
final deployment artifact only from a clean reviewed candidate commit.

## Acceptance matrix

| Dimension | Required outcome |
| --- | --- |
| Visual | Approved dark hierarchy, token values, geometry, type scale, art crops, states, and motion are consistent across every route. |
| Responsive | The full panes, persistent 72 px rail, delayed right-pane hide, and mobile switch occur at the documented boundaries, with no overlap or two-dimensional page scrolling at any target viewport, 320 CSS px, 200% zoom, portrait, or landscape. |
| Playback | One audio element; current item/source/time/status/queue/modes/volume survive route, shell, overlay, and breakpoint transitions. |
| Product rules | Public/private boundaries, Library completeness, page-item presentation, Playlist ownership/order, Search history, and Recently Played policy are unchanged unless explicitly documented. |
| Accessibility | Visible focus, complete keyboard path, semantic announcements, equivalent controls for gestures, Reduce Motion, forced colors, and zero critical/serious axe findings. |
| Performance | Existing 150 KiB route budget passes; no blocking third-party asset; no animation CLS or redesign-caused long task; documented Web Vital targets pass. |
| Security/privacy | No raw private/account/catalog fields, cache crossover, external unreviewed font/script, or expanded telemetry payload. |
| Rollback | The previous exact artifact can be redeployed without data migration or rebuild. |

## Principal risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Canonical rule conflicts with exact replication | Block Stage 0 until one written fidelity definition is confirmed and documented. |
| Third-party brand, font, or asset dependency | Keep Finitude identity by default; require explicit rights and self-hosted reviewed assets. |
| A still screenshot cannot specify motion | Obtain an approved live/video reference or define and sign off the motion matrix before implementation. |
| Shell rewrite restarts playback | Keep AppShell and player store mounted; add continuity assertions before page migration. |
| Right pane reports the wrong next item under Shuffle/Repeat | Expose effective order from the store; never derive it from canonical queue index in the component. |
| Sidebar private data crosses accounts | Keep query keys viewer-scoped, clear them on account change/logout, validate owner-only DTOs, and test a two-account switch. |
| Playlist artwork causes N+1 detail reads | Add one bounded owner-only summary projection only if artwork is approved. |
| Breakpoints drift across CSS Modules | Centralize breakpoint and shell geometry tokens, then migrate modules stage by stage. |
| Animation or font exceeds the bundle budget | Prefer CSS/Web Animations and the system font stack; measure every stage. |
| Existing in-progress user changes are overwritten | Checkpoint and merge deliberately; never reset, clean, or replace unrelated dirty files. |
| Literal color tests block a legitimate token change | Assert semantic states in behavior tests and move approved pixels to visual baselines. |
| Visual snapshots become noisy or rubber-stamped | Use deterministic local fixtures, one pixel engine, fixed environment, and reviewed snapshot updates only. |

## Expected delivery slices

The stages are intentionally reviewable and reversible:

1. Product decision and measured specification.
2. Tokens, primitives, and shell.
3. Player and wide-screen Now Playing surface.
4. Public discovery routes.
5. Library, Playlist, and account routes.
6. Visual/a11y/performance hardening and controlled release.

After Stages 2–4, player work and public page migration can proceed in parallel
as long as both branches consume the same frozen tokens and do not edit the
shared shell simultaneously. Private surfaces should follow the stabilized
Playlist baseline to avoid merging against moving, untracked implementation.
