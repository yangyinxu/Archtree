import type { RoomAudioAnalysisItem, RoomAudioAnalysisPage, RoomAudioAnalysisReason } from '../../contracts/roomAudioAnalysis';
import { escapeHtml } from '../html';

export const roomAudioAnalysisPath = '/content/manage/room-audio-analysis';

/** Notices describe a completed request; current persisted rows establish the actual result. */
export const roomAudioAnalysisNotices = {
    finished: 'The request finished. Check the current analysis status below.',
    unknown: 'The result could not be confirmed. Refresh to check the current status, then use Retry analysis when it becomes available.',
    stale: 'The source changed before this request finished. Review its current status before starting another analysis.',
    busy: 'Analysis is already running. Refresh later to check its current status.',
    cancelled: 'The request stopped. Completed analysis remains available; check the current status before retrying.',
    failed: 'The request did not complete. Check the current status and retry guidance below.'
} as const;

export type RoomAudioAnalysisNotice = keyof typeof roomAudioAnalysisNotices;

const statusLabels: Record<RoomAudioAnalysisItem['status'], string> = {
    eligible: 'Ready for rooms',
    notAnalyzed: 'Not analyzed',
    running: 'Analysis in progress',
    retryable: 'Needs retry',
    unsupported: 'Unsupported audio',
    unavailable: 'Source unavailable'
};

const reasonLabels: Record<RoomAudioAnalysisReason, string> = {
    unsupported_audio: 'This file could not be verified for room playback.',
    decoder_unavailable: 'The audio analyzer is unavailable. Retry after the server configuration is restored.',
    analysis_timeout: 'Analysis exceeded its time limit. You can retry this source.',
    analysis_failed: 'Analysis failed. You can retry this source.',
    storage_unavailable: 'The stored file could not be read. Retry when storage is available.',
    source_changed: 'The source changed. Review the current file before analyzing it.',
    cancelled: 'The request stopped before completion. You can retry this source.',
    interrupted: 'The previous attempt was interrupted. You can resume it with Retry analysis.'
};

/** Builds only local pagination links; callers provide a validated catalog checkpoint. */
export const roomAudioAnalysisUrl = (after?: string, notice?: RoomAudioAnalysisNotice) => {
    const query = new URLSearchParams();
    if (after) query.set('after', after);
    if (notice) query.set('notice', notice);
    return `${roomAudioAnalysisPath}${query.size ? `?${query.toString()}` : ''}`;
};

/** Shows source-fenced, explicit analysis actions without media playback or automatic work. */
export const renderRoomAudioAnalysisPage = (
    page: RoomAudioAnalysisPage,
    options: { after?: string; notice?: RoomAudioAnalysisNotice } = {}
) => {
    const items = page.items.map(item => {
        const canAnalyze = (item.status === 'notAnalyzed' || item.status === 'retryable')
            && /^[0-9a-f]{24}$/.test(item.mediaTrackId)
            && /^[0-9a-f]{64}$/.test(item.sourceRevision)
            && /^[0-9a-f]{32}$/.test(item.attemptId);
        const status = Object.prototype.hasOwnProperty.call(statusLabels, item.status) ? statusLabels[item.status] : statusLabels.unavailable;
        const statusClass = item.status === 'eligible' ? ''
            : ['notAnalyzed', 'unsupported', 'unavailable'].includes(item.status) ? ' pill--muted' : ' pill--warning';
        const reason = item.reason && Object.prototype.hasOwnProperty.call(reasonLabels, item.reason) ? reasonLabels[item.reason] : '';
        const updated = item.updatedAt && Number.isFinite(Date.parse(item.updatedAt))
            ? new Date(item.updatedAt).toISOString() : null;
        const workspace = `/content/manage?view=catalog&prefillType=audioTrack&prefillId=${encodeURIComponent(item.mediaTrackId)}#audio-track-update-card`;
        return `<li>
          <div class="analysis-item-heading"><h2>${escapeHtml(item.title)}</h2><span class="pill${statusClass}">${escapeHtml(status)}</span></div>
          ${reason ? `<p class="muted">${escapeHtml(reason)}</p>` : ''}
          ${updated ? `<p class="muted">Updated <time datetime="${escapeHtml(updated)}">${escapeHtml(new Date(updated).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC</time></p>` : ''}
          <div class="analysis-actions">
            ${canAnalyze ? `<form method="POST" action="${roomAudioAnalysisPath}">
              <input type="hidden" name="mediaTrackId" value="${escapeHtml(item.mediaTrackId)}" />
              <input type="hidden" name="sourceRevision" value="${escapeHtml(item.sourceRevision)}" />
              <input type="hidden" name="attemptId" value="${escapeHtml(item.attemptId)}" />
              ${options.after ? `<input type="hidden" name="after" value="${escapeHtml(options.after)}" />` : ''}
              <button type="submit">${item.status === 'retryable' ? 'Retry analysis' : 'Analyze audio'}</button>
            </form>` : ''}
            <a class="button button--secondary" href="${escapeHtml(workspace)}">Open MediaTrack</a>
          </div>
        </li>`;
    }).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Room Audio Analysis - Archtree</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <style>
    .analysis-guide { display: grid; gap: 10px; }
    .analysis-guide p, .analysis-guide h2, .analysis-actions form, .analysis-results p, .analysis-results h2 { margin: 0; }
    .analysis-results > li { display: grid; gap: 12px; }
    .analysis-item-heading, .analysis-actions, .analysis-pagination { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
    .analysis-item-heading { justify-content: space-between; }
    .analysis-item-heading h2 { font-size: 20px; overflow-wrap: anywhere; }
    .analysis-pagination { margin-top: 20px; }
  </style>
</head>
<body class="inventory-page">
  <main class="page-shell">
    <header class="site-header operations-header">
      <div class="operations-header__identity">
        <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"><i class="ph ph-tree-structure"></i></span><span>Archtree</span></a>
        <p class="eyebrow">Administrator tools</p>
        <h1>Room Audio Analysis</h1>
        <p class="muted">Check existing Audio for shared playback.</p>
      </div>
      <div class="header-actions">
        <a class="button button--secondary" href="/content/manage?view=operations">Content Manager</a>
        <a class="button" href="${escapeHtml(roomAudioAnalysisUrl(options.after))}">Refresh status</a>
      </div>
    </header>
    ${options.notice ? `<div class="alert${['finished', 'busy'].includes(options.notice) ? '' : ' alert--error'}" role="status">${escapeHtml(roomAudioAnalysisNotices[options.notice])}</div>` : ''}
    <section class="card analysis-guide" aria-labelledby="analysis-guide-title">
      <h2 id="analysis-guide-title">Analyze one source at a time</h2>
      <p>Analyze audio checks the stored file’s duration and seeking support for rooms. Re-uploading is unnecessary, and ordinary playback remains available under its existing rules.</p>
      <p>Keep this page open while analysis runs. If interrupted, refresh status and use Retry analysis when available. Completed results are retained.</p>
    </section>
    <section class="card" aria-label="Audio analysis status">
      <ul class="item-list analysis-results">${items || '<li class="empty-state">No Audio sources on this page.</li>'}</ul>
      <nav class="analysis-pagination" aria-label="Analysis pagination">
        ${options.after ? `<a class="button button--secondary" href="${roomAudioAnalysisPath}">First page</a>` : ''}
        ${page.nextAfter ? `<a class="button button--secondary" href="${escapeHtml(roomAudioAnalysisUrl(page.nextAfter))}">Next page</a>` : ''}
      </nav>
    </section>
  </main>
</body>
</html>`;
};
