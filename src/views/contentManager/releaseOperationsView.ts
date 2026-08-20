import type { ArtistReleaseWorkflowResult } from '../../services/artistReleaseWorkflowService';
import { escapeHtml } from '../html';

const workflowStepLabels: Record<string, string> = {
    artist: 'Artist ready',
    album: 'Album created',
    relationship: 'Artist and Album linked',
    carousel: 'Carousel configured',
    page: 'Page placement saved'
};

/** Renders retained workflow progress with resumable actions and links to completed content. */
export const renderReleaseOperations = (operations: ArtistReleaseWorkflowResult[]) => {
    if (operations.length === 0) {
        return '<div class="empty-linked-content"><p>No Artist release setup operations yet.</p><a class="button button--secondary" href="/content/manage?view=overview#artist-release-setup">Start a guided Artist release</a></div>';
    }

    return `<ul class="operation-list">${operations.map((operation) => {
        const statusLabel = operation.status === 'complete'
            ? 'Complete'
            : operation.status === 'needsAttention' ? 'Needs attention' : 'In progress';
        const statusClass = operation.status === 'complete'
            ? ''
            : operation.status === 'needsAttention' ? 'pill--danger' : 'pill--warning';
        const resourceLinks = [
            operation.artistId ? `<a href="/content/manage?view=catalog&prefillType=artist&prefillId=${encodeURIComponent(operation.artistId)}#artist-update-card">Open Artist</a>` : '',
            operation.albumId ? `<a href="/content/manage?view=catalog&prefillType=album&prefillId=${encodeURIComponent(operation.albumId)}#album-update-card">Open Album</a>` : '',
            operation.carouselId ? '<a href="/content/manage?view=layout#composition">Open Page Layout</a>' : ''
        ].filter(Boolean).join('');
        const steps = Object.entries(operation.steps).map(([name, step]) => {
            const stepLabel = workflowStepLabels[name] ?? name;
            const stepStatus = step.status === 'complete'
                ? 'Complete'
                : step.status === 'skipped'
                    ? 'Skipped'
                    : step.status === 'failed'
                        ? 'Failed'
                        : step.status === 'inProgress' ? 'In progress' : 'Waiting';
            return `<li class="operation-step operation-step--${escapeHtml(step.status)}"><span aria-hidden="true">${step.status === 'complete' ? '✓' : step.status === 'failed' ? '!' : '○'}</span><span><strong>${escapeHtml(stepLabel)}</strong><small>${escapeHtml(stepStatus)}${step.error ? ` · ${escapeHtml(step.error)}` : ''}</small></span></li>`;
        }).join('');
        return `<li class="operation-card"><div class="operation-heading"><span class="pill ${statusClass}">${statusLabel}</span><button class="copy-id" type="button" data-copy-id="${escapeHtml(operation.operationId)}">Copy operation ID</button></div><ol class="operation-steps">${steps}</ol>${operation.lastError ? `<p class="status-error">Last error: ${escapeHtml(operation.lastError)}</p>` : ''}<div class="operation-actions">${resourceLinks}${operation.pageSlug ? `<a href="/content/manage?view=layout#composition">Page: ${escapeHtml(operation.pageSlug)}</a>` : ''}${operation.status === 'needsAttention' ? `<form method="POST" action="/content/manage/workflows/artist-release/retry"><input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}" /><button class="button--secondary" type="submit">Retry incomplete steps</button></form>` : ''}</div></li>`;
    }).join('')}</ul>`;
};
