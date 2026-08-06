import { formatStorageSize } from '../../services/s3StorageService';
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

export const renderAudioStorageAuditPage = (report: any, userEmail: string) => {
    const orphanedObjects = Array.isArray(report.orphanedObjects) ? report.orphanedObjects : [];
    const missingObjects = Array.isArray(report.missingObjects) ? report.missingObjects : [];
    const incompleteTracks = Array.isArray(report.incompleteTracks) ? report.incompleteTracks : [];

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Audio Storage Audit - Archtree</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
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
      </li>`)}
    </section>

    <div class="section-heading"><div><p class="eyebrow">MongoDB only</p><h2>Missing S3 objects</h2></div></div>
    <section class="card">
      ${renderItems(missingObjects, (track) => `<li>
        <strong>${escapeHtml(String(track.originalFileName || track.title || 'Unnamed track'))}</strong>
        <div class="item-meta">
          <span>Track ID: <code>${escapeHtml(String(track.audioTrackId ?? ''))}</code></span>
          <span>Upload: ${escapeHtml(String(track.uploadStatus ?? 'legacy'))}</span>
          <span>Publication: ${escapeHtml(String(track.publicationStatus ?? 'legacy'))}</span>
          ${track.uploadError ? `<span class="status-error">${escapeHtml(String(track.uploadError))}</span>` : ''}
          ${track.publicationError ? `<span class="status-error">${escapeHtml(String(track.publicationError))}</span>` : ''}
        </div>
      </li>`)}
    </section>

    <div class="section-heading"><div><p class="eyebrow">Needs attention</p><h2>Incomplete operations</h2></div></div>
    <section class="card">
      ${renderItems(incompleteTracks, (track) => `<li>
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
      </li>`)}
    </section>
  </main>
</body>
</html>`;
};
