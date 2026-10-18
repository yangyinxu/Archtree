# MediaTrack Audio and Video Lifecycle

<!-- @catalog -->
**Contents**

- [Upload](#upload)
- [One active media object](#one-active-media-object)
- [Motion preview](#motion-preview)
- [Delete](#delete)
- [Reconciliation](#reconciliation)
<!-- @end-catalog -->

## Upload

- Legacy API Audio creation: `POST /content/audioTrack` as multipart form data
  with required `audioFile`. Content Manager creates either kind directly from
  one required `mediaFile` field and optional cover art.
- Replace with Audio: `POST /content/audioTrack/:audioTrackId/upload`
- Replace with Video: `POST /content/audioTrack/:audioTrackId/video` with
  multipart field `videoFile`
- Form field for file: `audioFile`
- Large audio uploads are spooled to bounded temporary files and streamed to S3; they are not retained in the Node.js heap.
- Upload requests require `Content-Length` and are concurrency limited; account-owned avatar mutations are additionally rate limited, and temporary files are removed on completion or disconnect.
- Canonical playback: `HEAD`/`GET
  /content/mediaTrack/stream/:mediaTrackId` supports bounded single-range
  responses for either kind and cancels the upstream S3 request when the client
  disconnects.
- The legacy `/content/audioTrack/stream/:audioTrackId` alias serves Audio
  MediaTracks only. The prototype `/content/audioTrack/video/:audioTrackId`
  route remains a temporary Video-only compatibility alias.
- Legacy audio download routes redirect to the streaming endpoint and no longer buffer whole objects in server memory.
- Authorization required; admin enforced before multipart parsing or upload work
- New MediaTracks are saved with `uploadStatus: pending` and
  `publicationStatus: pending` before S3 upload. Storage may become ready first;
  public/reference readiness is committed only when publication and the
  Album's canonical `audioTrackIds` relationship succeed in one transaction
  (or a no-Album publication condition succeeds). Legacy rows without the new
  publication field remain readable.
- Assigning or clearing a MediaTrack Album relationship transactionally removes
  that MediaTrack from every prior Album `audioTrackIds` list, updates
  `audioTrack.albumId`, and adds it to the requested Album when present. An
  empty canonical list uses reverse-link fallback only for a truly legacy Album
  whose `lifecycleStatus` field is absent; lifecycle Albums treat even an empty
  `audioTrackIds` list as authoritative.
- S3 objects include track ID, owner ID, and encoded original filename metadata.
- Failed or interrupted uploads remain identifiable in MongoDB and can be retried against the same track.
- After a successful Replace with Audio or Replace with Video upload (API or
  Content Manager), the server reruns the idempotent publication retry for that
  MediaTrack, so a row whose earlier publication failed is published without a
  separate audit retry. If publication still cannot commit (for example, its
  Album is not ready or its explicit publication state is invalid), the new
  object stays active with `uploadStatus: ready`; the API answers 409 (503 when
  the outcome is unknown) with `publicationStatus`, `publicationOutcome`, and
  `publicationRetryRequired`, and the retry needs no new upload.
- Content Manager bulk-upload JSON responses include one `outcomes` row per
  selected file with its recoverable `audioTrackId` when a record was created,
  plus separate `uploadStatus`, `publicationStatus`, `cleanupPending`, and
  bounded `error` fields. The browser result panel preserves and displays those
  per-item lifecycle outcomes after navigation. A publication failure does not
  require re-uploading the successful storage object.

## One active media object

- Only parsed MP4 containing H.264/AVC video and AAC audio is accepted. Uploads
  require `Content-Length`, use the shared bounded disk spool, and default to
  `MAX_VIDEO_UPLOAD_MB=512`.
- A MediaTrack has exactly one externally playable object and records its
  `mediaType` as `audio` or `video`. It never exposes both representations. A
  Video's optional motion preview (below) is decoration, not a representation.
- Replacement reserves and uploads a kind-bound pending key, atomically makes
  that object active, retains the former key and kind as cleanup evidence, and
  only then deletes the former S3 object. A failed replacement leaves the
  current object playable.
- Deleting only the Video is rejected because a MediaTrack may not have zero
  active objects. Replace it with Audio, or delete the entire MediaTrack.
- Rows from the superseded optional-video prototype are migration evidence;
  their objects stay traceable until the unified lifecycle safely promotes one
  object and confirms cleanup of the other.

## Motion preview

A Video MediaTrack may carry one muted hover preview for Finitude Web, behind
`FINITUDE_MOTION_PREVIEWS_ENABLED` (default `false`). Its record is the embedded
`motionPreview` state (`active`, `pending`, `cleanup`, `revision`), and its
objects live under `motion-preview/<trackId>/<ObjectId>`, a namespace no audio
or video classifier touches.

- Admin-only API (the persisted admin role; no catalog flag):
  `GET|POST|DELETE /api/admin/v1/catalog/audioTrack/:id/motion-preview` and
  `POST …/motion-preview/reconcile`. `GET` returns eligibility, an opaque
  `sourceToken`, the current revision, and preview facts, never keys or
  versions. `POST` is multipart: `motionPreviewFile` (at most 4 MiB),
  `sourceToken`, and `expectedRevision`. `DELETE` takes `{"expectedRevision":n}`.
  The editor's Motion preview panel drives all of them. It refuses a clip over
  4 MiB or not MP4 before sending it, names the cause of a failure (a rejected
  file, a change made in another session, another operation still running, or
  needed reconciliation), and keeps its controls disabled until the refreshed
  status arrives.
- Validation reads the actual bytes: a progressive MP4 (moov before mdat, no
  fragments or protection) with exactly one H.264 (`avc1`/`avc3`) video track
  and no sound track, at most 8.5 s. Its single sample entry's coded size must
  be within 854 × 480 like the track header's display size (they may differ for
  non-square pixels), and its `avcC` must declare Baseline, Main, or
  High with matching SPS profiles (a High record's 4:2:0 8-bit extension when
  present). A bounded FFmpeg decode of the video stream follows (one at a time,
  32 MiB allocations, frames capped at 442,368 pixels with SPS cropping
  ignored, 20 s deadline), so a 720p or larger stream fails whatever its headers
  claim. Only
  explicit Video rows (`mediaType: "video"`) are eligible; a legacy prototype
  row becomes eligible after its next replacement. A request for a missing or
  ineligible track, another Video, or an older revision is refused before the
  decode, so it never holds the decoder.
- Upload reserves a 10-minute leased pending record, writes a never-reused key
  with `If-None-Match: *`, records the exact version, then promotes it in one
  compare-and-set bound to the active Video key. The previous preview stays
  public until promotion and is then deleted by exact version; a failed delete
  keeps it as `cleanup` evidence. A failed step fences the pending record
  before deleting its own object, so a promote whose acknowledgement was lost
  is never deleted while it may be live. An unknown write outcome is resolved
  later by HEAD on that key (metadata must name the MediaTrack), the record is
  fenced with the identified version, and that exact version is deleted; a
  bucket without versioning addresses it as the `null` version. Object
  metadata `ownerid` names the MediaTrack's shared provenance; the preview's
  `updatedBy` records the uploading administrator and is not provenance.
- Replacing the Video retires a preview made for the old source after the new
  source is active (best effort; the public gate already hides it). Deleting
  the MediaTrack waits for a live preview upload, resolves an expired unknown
  outcome by the same HEAD rule (refusing with 503 only when the object cannot
  be identified), and deletes every recorded preview object by version,
  whatever the rollout flags. Preview writes never land once deletion begins.
- Public delivery: `HEAD|GET /content/mediaTrack/motion-preview/:id`, with an
  optional `?revision=pv_…`. It serves only a ready, published, visible Video
  whose preview is bound to the current active key, matches the recorded
  strong ETag, length, and version, answers `If-None-Match` with 304 without
  storage I/O, re-authorizes while streaming, and returns a bare 404
  otherwise. Responses are `private, no-cache`. The admission class
  `motionPreview` never queues and never uses the playback reserve.
- `GET /api/listener/v1/presentation-capabilities` returns
  `{"contractVersion":1,"motionPreviews":boolean}` so the Web card chooses the
  dedicated clip, or the public stream while previews are disabled. If the
  card cannot read it, it shows no preview and does not ask again on every
  hover.

## Delete

- API: `DELETE /content/audioTrack/:audioTrackId`
- Web: content manager delete action
- MediaTrack metadata is retained until every matching active, pending,
  cleanup, legacy migration, and motion preview object has been deleted.
- Failed deletions remain marked as `deleteFailed` for reconciliation.

## Reconciliation

- Admin-only report: `GET /admin/audio-storage/reconciliation`
- Admin-only exact-orphan deletion: `POST /admin/audio-storage/orphan-delete`
  with `{"s3Key":"audio/..."}` or the audit-page form. It re-runs
  reconciliation, rejects any raw MediaTrack lifecycle reference, deletes only
  the exact confirmed orphan, and verifies that S3 no longer reports it.
- The same report includes a `videoStorage` section for `video/` objects,
  missing lifecycle keys, incomplete operations, invalid keys, and duplicates.
  `POST /admin/video-storage/orphan-delete` rechecks all nested active, pending,
  and cleanup references before deleting one exact report-confirmed orphan.
- The report's `motionPreviewStorage` section lists `motion-preview/` objects,
  orphaned and missing objects, incomplete (pending or cleanup) and stale
  previews (each with a `reason`: `trackNotReady`, `notVideo`, or
  `sourceReplaced`), invalid keys, and duplicates. A `deleting` or
  `deleteFailed` MediaTrack is never stale preview work, and its missing or
  incomplete evidence is marked `deletionOwned`: its deletion removes every
  preview object, so the audit page sends it to a deletion retry. The section
  is report-only; the audit page lists every item and links any other item to
  the MediaTrack's Finitude Web Motion preview panel, whose Reconcile action
  recovers it.
- Admin-only MongoDB-only MediaTrack deletion:
  `POST /admin/audio-storage/missing-track-delete` with `audioTrackId` and
  `expectedS3Key`. It re-runs reconciliation, rejects stale storage identity,
  and uses the normal MediaTrack deletion lifecycle so catalog references are
  cleaned and partial failures retain retryable database evidence.
- Admin-only publication retry: `POST /admin/audio-storage/publication-retry`
  with `{"audioTrackIds":["..."]}` (1–100 items). It reuses existing
  database-confirmed ready Audio or Video objects whose key matches the
  MediaTrack's recorded `mediaType` namespace, isolates every item, and returns
  stable outcomes for ready, non-ready, missing, malformed, and duplicate IDs
  without stopping the rest of the batch.
- Browser requests receive a readable audit page with lifecycle-specific
  recommendations and individually confirmed actions; append `?format=json`
  for the structured report.
- Compares every `audioTracks` record against the objects in `S3_BUCKET_NAME`.
- Reports orphaned S3 objects, database tracks with missing objects, and
  pending/failed storage or publication lifecycle records. Incomplete rows
  include `publicationStatus`, `publicationUpdatedAt`, and bounded
  `publicationError` evidence. Their active, pending, and cleanup object
  existence is checked against the S3 listing for that phase's recorded media
  kind (Audio: legacy root and `audio/` keys; Video: `video/` keys).
- Generating the report is read-only; it never deletes S3 objects
  automatically. Remediation requires a separate explicit administrator POST.
- Admin-only image report: `GET /admin/image-storage/reconciliation`
- The image report audits the `images/` namespace against `imageAssets`, including orphaned, detached, missing, pending, and failed image records.
- New cover art and avatars record the PUT ETag and VersionId (including the
  explicit null version). Reads and cleanup address those exact versions;
  cleanup never treats a key-only delete marker as proof that bytes were
  erased. Unknown uploads or legacy records without a confirmed version keep
  their database evidence and report pending reconciliation.
- Image version recovery uses an administrator checkout with the normal
  private database/S3 configuration. Inspect one image without changing it:
  `npx --no-install tsx scripts/reconcile-image-versions.ts --image-id=<24-hex-id>`.
  The command inventories the exact key with `ListObjectVersions`, checks each
  version's ownership metadata with HEAD, and accepts at most 100 versions and
  delete markers. Missing/mismatched ownership, incomplete inventory, or
  concurrent lifecycle changes fail closed.
- To record that inventory, first stop all upload workers, then run
  `npx --no-install tsx scripts/reconcile-image-versions.ts --image-id=<24-hex-id> --apply --confirm=UPLOAD_WORKERS_STOPPED`.
  Apply conditionally updates only that image lifecycle row; it does not delete
  S3 data. Then retry the existing avatar deletion or cover-art cleanup path.
  This requires explicit authorization for the target environment. Deployment
  bundles exclude repository scripts, so run it from the administrator checkout.
- Before deploying version-aware image handling, grant `s3:GetObjectVersion`
  and `s3:DeleteObjectVersion` for image/avatar objects, including explicit null
  versions, alongside existing object permissions. The recovery operator also
  needs bucket-level `s3:ListBucketVersions`. Keep old upload workers stopped
  throughout an applied version reconciliation.
- Admin-only content-reference report: `GET /admin/content-references/reconciliation`
- The content-reference report detects dangling saved/activity references,
  Page-to-Carousel and Page-to-Grid/List references (including presentation
  mismatches), manual carousel (Album, MediaTrack, and Feed Post) and Grid/List
  items, artist-album links,
  album-track links, and track-album links, plus both directions of
  Album/MediaTrack mismatch (a stale canonical membership or a published
  reverse Track link missing from a lifecycle Album's canonical order);
  dangling Playlist items and missing owners; invalid Playlist mutation receipt
  ownership/targets; and stalled MediaTrack reference cleanup without mutating
  data. Page target deletion and detachment are atomic, and each reconciliation
  source scan and embedded finding remains bounded by the two limits above.
- Credit defects appear in `catalogCreditFindings`; checks without enough
  evidence appear separately in `catalogCreditUnverified` and set `truncated`.
  Budget exhaustion never establishes a missing subject or projection mismatch.
  `catalogDeletionFindings` reports failed/expired Artist or Album deletion
  receipts, including work whose owner is already gone. Retry the existing
  administrator deletion endpoint; generating the report never performs cleanup.
