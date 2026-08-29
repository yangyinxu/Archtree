# Finitude Cross-Platform Figma Plan

## Stage 1: Establish the target file and inventory

Status: Complete

- Create the Finitude cross-platform Figma design file.
- Inventory the implemented Web, iOS, and Android screens, shared components,
  assets, typography, and semantic presentation tokens.
- Preserve the documented product behavior and platform-specific presentation
  boundaries while identifying reusable cross-platform concepts.

## Stage 2: Build shared foundations and components

Status: Blocked

- Create semantic color, typography, spacing, radius, and state foundations.
- Model supported light and dark modes without replacing platform-native
  semantics with a single pixel-identical theme.
- Build reusable Finitude components before composing screens from instances.

Blocker: the authenticated Figma team is on the Starter tier with a View seat.
The MCP tool-call allowance was exhausted while creating the second batch of
Web semantic colors. The failed batch was atomic and created no partial Figma
objects. Further Figma writes require the allowance to reset or the plan/seat
to be upgraded. Starter also limits local variable collections to one mode, so
proper Light/Dark local modes require an upgraded plan; separate single-mode
collections remain a possible fallback after explicit approval.

### Locked Phase 0 discovery scope

- Target Figma file: `Finitude Cross-Platform Design`
  (`ofTq2SU8dVWfPNJqqB0PeV`).
- Existing file state: one empty default page; no local variables, styles, or
  components.
- Web sources: all 35 semantic color tokens, 31 underlying raw color values,
  eight spacing tokens, four radius tokens, eight type roles, and eleven
  effect-style shadows from `web/src/styles/tokens.css`.
- Android sources: the six Finitude fallback palette values and the Material 3
  Light/Dark semantic roles used by `FinitudeTheme`; dynamic color remains a
  runtime behavior rather than a fixed design value.
- iOS sources: Apple semantic colors, SF Pro text styles, SF Symbols, native
  navigation, and the Finitude ambient gradient treatment in the current
  SwiftUI implementation.
- First component set: Artwork/Placeholder, Content Card, Section Header,
  Content Carousel, Empty/Unavailable State, and the platform navigation/player
  chrome needed to compose Home. Custom components retain Web, iOS, and Android
  platform variants rather than forcing pixel identity.
- First screen set: loaded, loading, and unavailable Home for Web desktop,
  iPhone, and Android phone, followed by the remaining implemented screens in
  Stage 4.
- Reuse decisions: use the Apple iOS and iPadOS 26 library for iOS system
  chrome and the Material 3 Design Kit for Compose controls; rebuild Finitude
  Web components from code tokens because the generic Simple Design System does
  not match the Web presentation contract.
- Code Connect state: none of the three repositories currently contains Code
  Connect mappings; add mappings only for project-owned custom components.
- Open approval: Figma exposes SF Pro and Roboto but not the Web code's leading
  Helvetica Neue/Helvetica/Arial stack. Exact Web typography requires that font
  to become available; otherwise SF Pro can be used as an explicitly annotated
  editable fallback while the running Web capture remains the visual reference.

## Stage 3: Build and validate representative Home screens

Status: Not started

- Build the current Web Home presentation using the running application as the
  visual reference.
- Build the current iOS Home presentation from SwiftUI structure and native
  iOS conventions.
- Build the current Android Home presentation from Compose structure and
  Material conventions, aligned with the shared product behavior.
- Validate each screen visually and structurally before expanding the library.

## Stage 4: Expand to the remaining implemented screens and states

Status: Not started

- Add the remaining Web, iOS, and Android screens in platform-specific pages.
- Include meaningful loading, empty, unavailable, signed-out, error, download,
  and playback states represented by the current implementations.
- Add cross-platform flow references and Code Connect mappings for custom
  components where they improve long-term synchronization.

## Stage 5: Final verification and handoff

Status: Not started

- Review screen coverage, component reuse, variable bindings, naming, fonts,
  artwork, and platform-specific differences.
- Compare representative Figma renders with current application screenshots.
- Remove this completed plan file before final handoff.
