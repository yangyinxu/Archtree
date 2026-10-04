import type {
    SocialModerationProfile, SocialModerationReport, SocialModerationReportPage, SocialReportState
} from '../../application/social/socialModerationService';
import { escapeHtml } from '../html';

/** Fixed outcome notices: a redirect names one, so the page never renders text taken from a URL. */
const notices = {
    resolved: ['Report resolved.', false], already_resolved: ['That report was already resolved.', false],
    suspended: ['The listener is suspended from social features. Open reports about them are resolved.', false],
    already_suspended: ['That listener was already suspended.', false],
    unsuspended: ['The listener is no longer suspended.', false], not_suspended: ['That listener was not suspended.', false],
    profile_unavailable: ['That social profile no longer exists.', true], report_unavailable: ['That report no longer exists.', true],
    outcome_unknown: ['The result is unknown. Reload this page and check before trying again.', true],
    unavailable: ['Moderation is temporarily unavailable. Try again.', true], invalid: ['The request was not valid.', true]
} as const satisfies Record<string, readonly [string, boolean]>;
export type SocialModerationNotice = keyof typeof notices;
export const isSocialModerationNotice = (value: unknown): value is SocialModerationNotice =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(notices, value);

export interface SocialModerationPageInput {
    adminEmail: string;
    state: SocialReportState;
    page: SocialModerationReportPage;
    suspended: SocialModerationProfile[];
    lookup: { handle: string; profile: SocialModerationProfile | null } | null;
    notice: SocialModerationNotice | null;
}

const reasonLabels: Record<SocialModerationReport['reason'], string> = {
    impersonation: 'Pretending to be someone else', harassment: 'Harassment or bullying',
    spam: 'Spam or unwanted requests', inappropriate: 'Offensive name or content', other: 'Something else'
};
const resolutionLabels: Record<NonNullable<SocialModerationReport['resolution']>, string> = {
    dismissed: 'Dismissed, no action', actioned: 'Handled', suspended: 'Listener suspended'
};
const statusLabels: Record<SocialModerationProfile['status'], string> = {
    active: 'Active', inactive: 'Deactivated by the listener', suspended: 'Suspended'
};
const formatDate = (value: string | null) => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? escapeHtml(`${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`) : 'Unknown';
};
const encode = (value: string) => encodeURIComponent(value);

/** One suspend or unsuspend control; the server rechecks state, so a stale page cannot double-apply. */
const profileAction = (profile: SocialModerationProfile) => profile.status === 'suspended'
    ? `<form method="POST" action="/admin/social/profiles/${encode(profile.socialId)}/unsuspend"><button type="submit" class="button--secondary" data-confirm="Lift the suspension? Their profile, friends and discovery setting come back.">Unsuspend</button></form>`
    : `<form method="POST" action="/admin/social/profiles/${encode(profile.socialId)}/suspend"><button type="submit" data-danger data-confirm="Suspend this listener from social features? Their profile is hidden, requests, shares and listening status are cleared, they leave rooms (rooms they host end), and open reports about them are resolved.">Suspend from social</button></form>`;

const profileSummary = (profile: SocialModerationProfile) => `<div class="item-meta">
    <span>@${escapeHtml(profile.handle)}</span><span>${escapeHtml(profile.alias)}</span>
    <span>Status: ${statusLabels[profile.status]}${profile.suspendedAt ? ` since ${formatDate(profile.suspendedAt)}` : ''}</span>
    <span>Discoverable: ${profile.discoverable ? 'Yes' : 'No'}</span><span>Open reports: ${profile.openReports}</span>
  </div>`;

const reportItem = (report: SocialModerationReport) => {
    const current = report.reported.current;
    const renamed = current && (current.handle !== report.reported.handle || current.alias !== report.reported.alias);
    return `<li>
    <strong>${escapeHtml(report.reported.alias)} <span class="muted">@${escapeHtml(report.reported.handle)}</span></strong>
    <div class="item-meta">
      <span>Reason: ${reasonLabels[report.reason]}</span>
      <span>Reported ${formatDate(report.createdAt)}</span>
      <span>Reporter: ${report.reporter ? `@${escapeHtml(report.reporter.handle ?? 'unknown')}` : 'Deleted account'}</span>
      ${report.resolution ? `<span>${resolutionLabels[report.resolution]} ${formatDate(report.resolvedAt)}</span>` : ''}
    </div>
    ${report.note ? `<blockquote class="report-note">${escapeHtml(report.note)}</blockquote>` : ''}
    ${current ? `${renamed ? '<p class="muted">The listener has changed their name since this report. Current profile:</p>' : ''}${profileSummary(current)}` : '<p class="muted">This social profile no longer exists.</p>'}
    ${report.state === 'open' ? `<div class="remediation-actions">
      ${current ? profileAction(current) : ''}
      <form method="POST" action="/admin/social/reports/${encode(report.reportId)}/resolve"><input type="hidden" name="resolution" value="actioned" /><button type="submit" class="button--secondary">Mark handled</button></form>
      <form method="POST" action="/admin/social/reports/${encode(report.reportId)}/resolve"><input type="hidden" name="resolution" value="dismissed" /><button type="submit" class="button--secondary">Dismiss</button></form>
    </div>` : ''}
  </li>`;
};

/** Renders the administrator moderation queue; every listener-supplied value is escaped. */
export const renderSocialModerationPage = (input: SocialModerationPageInput) => {
    const { page, state } = input;
    const other = state === 'open' ? 'resolved' : 'open';
    const lookup = input.lookup;
    const notice = input.notice ? notices[input.notice] : null;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Social Reports - Archtree</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <style>
    .item-list > li { display: grid; gap: 8px; }
    .remediation-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 9px; }
    .remediation-actions form, .lookup-form { margin: 0; }
    .lookup-form { align-items: end; display: flex; flex-wrap: wrap; gap: 9px; }
    .report-note { border-left: 3px solid var(--line); margin: 0; padding: 4px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body class="audit-page">
  <main class="page-shell">
    <header class="site-header operations-header">
      <div class="operations-header__identity">
        <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"><i class="ph ph-tree-structure"></i></span><span>Archtree</span></a>
        <p class="eyebrow" style="margin-top:18px;">Administrator tools</p>
        <h1 style="margin-bottom:8px;">Social Reports</h1>
        <p class="muted operations-meta"><span>Signed in as <strong>${escapeHtml(input.adminEmail)}</strong></span></p>
      </div>
      <div class="header-actions">
        <a class="button" href="/content/manage"><i class="ph ph-stack" aria-hidden="true"></i>Content Manager</a>
        <a class="button button--secondary" href="/admin/social/reports?state=${other}">${other === 'resolved' ? 'Resolved reports' : 'Open reports'}</a>
      </div>
    </header>
    ${notice ? `<div class="alert${notice[1] ? ' alert--error' : ''}" role="status">${escapeHtml(notice[0])}</div>` : ''}

    <section class="card" aria-labelledby="moderation-guide-heading">
      <p class="eyebrow">How this works</p>
      <h2 id="moderation-guide-heading">Reports stay private</h2>
      <p>Reported listeners are never told that they were reported or by whom. Suspension hides a listener from social features until you lift it; their friendships return when it is lifted. Resolved reports are deleted after 90 days.</p>
    </section>

    <div class="section-heading"><div><p class="eyebrow">Find a listener</p><h2>Look up a handle</h2></div></div>
    <section class="card">
      <form class="lookup-form" method="GET" action="/admin/social/reports">
        <input type="hidden" name="state" value="${state}" />
        <label>Handle <input name="handle" maxlength="24" autocomplete="off" value="${escapeHtml(lookup?.handle ?? '')}" /></label>
        <button type="submit" class="button--secondary">Look up</button>
      </form>
      ${lookup ? lookup.profile ? `<ul class="item-list"><li><strong>${escapeHtml(lookup.profile.alias)}</strong>${profileSummary(lookup.profile)}<div class="remediation-actions">${profileAction(lookup.profile)}</div></li></ul>`
        : '<p class="empty-state">No social profile has that handle.</p>' : ''}
    </section>

    <div class="section-heading"><div><p class="eyebrow">${state === 'open' ? 'Oldest first' : 'Newest first'}</p><h2>${state === 'open' ? 'Open reports' : 'Resolved reports'}</h2></div></div>
    <section class="card">
      ${page.items.length ? `<ul class="item-list">${page.items.map(reportItem).join('')}</ul>` : `<p class="empty-state">${state === 'open' ? 'No open reports.' : 'No resolved reports.'}</p>`}
      ${page.nextCursor ? `<a class="button button--secondary" href="/admin/social/reports?state=${state}&amp;cursor=${encode(page.nextCursor)}">More reports</a>` : ''}
    </section>

    <div class="section-heading"><div><p class="eyebrow">Most recent first</p><h2>Suspended listeners</h2></div></div>
    <section class="card">
      ${input.suspended.length ? `<ul class="item-list">${input.suspended.map(profile => `<li><strong>${escapeHtml(profile.alias)}</strong>${profileSummary(profile)}<div class="remediation-actions">${profileAction(profile)}</div></li>`).join('')}</ul>`
        : '<p class="empty-state">No listeners are suspended.</p>'}
    </section>
  </main>
  <!-- The audit page's generic data-confirm handler: confirms before any destructive form submits. -->
  <script src="/assets/audio-storage-audit.js"></script>
</body>
</html>`;
};
