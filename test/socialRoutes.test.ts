import assert from 'node:assert/strict';
import { Server } from 'node:http';
import test, { TestContext } from 'node:test';
import express, { RequestHandler } from 'express';
import { createApp } from '../src/app';
import { createSocialRouter } from '../src/routes/socialRoutes';
import {
    SocialApi, SocialActor, SocialCommand, SocialError, SocialOutcome
} from '../src/contracts/socialV1';
import { AuthenticatedRequest } from '../src/middleware/authMiddleware';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import { requireSameOriginCookieMutation } from '../src/services/authCookieService';

const actor: SocialActor = { userId: 'synthetic-account', sessionId: 'synthetic-session' };
const socialId = `s_${'a'.repeat(32)}`;
const identity = { scopeToken: 'synthetic-signed-scope-token', commandId: 'synthetic-command-01' };
const card = { socialId, handle: 'alice_123', alias: 'Alice', iconSeed: socialId };
const result: SocialOutcome = { commandId: identity.commandId, outcome: 'applied', replayed: false };

/** Supplies only an explicit synthetic identity; real middleware mounting has a separate HTTP assertion. */
const authenticate: RequestHandler = (req, res, next) => {
    if (req.get('x-test-auth') === 'missing') return res.status(401).json({ code: 'login_required' });
    (req as AuthenticatedRequest).auth = { ...actor, email: 'private@example.test', role: 'user',
        ...(req.get('x-test-auth') === 'legacy' ? { sessionId: undefined } : {}) };
    next();
};

const fixtureApi = () => {
    const commands: SocialCommand[] = [];
    const actors: SocialActor[] = [];
    const reads: unknown[][] = [];
    const api: SocialApi = {
        admissionEnabled: () => true,
        issueScope: async (who) => { actors.push(who); return { scopeToken: identity.scopeToken, expiresAt: '2026-09-14T00:00:00.000Z' }; },
        ownProfile: async (who) => { actors.push(who); return { ...card, active: true, discoverable: true, revision: 3 }; },
        lookup: async (who, handle) => { actors.push(who); reads.push(['lookup', handle]); return handle === card.handle ? card : null; },
        list: async (who, ...args) => { actors.push(who); reads.push(['list', ...args]); return { items: [{ socialId, profile: card, revision: 4 }], nextCursor: null }; },
        relationship: async (who, targetSocialId) => { actors.push(who); reads.push(['relationship', targetSocialId]);
            return { socialId: targetSocialId, state: 'none', revision: 4 }; },
        mutate: async (who, command) => { actors.push(who); commands.push(command); return result; },
        outcome: async (who, input) => { actors.push(who); reads.push(['outcome', input]); return { ...result, replayed: true }; }
    };
    return { api, commands, actors, reads };
};

const listen = async (t: TestContext, api: SocialApi) => {
    resetRateLimitWindowsForTests();
    const app = express();
    app.use(requireSameOriginCookieMutation);
    app.use('/api/social/v1', createSocialRouter({ api, authenticate }));
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ message: 'The service could not complete the request.' });
    });
    return start(t, app);
};

const start = async (t: TestContext, app: express.Application) => {
    const server = await new Promise<Server>(resolve => {
        const value = app.listen(0, '127.0.0.1', () => resolve(value));
    });
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (path: string, body?: unknown, overrides: RequestInit = {}) => fetch(`${base}/api/social/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...overrides,
        headers: { authorization: 'Bearer synthetic', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...overrides.headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { base, request };
};

test('social identity/session/viewer guards run before JSON parsing or service work', async t => {
    const { api, commands, actors } = fixtureApi();
    const { base, request } = await listen(t, api);
    const denied = await fetch(`${base}/api/social/v1/me/profile`, { method: 'PATCH',
        headers: { authorization: 'Bearer synthetic', 'x-test-auth': 'missing', 'content-type': 'application/json' },
        body: `{"private":"${'x'.repeat(8_000)}` });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('cache-control')!, /no-store/);
    assert.equal((await request('/me/profile', undefined, { headers: { 'x-test-auth': 'legacy' } })).status, 401);
    const stale = await fetch(`${base}/api/social/v1/me/profile`, { headers: { 'x-finitude-account-viewer': 'other-account' } });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'account_viewer_mismatch');
    assert.equal(commands.length, 0);
    assert.equal(actors.length, 0);
    assert.equal((await request('/me/profile')).status, 200);
    assert.deepEqual(actors, [actor]);
});

test('cookie social writes require same-origin proof and the current account viewer', async t => {
    const { api, commands } = fixtureApi();
    const { base } = await listen(t, api);
    const endpoint = `${base}/api/social/v1/me/deactivate`;
    const headers = { cookie: 'session_token=synthetic', 'content-type': 'application/json', 'x-finitude-account-viewer': actor.userId };
    for (const origin of [undefined, 'https://untrusted.example']) {
        const response = await fetch(endpoint, { method: 'POST', headers: { ...headers, ...(origin ? { origin } : {}) }, body: JSON.stringify(identity) });
        assert.equal(response.status, 403);
    }
    assert.equal(commands.length, 0);
    const response = await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: base }, body: JSON.stringify(identity) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-finitude-account-viewer'), actor.userId);
    assert.equal(commands.length, 1);
});

test('profile and relationship endpoints construct one frozen command from exact authorized inputs', async t => {
    const { api, commands } = fixtureApi();
    const { request } = await listen(t, api);
    const profile = await request('/me/profile', { ...identity, handle: 'ALICE_123', alias: ' Alice ', discoverable: true, expectedRevision: 0 }, { method: 'PATCH' });
    assert.equal(profile.status, 200);
    assert.deepEqual(commands[0], { ...identity, action: 'profile', handle: 'alice_123', alias: 'Alice', discoverable: true, expectedRevision: 0 });
    assert.equal((await request('/friend-requests', { ...identity, targetSocialId: socialId, expectedRevision: 0 })).status, 200);
    for (const action of ['accept', 'decline', 'cancel', 'remove', 'block', 'unblock']) {
        const body = { ...identity, ...(action === 'block' ? {} : { expectedRevision: 4 }) };
        assert.equal((await request(`/relationships/${socialId}/${action}`, body)).status, 200);
        assert.deepEqual(commands.at(-1), { ...body, action, targetSocialId: socialId });
    }
    assert.equal((await request('/me/deactivate', identity)).status, 200);
    assert.equal(commands.length, 9);
    assert.ok(commands.every(Object.isFrozen));
});

test('mutation routes reject caller-controlled action, target overrides and unknown fields', async t => {
    const { api, commands } = fixtureApi();
    const { request } = await listen(t, api);
    const cases: [string, unknown][] = [
        ['/me/deactivate', { ...identity, action: 'profile' }],
        ['/me/deactivate?extra=1', identity],
        ['/friend-requests', { ...identity, targetSocialId: socialId }],
        ['/friend-requests', { ...identity, targetSocialId: socialId, expectedRevision: '1' }],
        [`/relationships/${socialId}/accept`, { ...identity, expectedRevision: 1, targetSocialId: `s_${'b'.repeat(32)}` }],
        [`/relationships/${socialId}/block`, { ...identity, expectedRevision: 1 }],
        ['/relationships/not-a-social-id/block', identity],
        ['/mutation-scopes', identity], ['/mutation-scopes', []],
        ['/me/deactivate', { ...identity, userId: 'other-account' }]
    ];
    for (const [path, body] of cases) {
        const response = await request(path, body);
        assert.equal(response.status, 400, path);
        assert.equal((await response.json()).code, 'invalid_request');
    }
    assert.equal((await request(`/relationships/${socialId}/promote`, identity)).status, 404);
    assert.equal(commands.length, 0);
});

test('social JSON parsing bounds accepted work and hides malformed body content', async t => {
    const { api, commands } = fixtureApi();
    const { base, request } = await listen(t, api);
    const large = await request('/me/deactivate', { ...identity, private: 'secret'.repeat(900) });
    assert.equal(large.status, 413);
    assert.deepEqual(await large.json(), { code: 'request_too_large', message: 'The social request could not be completed.' });
    for (const [body, contentType, status] of [['{"private":"secret"', 'application/json', 400], ['{}', 'text/plain', 415]] as const) {
        const response = await fetch(`${base}/api/social/v1/me/deactivate`, { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': contentType }, body });
        assert.equal(response.status, status);
        assert.doesNotMatch(await response.text(), /secret/);
    }
    const missingType = await fetch(`${base}/api/social/v1/me/deactivate`, { method: 'POST',
        headers: { authorization: 'Bearer synthetic' }, body: Buffer.from('{}') });
    assert.equal(missingType.status, 415);
    assert.equal(commands.length, 0);
});

test('private profile reads and exact lookup return only minimal allowlisted cards', async t => {
    const { api, reads } = fixtureApi();
    api.ownProfile = async () => ({ ...card, active: true, discoverable: false, revision: 9,
        email: 'private@example.test', avatarAssetId: 'private-avatar' });
    api.lookup = async (_who, handle) => { reads.push(['lookup', handle]); return handle === card.handle
        ? { ...card, accountId: 'private-account', activity: 'private-history' } : null; };
    const { request } = await listen(t, api);
    const own = await request('/me/profile');
    assert.deepEqual(await own.json(), { profile: { ...card, active: true, discoverable: false, revision: 9 } });
    const found = await request('/profiles?handle=ALICE_123');
    assert.deepEqual(await found.json(), { profile: card });
    assert.equal(found.headers.get('cache-control'), 'private, no-store');
    assert.match(found.headers.get('vary')!, /Authorization/);
    for (const handle of ['hidden', 'blocked', 'missing']) {
        assert.deepEqual(await (await request(`/profiles?handle=${handle}`)).json(), { profile: null });
    }
    assert.deepEqual(reads[0], ['lookup', 'alice_123']);
    for (const path of ['/profiles', '/profiles?handle=alice&handle=bob', '/profiles?handle=alice&email=private', '/me/profile?userId=other']) {
        assert.equal((await request(path)).status, 400);
    }
});

test('relationship lists parse bounded exact queries and preserve opaque cursors', async t => {
    const { api, reads } = fixtureApi();
    const { request } = await listen(t, api);
    for (const kind of ['friends', 'incoming', 'outgoing', 'blocks']) {
        const response = await request(`/relationships?kind=${kind}`);
        assert.equal(response.status, 200);
        assert.deepEqual(reads.at(-1), ['list', kind, 20, undefined]);
    }
    assert.equal((await request('/relationships?kind=friends&limit=50&cursor=opaque.signature')).status, 200);
    assert.deepEqual(reads.at(-1), ['list', 'friends', 50, 'opaque.signature']);
    for (const query of ['kind=all', 'kind=friends&kind=blocks', 'kind=friends&limit=0', 'kind=friends&limit=51',
        'kind=friends&limit=2.5', 'kind=friends&limit=2&limit=3', 'kind=friends&cursor=',
        `kind=friends&cursor=${'a'.repeat(513)}`, 'kind=friends&cursor=a%20b', 'kind=friends&userId=other']) {
        assert.equal((await request(`/relationships?${query}`)).status, 400, query);
    }
});

test('bootstrap and expired-scope outcome lookup need no replacement mutation scope', async t => {
    const { api, reads } = fixtureApi();
    const { request } = await listen(t, api);
    assert.deepEqual(await (await request('/mutation-scopes', {})).json(), {
        scopeToken: identity.scopeToken, expiresAt: '2026-09-14T00:00:00.000Z'
    });
    assert.deepEqual(await (await request('/mutation-outcomes', identity)).json(), { outcome: { ...result, replayed: true } });
    assert.deepEqual(reads.at(-1), ['outcome', identity]);
    api.outcome = async () => null;
    assert.deepEqual(await (await request('/mutation-outcomes', identity)).json(), { outcome: null });
    assert.equal((await request('/mutation-outcomes', { ...identity, action: 'deactivate' })).status, 400);
});

test('pair-state lookup exposes a reusable revision without projecting a private profile', async t => {
    const { api, commands, reads } = fixtureApi();
    api.relationship = async (_who, targetSocialId) => { reads.push(['relationship', targetSocialId]);
        return { socialId: targetSocialId, state: 'none', revision: 17,
            accountId: 'private-account', profile: card, blockedBy: ['private-other-account'] }; };
    const { request } = await listen(t, api);
    const response = await request(`/relationships/${socialId}`);
    assert.equal(response.status, 200);
    const { relationship } = await response.json();
    assert.deepEqual(relationship, { socialId, state: 'none', revision: 17 });
    assert.deepEqual(reads.at(-1), ['relationship', socialId]);
    assert.equal((await request('/friend-requests', { ...identity, targetSocialId: relationship.socialId,
        expectedRevision: relationship.revision })).status, 200);
    assert.equal(commands.at(-1)?.action, 'request');
    assert.equal((commands.at(-1) as { expectedRevision: number }).expectedRevision, 17);
    api.relationship = async () => null;
    assert.deepEqual(await (await request(`/relationships/${socialId}`)).json(), { relationship: null });
    assert.equal((await request('/relationships/not-a-social-id')).status, 400);
    assert.equal((await request(`/relationships/${socialId}?viewer=other`)).status, 400);
});

test('durable rejected receipts remain status-only HTTP 200 while domain errors retain their status', async t => {
    const { api } = fixtureApi();
    api.mutate = async () => ({ ...result, outcome: 'rejected', code: 'stale_revision', replayed: true,
        privateProfile: card });
    const { request } = await listen(t, api);
    const rejected = await request('/me/deactivate', identity);
    assert.equal(rejected.status, 200);
    assert.deepEqual(await rejected.json(), { ...result, outcome: 'rejected', code: 'stale_revision', replayed: true });
    api.mutate = async () => { throw new SocialError(409, 'idempotency_conflict'); };
    const conflict = await request('/me/deactivate', identity);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { code: 'idempotency_conflict', message: 'The social request could not be completed.' });
    api.mutate = async () => { throw new Error('private-account and secret scope token'); };
    const failed = await request('/me/deactivate', identity);
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /private-account|secret/);
});

test('disabled social admission leaves safety actions and outcome lookup reachable', async t => {
    const { api, commands } = fixtureApi();
    api.admissionEnabled = () => false;
    const { request } = await listen(t, api);
    assert.equal((await request(`/relationships/${socialId}/block`, identity)).status, 200);
    assert.equal((await request(`/relationships/${socialId}/unblock`, { ...identity, expectedRevision: 4 })).status, 200);
    assert.equal((await request('/me/deactivate', identity)).status, 200);
    assert.equal((await request('/mutation-scopes', {})).status, 200);
    assert.equal((await request('/mutation-outcomes', identity)).status, 200);
    assert.deepEqual(commands.map(command => command.action), ['block', 'unblock', 'deactivate']);
    // The service owns per-operation rollout policy so the router cannot accidentally suppress safety work.
    api.lookup = async () => { throw new SocialError(503, 'social_unavailable'); };
    assert.equal((await request('/profiles?handle=alice_123')).status, 503);
});

test('IP rate protection returns a retry delay before invoking further service work', async t => {
    const { api, actors } = fixtureApi();
    const { request } = await listen(t, api);
    for (let i = 0; i < 120; i += 1) assert.equal((await request('/me/profile')).status, 200);
    const response = await request('/me/profile');
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal((await response.json()).code, 'rate_limited');
    assert.equal(actors.length, 120);
});

test('real application mounts social authentication before its general body parser', async t => {
    resetRateLimitWindowsForTests();
    const { base } = await start(t, createApp({ environment: 'test' }));
    const response = await fetch(`${base}/api/social/v1/me/profile`, { method: 'PATCH',
        headers: { 'content-type': 'application/json' }, body: `{"private":"${'x'.repeat(8_000)}` });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control')!, /no-store/);
    assert.doesNotMatch(await response.text(), /private/);
});
