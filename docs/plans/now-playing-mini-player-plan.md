# Now Playing Mini-Player Plan

## Status

Draft. This document is implementation guidance, not the canonical product
contract. Promote agreed behavior to `../business-rules.md` in the same change
as implementation.

## Objective

Add a persistent Now Playing bar above the app’s tab bar and allow the user to
drag or tap it to expand the full audio player. The mini-player should remain
available while the user browses Home, Library, Settings, and content details.

The feature must use the existing app-wide `AudioManager` playback state. It
must not create a second player, a second queue, or a live editable queue.

This plan applies primarily to the Finitude iOS client. No Archtree API change
is expected unless later product decisions require additional metadata.

## Current state

- `AudioManager` already owns shared transport state, the in-memory album
  playback queue, current item, progress, play/pause state, and Now Playing
  integration.
- The app root injects the shared `AudioManager`; `ContentView` owns the tab
  shell and consumes that shared state.
- `AudioPlayer` is currently presented as a navigation destination and contains
  both playback configuration and the full player UI.
- Playback can continue when the player route is dismissed, and the app can
  restore the player route after returning from the background.
- There is no persistent in-app mini-player between content and the tab bar.

## Product behavior to establish

Before implementation, confirm and record the agreed behavior in
`../business-rules.md`:

1. The mini-player appears whenever `AudioManager.currentQueueItem` exists and
   disappears when playback is stopped or the queue is cleared.
2. The mini-player is available on every primary tab and on nested content
   routes, but is not shown over the expanded player itself.
3. Tapping the mini-player expands the current player without restarting
   playback, changing the current track, or resetting the playback position.
4. Dragging upward expands the player; dragging downward collapses it to the
   mini-player. An upward gesture that does not cross the expansion threshold
   leaves the mini-player in place.
5. Horizontal swipes on the mini-player move to the previous or next item in
   the existing playback queue. A left swipe advances and a right swipe moves
   backward, matching the app’s established Previous/Next semantics.
6. Horizontal swipes respect queue boundaries and do nothing when no item is
   available in the requested direction. They must not create additional
   Recently Played entries.
7. The mini-player’s visible buttons are play/pause and audio output. The bar
   itself is the expand control; Previous and Next remain available through
   horizontal swipes and VoiceOver custom actions rather than extra buttons.
8. The mini-player includes an audio-output button that opens the system route
   picker. It allows the user to choose the routes iOS exposes, including
   compatible AirPlay outputs and already available Bluetooth devices, or
   return playback to the iPhone.
9. Device discovery and routing are delegated to iOS. The app does not build a
   custom device list, request unnecessary local-network permissions, or send
   audio through a separate playback engine.
10. The expanded player continues to use the existing queue, Previous, Next,
   seeking, system controls, and background playback behavior.
11. Dismissing or collapsing the expanded player does not stop playback.
12. If no current item is available, the app does not show an empty or stale
   mini-player.

The first release should not include queue editing, “Play next,” “Add to
queue,” queue reordering, or a persistent Up Next screen.

The output button is not a Spotify Connect-style remote playback system. It
does not discover another signed-in phone or transfer the queue to a Finitude
process running on another device. That would require a separate backend,
device-presence, authorization, and queue-handoff design.

## Proposed user experience

### Mini-player

- Place a compact bar immediately above the tab bar so it is visible while
  browsing but does not cover the tab controls.
- Include cached/current artwork, title, artist or album subtitle, a thin
  progress indicator, a play/pause button, and an audio-output route button.
- Use the system route-picker icon and state so the control reflects the
  currently selected output when possible. The route button should be
  available from both the mini-player and expanded player if space permits.
- If a Bluetooth device must first be paired, allow iOS to direct the user to
  the appropriate system workflow; do not imitate pairing inside Finitude.
- Make the whole bar tappable to expand the player. Keep the play/pause button
  as an independent control so it does not expand the player accidentally.
- Use a prominent drag affordance or allow an upward swipe across the bar.
- Support horizontal swipe navigation across the bar: swipe left for Next and
  swipe right for Previous. Provide subtle haptic or visual feedback only if
  it does not interfere with the compact layout.
- Add bottom content inset to scrollable pages so the last card, row, or button
  is not hidden behind the mini-player.
- Use the current queue item’s artwork and metadata, including the same artwork
  fallback rules used by the full player.

### Expanded player

- Present the full player from the app shell as one native large-detent sheet.
  The first release has two states—mini and expanded—so a medium player detent
  is unnecessary.
- Preserve the current full-player controls and artwork presentation while
  adding an obvious collapse gesture.
- Opening the expanded player for an already-playing item must use
  `resumeCurrentPlayback` semantics and must not call `startQueue` again.
- Keep Save state synchronized with the current soundtrack when Previous or
  Next changes the queue item.
- Preserve the existing playback-origin restoration behavior when returning
  from background or the lock screen.

## Implementation phases

### Phase 1: Separate playback state from player presentation

- Refactor `AudioPlayer` so playback configuration and reusable player content
  are separate from the presentation route.
- Ensure only the originating playback screen starts a new queue. The mini-
  player and expanded player must render the existing `AudioManager` state.
- Introduce an app-level player presentation coordinator with states such as:
  - hidden, when there is no current queue item;
  - mini, when playback exists but the full player is collapsed;
  - expanded, when the full player is visible.
- Define a single source of truth for expanded-player presentation so tab
  navigation, restoration, and user gestures cannot present duplicate players.
- Make expanded presentation independent of tab NavigationPaths. Starting a
  new queue records its origin, while opening or closing the existing player
  changes only presentation state.
- Preserve the existing `AudioManager` dependency injection and test seams.

### Phase 2: Implement the mini-player shell

- Add a reusable `NowPlayingMiniPlayer` SwiftUI view driven by `AudioManager`.
- Add artwork loading with the same placeholder and retry-safe behavior as the
  full player. Prefer locally available artwork when offline downloads exist.
- Add a progress indicator driven by `currentTime` and `totalTime`, guarding
  against zero or invalid durations.
- Add play/pause behavior through `AudioManager.playAudio()` and
  `pauseAudio()`.
- Add a reusable system route-picker bridge using Apple’s route-picker UI and
  place it in the mini-player. Reuse the same route control in the expanded
  player rather than implementing separate device-selection logic.
- Verify `AVAudioSession` category, mode, activation, and existing AirPlay
  options support route changes while preserving background playback.
- Handle route changes and unavailable routes gracefully; the app should show
  the system-selected output state and must not claim that a route connected
  if iOS rejected or lost it.
- Add accessibility labels, values, hints, and identifiers for the current
  item, expand action, play/pause action, output-route action, and progress.
- Add an app-shell placement that keeps the mini-player above the tab bar and
  accounts for safe-area and device-size differences.
- Verify that Home, Library, Settings, nested NavigationStacks, alerts, and
  authentication sheets do not create competing bars or obscure controls.

### Phase 3: Add interactive expansion and collapse

- Implement upward drag and tap-to-expand behavior using a single interactive
  presentation mechanism. Crossing the upward threshold presents the native
  large sheet; dismissing that sheet returns to the mini-player.
- Combine vertical expansion gestures with horizontal queue-navigation
  gestures using directional locking and thresholds. A gesture should resolve
  to one axis rather than partially expanding and changing tracks together.
- Exclude the play/pause and route-picker hit regions from track-swipe gesture
  recognition so operating a button cannot also skip a track.
- Implement downward drag/collapse without stopping, pausing, or restarting
  playback.
- Route horizontal swipes through `AudioManager.moveToNext()` and
  `AudioManager.moveToPrevious()`, preserving the existing queue boundary and
  activity-recording policies.
- Define behavior for rotation, Dynamic Type, Reduce Motion, VoiceOver, and
  interrupted gestures.
- Expose Previous, Next, and Expand as VoiceOver custom actions so gesture-only
  features remain operable without swipe recognition.
- Ensure the expanded player consumes the correct safe area and does not leave
  the tab bar interactable underneath it.
- Treat a matched-artwork or continuously interactive custom transition as
  optional follow-up polish. It must not replace the native sheet until it
  matches dismissal, accessibility, interruption, and rotation behavior.

### Phase 4: Reconcile navigation and lifecycle behavior

- Preserve the canonical restoration rule: returning from background with a
  current Now Playing item selects the recorded origin tab and presents the
  existing player without restarting its queue or position. Implement this by
  setting the app-level player presentation state instead of rebuilding a tab
  NavigationPath.
- When a user opens a track or album from a content page, transition naturally
  from the originating screen to the mini-player after the full player is
  collapsed.
- Ensure opening the expanded player from the mini-player does not record a
  second Recently Played event or change playback origin.
- Keep system Now Playing controls and in-app controls synchronized through
  `AudioManager`.
- Handle queue exhaustion, `stopAudio()`, failed stream loads, and a current
  item whose artwork or metadata cannot be loaded without leaving stale UI.

### Phase 5: Test and document

- Add unit tests for presentation-state transitions, including queue creation,
  queue clearing, current-item changes, collapse, expansion, and restoration.
- Add view-model or component tests for mini-player progress, play/pause,
  artwork fallback, and queue-boundary controls.
- Add UI tests for:
  - Mini-player appears after starting playback.
  - Mini-player remains visible while changing tabs and navigating content.
  - Tapping the bar expands the player without restarting playback.
  - Dragging up expands and dragging down collapses it.
  - Swiping left advances to the next queue item and swiping right moves to the
    previous item when those items exist.
  - Swiping at a queue boundary leaves the current item unchanged.
  - Play/pause and route-picker taps do not trigger horizontal track changes.
  - Collapsing does not pause or stop playback.
  - Stopping playback removes the mini-player.
  - Accessibility actions expose meaningful labels and values.
- Add physical-device checks for background audio, lock-screen controls,
  interruptions, Bluetooth/AirPlay route selection, route loss, rotation,
  Dynamic Type, Reduce Motion, and VoiceOver.
- Update iOS architecture, UI, testing, and release documentation. Add the
  final mini-player behavior to `../business-rules.md` once confirmed.

## Acceptance criteria

- A compact Now Playing bar appears above the tab bar whenever a track is
  active.
- The bar remains available while browsing all primary app sections.
- The user can open the system output picker from the bar and route audio to a
  system-available Bluetooth or AirPlay output, or back to the iPhone.
- The user can tap or drag up to expand the full player and drag down to
  collapse it.
- Expanding and collapsing never restarts playback or changes the queue.
- The existing full-player controls, system media controls, background audio,
  and playback restoration continue to work.
- The mini-player is removed when playback is stopped or no current item
  remains.
- The implementation uses the existing app-wide `AudioManager` and does not
  introduce live queue functionality.
