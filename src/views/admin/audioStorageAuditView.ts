import { formatStorageSize } from '../../services/s3StorageService';
import { isAudioObjectKeyForTrack } from '../../utils/audioStorageKey';
import { escapeHtml } from '../html';

const formatDate = (value: unknown) => {
    if (!value) return 'Unknown';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
};

const renderItems = (items: any[], renderItem: (item: any) => string) => {
    return items.length > 0
        ? `<ul class="item-list">${items.map(renderItem).join('')}</ul>`
        : '<p class="empty-state">No issues found.</p>';
};

const soundtrackWorkspaceUrl = (audioTrackId: unknown) =>
    `/content/manage?view=catalog&prefillType=audioTrack&prefillId=${encodeURIComponent(String(audioTrackId ?? ''))}#audio-track-update-card`;

/** Renders the read-only audit with explicit state-valid remediation choices. */
export const renderAudioStorageAuditPage = (
    report: any,
    userEmail: string,
    message: string = '',
    messageIsError: boolean = false
) => {
    const orphanedObjects = Array.isArray(report.orphanedObjects) ? report.orphanedObjects : [];
    const missingObjects = Array.isArray(report.missingObjects) ? report.missingObjects : [];
    const incompleteTracks = Array.isArray(report.incompleteTracks) ? report.incompleteTracks : [];
    const videoStorage = report.videoStorage ?? {};
    const orphanedVideos = Array.isArray(videoStorage.orphanedObjects)
        ? videoStorage.orphanedObjects
        : [];
    const missingVideos = Array.isArray(videoStorage.missingObjects)
        ? videoStorage.missingObjects
        : [];
    const incompleteVideos = Array.isArray(videoStorage.incompleteTracks)
        ? videoStorage.incompleteTracks
        : [];

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Audio Storage Audit - Archtree</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <style>
    .audit-guide { display: grid; gap: 10px; }
    .audit-guide p { margin: 0; }
    .remediation { border-top: 1px solid var(--line); display: grid; gap: 10px; margin-top: 12px; padding-top: 12px; }
    .remediation p, .remediation form { margin: 0; }
    .remediation-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 9px; }
    .item-list > li { display: grid; gap: 8px; }
  </style>
</head>
<body>
  <main class="page-shell">
    <header class="site-header">
      <div>
        <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">A</span><span>Archtree</span></a>
        <p class="eyebrow" style="margin-top:18px;">Administrator tools</p>
        <h1 style="margin-bottom:8px;">Audio Storage Audit</h1>
        <p class="muted">Signed in as <strong>${escapeHtml(userEmail)}</strong> · Generated ${escapeHtml(formatDate(report.generatedAt))}</p>
      </div>
      <div class="header-actions">
        <a class="button" href="/content/manage">Content Manager</a>
        <a class="button button--secondary" href="/admin/audio-storage/reconciliation?format=json">View JSON</a>
      </div>
    </header>
    ${message ? `<div class="alert${messageIsError ? ' alert--error' : ''}" role="status">${escapeHtml(message)}</div>` : ''}

    <section class="card audit-guide" aria-labelledby="audit-guide-heading">
      <p class="eyebrow">Recommended workflow</p>
      <h2 id="audit-guide-heading">Resolve one exact finding at a time</h2>
      <p><strong>S3 only:</strong> delete the object only after the server reconfirms that no MediaTrack lifecycle record references its key.</p>
      <p><strong>MongoDB only:</strong> S3 is already missing. Re-upload the original file if the MediaTrack should remain, or delete the record through the guarded MediaTrack lifecycle below.</p>
      <p><strong>Needs attention:</strong> retry publication only when the stored file is ready; otherwise inspect the MediaTrack and its recorded error first.</p>
    </section>

    <section class="grid">
      <div class="card"><p class="eyebrow">MongoDB</p><h2>${Number(report.summary?.databaseTrackCount ?? 0)}</h2><p>Track records</p></div>
      <div class="card"><p class="eyebrow">S3</p><h2>${Number(report.summary?.s3ObjectCount ?? 0)}</h2><p>Objects in ${escapeHtml(String(report.bucket ?? ''))}</p></div>
      <div class="card"><p class="eyebrow">Orphaned</p><h2>${Number(report.summary?.orphanedObjectCount ?? 0)}</h2><p>S3 objects without tracks</p></div>
      <div class="card"><p class="eyebrow">Missing</p><h2>${Number(report.summary?.missingObjectCount ?? 0)}</h2><p>Tracks without S3 objects</p></div>
      <div class="card"><p class="eyebrow">Incomplete</p><h2>${Number(report.summary?.incompleteTrackCount ?? 0)}</h2><p>Pending or failed operations</p></div>
    </section>

    <div class="section-heading"><div><p class="eyebrow">S3 only</p><h2>Orphaned objects</h2></div></div>
    <section class="card">
      ${renderItems(orphanedObjects, (object) => `<li>
        <strong>${escapeHtml(String(object.originalFileName || 'Filename unavailable'))}</strong>
        <div class="item-meta">
          <span>S3 key: <code>${escapeHtml(String(object.key ?? ''))}</code></span>
          <span>${escapeHtml(formatStorageSize(Number(object.size ?? 0)))}</span>
          <span>Last modified: ${escapeHtml(formatDate(object.lastModified))}</span>
          ${object.ownerId ? `<span>Owner ID: <code>${escapeHtml(String(object.ownerId))}</code></span>` : ''}
          ${object.metadataError ? `<span class="status-error">Metadata error: ${escapeHtml(String(object.metadataError))}</span>` : ''}
        </div>
        <div class="remediation">
          <p><strong>Recommended:</strong> delete this exact orphan if it is not an intentionally retained backup. It has no valid MediaTrack lifecycle owner and cannot be played.</p>
          <form method="POST" action="/admin/audio-storage/orphan-delete">
            <input type="hidden" name="s3Key" value="${escapeHtml(String(object.key ?? ''))}" />
            <button type="submit" data-danger data-confirm="Delete this exact orphaned S3 object? The server will recheck it before deletion.">Delete orphaned S3 object</button>
          </form>
        </div>
      </li>`)}
    </section>

    <div class="section-heading"><div><p class="eyebrow">MongoDB only</p><h2>Missing S3 objects</h2></div></div>
    <section class="card">
      ${renderItems(missingObjects, (track) => {
          const audioTrackId = String(track.audioTrackId ?? '');
          const expectedS3Key = String(track.s3Key ?? '');
          const canDeleteRecord = isAudioObjectKeyForTrack(expectedS3Key, audioTrackId);
          return `<li>
        <strong>${escapeHtml(String(track.originalFileName || track.title || 'Unnamed track'))}</strong>
        <div class="item-meta">
          <span>Track ID: <code>${escapeHtml(String(track.audioTrackId ?? ''))}</code></span>
          <span>Upload: ${escapeHtml(String(track.uploadStatus ?? 'legacy'))}</span>
          <span>Publication: ${escapeHtml(String(track.publicationStatus ?? 'legacy'))}</span>
          ${track.uploadError ? `<span class="status-error">${escapeHtml(String(track.uploadError))}</span>` : ''}
          ${track.publicationError ? `<span class="status-error">${escapeHtml(String(track.publicationError))}</span>` : ''}
        </div>
        <div class="remediation">
          <p><strong>Recommended:</strong> S3 is already missing. Upload the original file again if this MediaTrack should remain; otherwise delete its MongoDB record and all catalog references through the guarded lifecycle.</p>
          <div class="remediation-actions">
            <a class="button button--secondary" href="${soundtrackWorkspaceUrl(audioTrackId)}">Open MediaTrack workspace</a>
            ${canDeleteRecord ? `<form method="POST" action="/admin/audio-storage/missing-track-delete">
              <input type="hidden" name="audioTrackId" value="${escapeHtml(audioTrackId)}" />
              <input type="hidden" name="expectedS3Key" value="${escapeHtml(expectedS3Key)}" />
              <button type="submit" data-danger data-confirm="Delete this MongoDB MediaTrack record and clean every catalog reference? The server will reconfirm that its S3 object is still missing.">Delete MongoDB record</button>
            </form>` : '<span class="status-error">Stored S3 identity is invalid; inspect this MediaTrack before deletion.</span>'}
          </div>
        </div>
      </li>`;
      })}
    </section>

    <div class="section-heading"><div><p class="eyebrow">Needs attention</p><h2>Incomplete operations</h2></div></div>
    <section class="card">
      ${renderItems(incompleteTracks, (track) => {
          const canRetryPublication = track.objectExists
              && track.uploadStatus === 'ready'
              && track.publicationStatus !== 'ready'
              && track.publicationStatus !== 'legacy';
          const recommendation = canRetryPublication
              ? 'The stored file is ready. Retry publication without uploading it again.'
              : track.objectExists
                  ? 'Inspect the recorded lifecycle error before retrying or deleting this MediaTrack.'
                  : 'The expected file is missing. Open the MediaTrack to upload a replacement or remove the record safely.';
          return `<li>
        <strong>${escapeHtml(String(track.originalFileName || track.title || 'Unnamed track'))}</strong>
        <div class="item-meta">
          <span>Track ID: <code>${escapeHtml(String(track.audioTrackId ?? ''))}</code></span>
          <span>Upload: ${escapeHtml(String(track.uploadStatus ?? 'unknown'))}</span>
          <span>S3 object: ${track.objectExists ? 'Present' : 'Missing'}</span>
          <span>Upload updated: ${escapeHtml(formatDate(track.uploadUpdatedAt))}</span>
          <span>Publication: ${escapeHtml(String(track.publicationStatus ?? 'legacy'))}</span>
          <span>Publication updated: ${escapeHtml(formatDate(track.publicationUpdatedAt))}</span>
          ${track.uploadError ? `<span class="status-error">${escapeHtml(String(track.uploadError))}</span>` : ''}
          ${track.publicationError ? `<span class="status-error">${escapeHtml(String(track.publicationError))}</span>` : ''}
        </div>
        <div class="remediation">
          <p><strong>Recommended:</strong> ${escapeHtml(recommendation)}</p>
          <div class="remediation-actions">
            ${canRetryPublication ? `<form method="POST" action="/admin/audio-storage/publication-retry"><input type="hidden" name="audioTrackIds" value="${escapeHtml(String(track.audioTrackId ?? ''))}" /><button type="submit">Retry publication</button></form>` : ''}
            <a class="button button--secondary" href="${soundtrackWorkspaceUrl(track.audioTrackId)}">Open MediaTrack workspace</a>
          </div>
        </div>
      </li>`;
      })}
    </section>

    <div class="section-heading"><div><p class="eyebrow">Media namespace</p><h2>Video storage</h2></div></div>
    <section class="grid">
      <div class="card"><p class="eyebrow">MongoDB</p><h2>${Number(videoStorage.summary?.databaseVideoTrackCount ?? 0)}</h2><p>MediaTracks with Video evidence</p></div>
      <div class="card"><p class="eyebrow">S3</p><h2>${Number(videoStorage.summary?.s3ObjectCount ?? 0)}</h2><p>Objects under <code>video/</code></p></div>
      <div class="card"><p class="eyebrow">Orphaned</p><h2>${Number(videoStorage.summary?.orphanedObjectCount ?? 0)}</h2><p>Unreferenced video objects</p></div>
      <div class="card"><p class="eyebrow">Missing</p><h2>${Number(videoStorage.summary?.missingObjectCount ?? 0)}</h2><p>Recorded keys absent from S3</p></div>
      <div class="card"><p class="eyebrow">Incomplete</p><h2>${Number(videoStorage.summary?.incompleteTrackCount ?? 0)}</h2><p>Pending video lifecycles</p></div>
    </section>

    <section class="card" aria-labelledby="video-orphans-heading">
      <h3 id="video-orphans-heading">Orphaned video objects</h3>
      ${renderItems(orphanedVideos, (object) => `<li>
        <strong>${escapeHtml(String(object.originalFileName || object.key || 'Unnamed video object'))}</strong>
        <div class="item-meta"><span>S3 key: <code>${escapeHtml(String(object.key ?? ''))}</code></span><span>${escapeHtml(formatStorageSize(Number(object.size ?? 0)))}</span></div>
        <form method="POST" action="/admin/video-storage/orphan-delete">
          <input type="hidden" name="s3Key" value="${escapeHtml(String(object.key ?? ''))}" />
          <button type="submit" data-danger data-confirm="Delete this exact orphaned video object? The server will recheck every MediaTrack reference first.">Delete orphaned video object</button>
        </form>
      </li>`)}
    </section>

    <section class="card" aria-labelledby="video-missing-heading">
      <h3 id="video-missing-heading">Missing video objects</h3>
      ${renderItems(missingVideos, (reference) => `<li>
        <strong>MediaTrack ${escapeHtml(String(reference.audioTrackId ?? ''))}</strong>
        <div class="item-meta"><span>Phase: ${escapeHtml(String(reference.phase ?? 'unknown'))}</span><span>Key: <code>${escapeHtml(String(reference.s3Key ?? ''))}</code></span></div>
        <a class="button button--secondary" href="${soundtrackWorkspaceUrl(reference.audioTrackId)}">Open MediaTrack workspace</a>
      </li>`)}
    </section>

    <section class="card" aria-labelledby="video-incomplete-heading">
      <h3 id="video-incomplete-heading">Incomplete video operations</h3>
      ${renderItems(incompleteVideos, (track) => `<li>
        <strong>${escapeHtml(String(track.title || track.audioTrackId || 'Unnamed MediaTrack'))}</strong>
        <div class="item-meta">${(Array.isArray(track.references) ? track.references : []).map((reference: any) => `<span>${escapeHtml(String(reference.phase ?? 'phase'))}: ${escapeHtml(String(reference.status ?? 'unknown'))} · ${reference.objectExists ? 'S3 present' : 'S3 missing'}</span>`).join('')}</div>
        <a class="button button--secondary" href="${soundtrackWorkspaceUrl(track.audioTrackId)}">Open MediaTrack workspace</a>
      </li>`)}
    </section>
  </main>
  <script src="/assets/audio-storage-audit.js"></script>
</body>
</html>`;
};
