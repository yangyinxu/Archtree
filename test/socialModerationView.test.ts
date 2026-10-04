import assert from 'node:assert/strict';
import test from 'node:test';
import type { SocialModerationProfile, SocialModerationReport } from '../src/application/social/socialModerationService';
import { isSocialModerationNotice, renderSocialModerationPage } from '../src/views/admin/socialModerationView';

const socialId = `s_${'b'.repeat(32)}`;
const current: SocialModerationProfile = {
    socialId, handle: 'mallory_two', alias: 'Now "Quiet"', status: 'active', discoverable: false, suspendedAt: null, openReports: 1
};
const report = (overrides: Partial<SocialModerationReport> = {}): SocialModerationReport => ({
    reportId: `rp_${'c'.repeat(32)}`, reason: 'impersonation', note: null, state: 'open', createdAt: '2026-10-01T10:00:00.000Z',
    resolution: null, resolvedAt: null, reported: { socialId, handle: 'mallory', alias: '<img src=x onerror=alert(1)>', current },
    reporter: null, ...overrides
});
const render = (overrides: Partial<Parameters<typeof renderSocialModerationPage>[0]> = {}) => renderSocialModerationPage({
    adminEmail: 'admin+<tag>@example.test', state: 'open', page: { items: [report()], nextCursor: null }, suspended: [],
    lookup: null, notice: null, ...overrides
});

test('open reports show the reported snapshot, the renamed current profile and every moderation control, escaped', () => {
    const html = render();
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /admin\+&lt;tag&gt;@example\.test/);
    assert.match(html, /changed their name since this report/);
    assert.match(html, /Now &quot;Quiet&quot;/);
    assert.match(html, /Reporter: Deleted account/);
    assert.match(html, /Pretending to be someone else/);
    assert.match(html, new RegExp(`action="/admin/social/profiles/${socialId}/suspend"`));
    assert.match(html, /name="resolution" value="actioned"/);
    assert.match(html, /name="resolution" value="dismissed"/);
    assert.match(html, /data-confirm="Suspend this listener/);
    assert.match(html, /<script src="\/assets\/audio-storage-audit\.js"><\/script>/);
    assert.match(html, /No listeners are suspended\./);
});

test('resolved reports, missing profiles, suspended listeners and lookups render without action leaks', () => {
    const suspended: SocialModerationProfile = { ...current, status: 'suspended', suspendedAt: '2026-10-02T08:30:00.000Z' };
    const html = render({
        state: 'resolved',
        page: { items: [report({ state: 'resolved', resolution: 'suspended', resolvedAt: '2026-10-02T08:30:00.000Z',
            reported: { socialId, handle: 'gone', alias: 'Gone', current: null }, reporter: { socialId: `s_${'d'.repeat(32)}`, handle: 'alice' },
            note: 'Line one\nLine <two>' })], nextCursor: `1759312800000.rp_${'c'.repeat(32)}` },
        suspended: [suspended], lookup: { handle: 'nobody', profile: null }, notice: 'outcome_unknown'
    });
    assert.match(html, /Listener suspended 2026-10-02 08:30 UTC/);
    assert.match(html, /This social profile no longer exists\./);
    assert.match(html, /Reporter: @alice/);
    assert.match(html, /Line one\nLine &lt;two&gt;/);
    assert.doesNotMatch(html, /\/resolve"/);
    assert.match(html, new RegExp(`action="/admin/social/profiles/${socialId}/unsuspend"`));
    assert.match(html, /Status: Suspended since 2026-10-02 08:30 UTC/);
    assert.match(html, /No social profile has that handle\./);
    assert.match(html, /class="alert alert--error" role="status">The result is unknown/);
    assert.match(html, /state=resolved&amp;cursor=1759312800000\.rp_c{32}/);
    assert.match(html, /href="\/admin\/social\/reports\?state=open">Open reports/);
});

test('only fixed notice codes are renderable', () => {
    assert.equal(isSocialModerationNotice('suspended'), true);
    for (const value of ['Click here', 'toString', '__proto__', '', undefined, ['suspended']]) {
        assert.equal(isSocialModerationNotice(value), false, String(value));
    }
    assert.match(render({ page: { items: [], nextCursor: null }, notice: 'resolved' }), /class="alert" role="status">Report resolved\./);
    assert.match(render({ page: { items: [], nextCursor: null } }), /No open reports\./);
});
