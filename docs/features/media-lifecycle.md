# MediaTrack Audio and Video Lifecycle

<!-- @catalog -->
**Contents**

- [Upload](#upload)
- [One active media object](#one-active-media-object)
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
  `mediaType` as `audio` or `video`. It never exposes both representations.
- Replacement reserves and uploads a kind-bound pending key, atomically makes
  that object active, retains the former key and kind as cleanup evidence, and
  only then deletes the former S3 object. A failed replacement leaves the
  current object playable.
- Deleting only the Video is rejected because a MediaTrack may not have zero
  active objects. Replace it with Audio, or delete the entire MediaTrack.
- Rows from the superseded optional-video prototype are migration evidence;
  their objects stay traceable until the unified lifecycle safely promotes one
  object and confirms cleanup of the other.

## Delete

- API: `DELETE /content/audioTrack/:audioTrackId`
- Web: content manager delete action
- MediaTrack metadata is retained until every matching active, pending,
  cleanup, and legacy migration object has been deleted.
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
