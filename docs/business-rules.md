# Archtree Business Rules

This document is the shared product-behavior reference for the Archtree backend
and Finitude iOS client. Update it whenever an agreed business rule changes.

## Saved Content and Library

- Users can save and unsave albums and audio tracks.
- "Soundtrack" in product language maps to the backend `audioTrack` type.
- Saved-content state is not limited to 20 items. The 20-item limits apply only
  to the recent-activity lists described below.
- Unsaving content removes it from Recently Saved immediately.
- The iOS Library tab renders the carousels configured on the Library page.
- If no Library carousels are configured, the app shows an empty state.
- The Save control remains visible while signed out and uses disabled styling.
  Tapping it shows a sign-in-required error alert; it does not open login
  automatically.

## Personalized Carousels

- Personalized carousels have one of two sources:
  - Recently Saved
  - Recently Played
- Albums and audio tracks are mixed in both carousel sources.
- Content Manager does not offer album-only or audio-track-only filters for
  personalized carousels.
- Content Manager configures only the carousel name, source, and item limit.
- Personalized carousel items cannot be manually added, removed, reordered, or
  moved between carousels.
- Activity is stored by appending new entries to the end of its history, while
  carousels display the newest activity first.

## Recent-Activity Limits

- Each user has one Recently Saved history with at most 20 entries total across
  albums and audio tracks.
- Each user has one Recently Played history with at most 20 entries total across
  albums and audio tracks.
- Adding a 21st entry removes the oldest entry from that history.
- Repeating an activity for an existing item moves it to the newest position
  instead of creating a duplicate.
- Content that falls out of Recently Saved remains saved and can be exposed by
  a future complete Saved Library view.

## Album and Audio-Track Playback

- An album detail page has one prominent Play button above its audio-track list,
  styled consistently with the existing Play Video button.
- Tapping the album Play button starts the album queue and adds only the album
  to Recently Played.
- Starting on a different song, using Next or Previous, and automatic queue
  advancement inside that album queue do not add audio tracks to Recently
  Played and do not add the album again.
- Playing an audio track outside an album queue adds that audio track to
  Recently Played.
- The album Play action consumes one entry in the shared 20-entry Recently
  Played history.

## Authentication and Resolution

- Saved content and recent activity belong to the authenticated viewer.
- The same personalized carousel definition resolves differently for each user.
- A signed-out viewer receives no personalized carousel items.
- Backend requests validate that referenced albums and audio tracks exist and
  match the declared content type.
- Deleted content is removed from saved and recent-activity references and is
  also omitted defensively during carousel resolution.

## Database and S3 Lifecycle

- Database and S3 mutations must not silently create orphaned records, objects,
  or cross-content references.
- Every S3 object owned by Archtree must remain traceable to a database lifecycle
  record containing its owner, object key, and current status.
- Creating content with an S3 asset records a recoverable pending database state
  before upload. It becomes ready only after the upload succeeds.
- If an upload succeeds but the final database update fails, the service must
  either remove the uploaded object or preserve enough lifecycle metadata for
  reconciliation.
- Replacing an asset uploads and attaches the replacement before deleting the
  previous object. A failed cleanup remains explicitly identifiable.
- Deleting content removes its owned S3 objects before removing the final
  database metadata. If S3 deletion fails, retain the database record with a
  failed-deletion state so the operation can be retried or reconciled.
- Database references to deleted content, including album, artist, carousel,
  saved-content, and recent-activity references, must be cleaned up
  idempotently.
- Shared assets or references must not be deleted merely because one referencing
  record is removed.
- Batch operations report success or failure for each item and retain
  recoverable state for partially completed items.
- Reconciliation reports detect orphaned S3 objects, missing S3 objects,
  dangling database references, and incomplete lifecycle states. Audits do not
  automatically delete unknown data.
