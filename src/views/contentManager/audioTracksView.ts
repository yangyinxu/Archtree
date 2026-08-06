import { escapeHtml } from '../html';
import type { ManagementInventoryPage } from './inventoryPagination';

type AudioTrackPagination = Omit<ManagementInventoryPage<unknown>, 'items'>;

/** Renders one bounded page of the administrator's global Soundtrack inventory. */
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
            return `<li data-track-item data-search="${escapeHtml(`${title} ${id} ${albumId} ${originalFileName}`.toLowerCase())}">
              <div class="track-title-row"><strong>${escapeHtml(title)}</strong><span><span class="pill ${status.className}">${status.label}</span> ${albumId ? '<span class="pill">In album</span>' : '<span class="pill pill--muted">Unassigned</span>'}</span></div>
              <div class="item-meta">
                <span>Track ID: <code>${escapeHtml(id)}</code></span>
                <span>${albumId ? `Album ID: <code>${escapeHtml(albumId)}</code>` : 'No album assigned'}</span>
                ${originalFileName ? `<span>File: ${escapeHtml(originalFileName)}</span>` : ''}
                ${uploadError ? `<span class="status-error">Storage error: ${escapeHtml(uploadError)}</span>` : ''}
              </div>
              <div><a class="button button--secondary" href="${editUrl}">Edit track</a></div>
            </li>`;
        }).join('')
        : '<li class="empty-state">No audio tracks yet. Create one from the Content Manager.</li>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Audio Tracks - Archtree</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <style>
    .track-toolbar { align-items: end; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto; margin-bottom: 18px; }
    .track-title-row { align-items: center; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; }
    .pill--muted { color: #58635e; background: #e8ebe7; }
    [data-track-item] { display: grid; gap: 10px; }
    .inventory-pagination { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 18px; }
    .inventory-pagination span { color: var(--muted); font-size: 14px; font-weight: 700; }
    @media (max-width: 600px) { .track-toolbar { align-items: stretch; grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="page-shell">
    <header class="site-header">
      <div>
        <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">A</span><span>Archtree</span></a>
        <p class="eyebrow" style="margin-top:18px;">Audio library</p>
        <h1 style="margin-bottom:8px;">Audio Tracks</h1>
        <p class="muted">Global catalog · signed in as <strong>${escapeHtml(userEmail)}</strong> · ${tracks.length} track${tracks.length === 1 ? '' : 's'} on page ${pagination.page}</p>
      </div>
      <div class="header-actions">
        <a class="button" href="/content/manage#create">Create and upload</a>
        <a class="button button--secondary" href="/content/manage">Content Manager</a>
        <form method="POST" action="/auth/logout-web"><input type="hidden" name="viewerId" value="${escapeHtml(userId)}" /><button class="button--secondary" type="submit">Log out</button></form>
      </div>
    </header>
    <section class="card card--raised">
      <div class="track-toolbar">
        <div>
          <label for="track-filter">Filter tracks</label>
          <input id="track-filter" type="search" placeholder="Search title, ID, album, or filename" />
        </div>
        <span class="muted" id="track-filter-count">${tracks.length} shown</span>
      </div>
      <ul class="item-list" id="track-list">${trackItems}</ul>
      <div class="empty-state" id="track-filter-empty" hidden>No tracks match this search.</div>
      ${(pagination.hasPrevious || pagination.hasNext) ? `<nav class="inventory-pagination" aria-label="Audio Track pages">
        ${pagination.hasPrevious ? `<a class="button button--secondary" href="/content/manage/audio-tracks?page=${pagination.page - 1}">Previous Audio Tracks</a>` : ''}
        <span>Page ${pagination.page}</span>
        ${pagination.hasNext ? `<a class="button button--secondary" href="/content/manage/audio-tracks?page=${pagination.page + 1}">Next Audio Tracks</a>` : ''}
      </nav>` : ''}
    </section>
  </main>
  <script src="/assets/browser-session-forms.js"></script>
  <script src="/assets/audio-tracks.js"></script>
</body>
</html>`;
};
