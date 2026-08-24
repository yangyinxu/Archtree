import { escapeHtml } from '../html';
import type { ManagementInventoryPage } from './inventoryPagination';

type AudioTrackPagination = Omit<ManagementInventoryPage<unknown>, 'items'>;

/** Renders one bounded page of the administrator's global MediaTrack inventory. */
export const renderAudioTracksPage = (
    userId: string,
    userEmail: string,
    tracks: any[],
    pagination: AudioTrackPagination = { page: 1, hasPrevious: false, hasNext: false }
) => {
    const trackItems = tracks.length > 0
        ? tracks.map((track) => {
            const id = String(track._id ?? '');
            const editUrl = `/content/manage?prefillType=audioTrack&prefillId=${encodeURIComponent(id)}#audio-track-update-card`;
            const albumId = String(track.albumId ?? '').trim();
            const originalFileName = String(track.originalFileName ?? '').trim();
            const title = String(track.title ?? 'Untitled Track');
            const uploadStatus = String(track.uploadStatus ?? 'legacy');
            const statusPresentation: Record<string, { label: string; className: string }> = {
                ready: { label: 'File ready', className: '' },
                pending: { label: 'Upload pending', className: 'pill--warning' },
                failed: { label: 'Upload failed', className: 'pill--danger' },
                deleting: { label: 'Deletion pending', className: 'pill--warning' },
                deleteFailed: { label: 'Deletion failed', className: 'pill--danger' },
                legacy: { label: 'Legacy file', className: 'pill--muted' }
            };
            const status = statusPresentation[uploadStatus] ?? statusPresentation.legacy;
            const uploadError = String(track.uploadError ?? '').trim();
            return `<li data-track-item data-search="${escapeHtml(`${title} ${id} ${albumId} ${originalFileName}`.toLowerCase())}" data-status="${escapeHtml(uploadStatus)}" data-album="${albumId ? 'assigned' : 'unassigned'}">
              <div class="track-title-row"><strong>${escapeHtml(title)}</strong><span><span class="pill ${status.className}">${status.label}</span> ${albumId ? '<span class="pill">In album</span>' : '<span class="pill pill--muted">Unassigned</span>'}</span></div>
              <div class="item-meta">
                <button class="copy-id" type="button" data-copy-id="${escapeHtml(id)}"><i class="ph ph-copy" aria-hidden="true"></i>Copy track ID</button>
                ${albumId ? `<button class="copy-id" type="button" data-copy-id="${escapeHtml(albumId)}"><i class="ph ph-copy" aria-hidden="true"></i>Copy album ID</button>` : '<span>No album assigned</span>'}
                ${originalFileName ? `<span>File: ${escapeHtml(originalFileName)}</span>` : ''}
                ${uploadError ? `<span class="status-error">Storage error: ${escapeHtml(uploadError)}</span>` : ''}
              </div>
              <div><a class="button button--secondary" href="${editUrl}">Edit track</a></div>
            </li>`;
        }).join('')
        : '<li class="empty-state">No MediaTracks yet. Create one from the Content Manager.</li>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MediaTracks - Archtree</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <style>
    .track-toolbar { align-items: end; display: grid; gap: 12px; grid-template-columns: minmax(240px, 1fr) minmax(150px, .45fr) minmax(150px, .45fr); margin-bottom: 18px; }
    .track-title-row { align-items: center; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; }
    .pill--muted { color: #58635e; background: #e8ebe7; }
    [data-track-item] { display: grid; gap: 10px; }
    .track-results-summary { align-items: center; display: flex; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .copy-id { min-height: 28px; border-color: var(--line); color: var(--muted); background: transparent; padding: 4px 8px; font-size: 12px; }
    .inventory-pagination { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 18px; }
    .inventory-pagination span { color: var(--muted); font-size: 14px; font-weight: 700; }
    @media (max-width: 600px) { .track-toolbar { align-items: stretch; grid-template-columns: 1fr; } }
  </style>
</head>
<body class="inventory-page">
  <main class="page-shell">
    <header class="site-header operations-header">
      <div class="operations-header__identity">
        <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"><i class="ph ph-tree-structure"></i></span><span>Archtree</span></a>
        <p class="eyebrow" style="margin-top:18px;">Audio library</p>
        <h1 style="margin-bottom:8px;">MediaTracks</h1>
        <p class="muted operations-meta"><span>Global catalog</span><span>Signed in as <strong>${escapeHtml(userEmail)}</strong></span><span>${tracks.length} track${tracks.length === 1 ? '' : 's'} on page ${pagination.page}</span></p>
      </div>
      <div class="header-actions">
        <a class="button" href="/content/manage#create"><i class="ph ph-upload-simple" aria-hidden="true"></i>Create and upload</a>
        <a class="button button--secondary" href="/content/manage"><i class="ph ph-stack" aria-hidden="true"></i>Content Manager</a>
        <form method="POST" action="/auth/logout-web"><input type="hidden" name="viewerId" value="${escapeHtml(userId)}" /><button class="button--secondary" type="submit"><i class="ph ph-sign-out" aria-hidden="true"></i>Log out</button></form>
      </div>
    </header>
    <section class="card card--raised card--workspace">
      <div class="track-toolbar">
        <div>
          <label for="track-filter">Filter tracks</label>
          <input id="track-filter" type="search" placeholder="Search title, ID, album, or filename" />
        </div>
        <div>
          <label for="track-status-filter">Storage status</label>
          <select id="track-status-filter"><option value="">All statuses</option><option value="ready">File ready</option><option value="pending">Upload pending</option><option value="failed">Upload failed</option><option value="deleting">Deletion pending</option><option value="deleteFailed">Deletion failed</option><option value="legacy">Legacy file</option></select>
        </div>
        <div>
          <label for="track-album-filter">Album assignment</label>
          <select id="track-album-filter"><option value="">All tracks</option><option value="assigned">In an album</option><option value="unassigned">Unassigned</option></select>
        </div>
      </div>
      <div class="track-results-summary"><span class="muted" id="track-filter-count" role="status" aria-live="polite">${tracks.length} shown</span><button class="button button--secondary" id="track-filter-reset" type="button">Clear filters</button></div>
      <ul class="item-list" id="track-list">${trackItems}</ul>
      <div class="empty-state" id="track-filter-empty" hidden>No tracks match these filters.</div>
      ${(pagination.hasPrevious || pagination.hasNext) ? `<nav class="inventory-pagination" aria-label="MediaTrack pages">
        ${pagination.hasPrevious ? `<a class="button button--secondary" href="/content/manage/audio-tracks?page=${pagination.page - 1}">Previous MediaTracks</a>` : ''}
        <span>Page ${pagination.page}</span>
        ${pagination.hasNext ? `<a class="button button--secondary" href="/content/manage/audio-tracks?page=${pagination.page + 1}">Next MediaTracks</a>` : ''}
      </nav>` : ''}
    </section>
  </main>
  <script src="/assets/browser-session-forms.js"></script>
  <script src="/assets/audio-tracks.js"></script>
</body>
</html>`;
};
