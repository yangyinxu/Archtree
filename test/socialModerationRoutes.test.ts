import assert from 'node:assert/strict';
import { Server } from 'node:http';
import test, { TestContext } from 'node:test';
import bodyParser from 'body-parser';
import express from 'express';
import type {
    SocialModerationApi, SocialModerationProfile, SocialModerationReport
} from '../src/application/social/socialModerationService';
import { SocialError } from '../src/contracts/socialV1';
import { AuthenticatedRequest } from '../src/middleware/authMiddleware';
import adminRoutes from '../src/routes/adminRoutes';
import { createSocialModerationRouter } from '../src/routes/socialModerationRoutes';

const adminId = 'a'.repeat(24);
const socialId = `s_${'b'.repeat(32)}`;
const reportId = `rp_${'c'.repeat(32)}`;
const profile: SocialModerationProfile = {
    socialId, handle: 'mallory', alias: 'Mallory <b>', status: 'active', discoverable: true, suspendedAt: null, openReports: 2
};
const report: SocialModerationReport = {
    reportId, reason: 'harassment', note: 'Keeps sending <script>alert(1)</script>', state: 'open', createdAt: '2026-10-01T10:00:00.000Z',
    resolution: null, resolvedAt: null,
    reported: { socialId, handle: 'mallory', alias: 'Mallory <b>', current: profile },
    reporter: { socialId: `s_${'d'.repeat(32)}`, handle: 'alice' }
};

const fixture = () => {
    const calls: unknown[][] = [];
    const service: SocialModerationApi = {
        listReports: async input => { calls.push(['listReports', input]); return { items: [report], nextCursor: null }; },
        findProfile: async handle => { calls.push(['findProfile', handle]); return handle === 'mallory' ? profile : null; },
        listSuspended: async () => { calls.push(['listSuspended']); return []; },
        resolveReport: async (actor, id, resolution) => { calls.push(['resolveReport', actor, id, resolution]);
            return { outcome: 'applied', value: { ...report, state: 'resolved', resolution, resolvedAt: '2026-10-02T10:00:00.000Z' } }; },
        suspend: async (actor, id) => { calls.push(['suspend', actor, id]);
            return { outcome: 'applied', value: { ...profile, status: 'suspended', suspendedAt: '2026-10-02T10:00:00.000Z' } }; },
        unsuspend: async (actor, id) => { calls.push(['unsuspend', actor, id]); return { outcome: 'noop', value: profile }; }
    };
    return { service, calls };
};

/** The real router guards run; a preceding test layer installs an already-verified identity. */
const listen = async (t: TestContext, service: SocialModerationApi) => {
    const app = express();
    app.use((req, _res, next) => {
        const role = req.get('x-test-role');
        if (role) (req as AuthenticatedRequest).auth = { userId: adminId, email: 'admin@example.test', role: role === 'admin' ? 'admin' : 'user', sessionId: 'synthetic-session' };
        next();
    });
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use('/admin/social', createSocialModerationRouter({ service }));
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ message: 'The service could not complete the request.' });
    });
    const server = await new Promise<Server>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/admin/social`;
    return (path: string, init: RequestInit & { role?: string | null } = {}) => {
        const { role = 'admin', ...rest } = init;
        return fetch(`${base}${path}`, { redirect: 'manual', ...rest,
            headers: { accept: 'application/json', ...(role ? { 'x-test-role': role } : {}), ...rest.headers } });
    };
};
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const form = (body: Record<string, string>): RequestInit => ({ method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

test('the admin router mounts moderation behind its own authentication and administrator guards', () => {
    const layer = (adminRoutes as unknown as { stack: Array<{ regexp: RegExp; handle: { stack?: Array<{ name: string; route?: unknown }> } }> })
        .stack.find(candidate => candidate.regexp.test('/social/reports'));
    assert.ok(layer?.handle.stack);
    assert.deepEqual(layer.handle.stack.slice(0, 2).map(entry => entry.name), ['requireAuth', 'requireAdmin']);
    assert.equal(layer.handle.stack.slice(0, 3).some(entry => entry.route), false);
});

test('only an authenticated administrator reaches any moderation route or service call', async t => {
    const { service, calls } = fixture();
    const request = await listen(t, service);
    for (const [path, init] of [['/reports', {}], ['/profiles?handle=mallory', {}], [`/reports/${reportId}/resolve`, json({ resolution: 'dismissed' })],
        [`/profiles/${socialId}/suspend`, json({})], [`/profiles/${socialId}/unsuspend`, json({})]] as const) {
        assert.equal((await request(path, { ...init, role: null })).status, 401, path);
        assert.equal((await request(path, { ...init, role: 'user' })).status, 403, path);
    }
    assert.equal(calls.length, 0);
    const allowed = await request('/reports');
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('cache-control')!, /no-store/);
});

test('report and profile reads validate bounded queries and return the service views as JSON', async t => {
    const { service, calls } = fixture();
    const request = await listen(t, service);
    assert.deepEqual(await (await request('/reports')).json(), { items: [report], nextCursor: null });
    await request(`/reports?state=resolved&limit=100&cursor=1700000000000.${reportId}`);
    assert.deepEqual(calls.slice(0, 2), [['listReports', { state: 'open', limit: 50, cursor: undefined }],
        ['listReports', { state: 'resolved', limit: 100, cursor: `1700000000000.${reportId}` }]]);
    assert.deepEqual(await (await request('/profiles?handle=MALLORY')).json(), { items: [profile] });
    assert.deepEqual(await (await request('/profiles?handle=nobody')).json(), { items: [] });
    assert.deepEqual(await (await request('/profiles?suspended=true')).json(), { items: [] });
    for (const path of ['/reports?state=closed', '/reports?limit=0', '/reports?limit=1000', '/reports?limit=ten', '/reports?state=open&state=resolved',
        '/reports?email=private', '/reports?handle=mallory', '/reports?notice=resolved', '/reports?format=xml', '/profiles', '/profiles?handle=a',
        '/profiles?handle=mallory&suspended=true', '/profiles?suspended=yes']) {
        const response = await request(path);
        assert.equal(response.status, 400, path);
        assert.equal((await response.json()).code, 'invalid_request');
    }
    assert.equal((await request('/unknown')).status, 404);
});

test('a browser asking for HTML receives the escaped moderation page with a handle lookup', async t => {
    const { service, calls } = fixture();
    const request = await listen(t, service);
    const response = await request('/reports?handle=Mallory&notice=suspended', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/html/);
    const html = await response.text();
    assert.match(html, /Social Reports/);
    assert.match(html, /Keeps sending &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /Mallory &lt;b&gt;/);
    assert.match(html, new RegExp(`/admin/social/profiles/${socialId}/suspend`));
    assert.match(html, new RegExp(`/admin/social/reports/${reportId}/resolve`));
    assert.match(html, /role="status">The listener is suspended from social features/);
    for (const path of ['/reports?notice=Click%20here', '/reports?message=Done']) {
        assert.equal((await request(path, { headers: { accept: 'text/html' } })).status, 400, path);
    }
    assert.deepEqual(calls.map(call => call[0]), ['listReports', 'findProfile', 'listSuspended']);
    assert.equal(calls[1][1], 'mallory');
    const json = await request('/reports?format=json', { headers: { accept: 'text/html' } });
    assert.match(json.headers.get('content-type')!, /application\/json/);
});

test('resolve, suspend and unsuspend pass the administrator and exact target, as JSON or a form redirect', async t => {
    const { service, calls } = fixture();
    const request = await listen(t, service);
    const resolved = await request(`/reports/${reportId}/resolve`, json({ resolution: 'dismissed' }));
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).value.resolution, 'dismissed');
    const suspended = await request(`/profiles/${socialId}/suspend`, json({}));
    assert.deepEqual((await suspended.json()).outcome, 'applied');
    const redirected = await request(`/profiles/${socialId}/unsuspend`, form({}));
    assert.equal(redirected.status, 303);
    const location = redirected.headers.get('location')!;
    assert.equal(location, '/admin/social/reports?notice=not_suspended');
    const formResolve = await request(`/reports/${reportId}/resolve`, form({ resolution: 'actioned' }));
    assert.equal(formResolve.status, 303);
    assert.equal(formResolve.headers.get('location'), '/admin/social/reports?notice=resolved');
    assert.deepEqual(calls, [
        ['resolveReport', { userId: adminId }, reportId, 'dismissed'],
        ['suspend', { userId: adminId }, socialId],
        ['unsuspend', { userId: adminId }, socialId],
        ['resolveReport', { userId: adminId }, reportId, 'actioned']
    ]);
});

test('malformed moderation writes fail before service work and domain refusals keep their status', async t => {
    const { service, calls } = fixture();
    const request = await listen(t, service);
    for (const [path, init] of [
        [`/reports/${reportId}/resolve`, json({})], [`/reports/${reportId}/resolve`, json({ resolution: 'suspended' })],
        [`/reports/${reportId}/resolve`, json({ resolution: 'dismissed', reportId: 'other' })], ['/reports/rp_bad/resolve', json({ resolution: 'dismissed' })],
        [`/reports/${reportId}/resolve?force=1`, json({ resolution: 'dismissed' })], ['/profiles/not-social/suspend', json({})],
        [`/profiles/${socialId}/suspend`, json({ accountId: 'private' })]
    ] as const) {
        const response = await request(path, init);
        assert.equal(response.status, 400, path);
        assert.equal((await response.json()).code, 'invalid_request');
    }
    assert.equal(calls.length, 0);
    const invalidForm = await request('/profiles/not-social/suspend', form({}));
    assert.equal(invalidForm.status, 303);
    assert.equal(invalidForm.headers.get('location'), '/admin/social/reports?notice=invalid');

    service.suspend = async () => { throw new SocialError(404, 'profile_unavailable'); };
    service.resolveReport = async () => { throw new SocialError(503, 'mutation_outcome_unknown'); };
    const missing = await request(`/profiles/${socialId}/suspend`, json({}));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { code: 'profile_unavailable', message: 'The social request could not be completed.' });
    const unknown = await request(`/reports/${reportId}/resolve`, form({ resolution: 'dismissed' }));
    assert.equal(unknown.status, 303);
    assert.equal(unknown.headers.get('location'), '/admin/social/reports?notice=outcome_unknown');
    service.unsuspend = async () => { throw new Error('synthetic infrastructure failure'); };
    const failed = await request(`/profiles/${socialId}/unsuspend`, json({}));
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /synthetic infrastructure/);
});
