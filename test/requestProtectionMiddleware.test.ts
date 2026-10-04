import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import {
    accountOrClientKey,
    authEmailAccountRateLimit,
    authRateLimit,
    rateLimit,
    refreshClientRateLimit,
    refreshCredentialRateLimit,
    resetRateLimitWindowsForTests,
    uploadRateLimit,
    searchConcurrencyLimit,
    roomAudioAnalysisConcurrencyLimit,
    takeLimiterRejections,
    uploadConcurrencyLimit
} from '../src/middleware/requestProtectionMiddleware';

const responseCapture = () => {
    const capture: {
        status?: number;
        body?: unknown;
        headers: Record<string, string | number>;
    } = { headers: {} };
    const response = {
        setHeader(name: string, value: string | number) {
            capture.headers[name] = value;
            return this;
        },
        status(value: number) {
            capture.status = value;
            return this;
        },
        json(value: unknown) {
            capture.body = value;
            return this;
        }
    };
    return { capture, response };
};

test('account-owned upload mutations retain their hourly abuse-protection quota', () => {
    resetRateLimitWindowsForTests();
    const request = { ip: '203.0.113.10', socket: {} };
    let accepted = 0;
    for (let index = 0; index < 20; index += 1) {
        const { capture, response } = responseCapture();
        uploadRateLimit(request as any, response as any, () => { accepted += 1; });
        assert.equal(capture.status, undefined);
    }
    const rejected = responseCapture();
    uploadRateLimit(request as any, rejected.response as any, () => {
        throw new Error('The 21st upload must not continue.');
    });

    assert.equal(accepted, 20);
    assert.equal(rejected.capture.status, 429);
    assert.deepEqual(rejected.capture.body, {
        message: 'Too many requests. Please try again later.'
    });
    assert.equal(Number(rejected.capture.headers['Retry-After']) > 0, true);
    assert.equal(rejected.capture.headers['RateLimit-Limit'], 20);
    assert.equal(rejected.capture.headers['RateLimit-Remaining'], 0);
    assert.equal(typeof rejected.capture.headers['RateLimit-Reset'], 'number');
});

test('email account limits key only on the validated email and skip requests without one', () => {
    resetRateLimitWindowsForTests();
    const invoke = (body: Record<string, unknown>) => {
        const { capture, response } = responseCapture();
        let admitted = false;
        authEmailAccountRateLimit({ ip: '203.0.113.20', socket: {}, body } as any, response as any, () => {
            admitted = true;
        });
        return { admitted, capture };
    };

    // A missing email cannot resolve an account, so it neither counts nor is rejected here.
    for (let index = 0; index < 12; index += 1) {
        assert.equal(invoke({ identifier: 'lorem.ipsum@example.test', username: 'lorem' }).admitted, true);
    }
    for (let index = 0; index < 10; index += 1) {
        assert.equal(invoke({
            email: ' Lorem.Ipsum@Example.Test ',
            identifier: `probe-${index}@example.test`,
            username: `probe-${index}`
        }).admitted, true);
    }
    const rejected = invoke({ email: 'lorem.ipsum@example.test', identifier: 'fresh@example.test' });
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.capture.status, 429);
    assert.deepEqual(rejected.capture.body, { message: 'Too many requests. Please try again later.' });
    assert.equal(Number(rejected.capture.headers['Retry-After']) > 0, true);
    assert.equal(invoke({ email: 'dolor.sit@example.test' }).admitted, true);
});

test('refresh credential limits key on the presented token digest and fall back to the client address', () => {
    resetRateLimitWindowsForTests();
    const invoke = (ip: string, body: Record<string, unknown>) => {
        const { capture, response } = responseCapture();
        let admitted = false;
        refreshCredentialRateLimit({ ip, socket: {}, body } as any, response as any, () => {
            admitted = true;
        });
        return { admitted, capture };
    };

    // Ten presentations of one token from different addresses share its budget.
    for (let index = 0; index < 10; index += 1) {
        assert.equal(invoke(`198.51.100.${index}`, { refreshToken: 'lorem-ipsum-token' }).admitted, true);
    }
    const rejected = invoke('198.51.100.99', { refreshToken: 'lorem-ipsum-token' });
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.capture.status, 429);
    assert.deepEqual(rejected.capture.body, { message: 'Too many requests. Please try again later.' });
    assert.equal(Number(rejected.capture.headers['Retry-After']) > 0, true);
    assert.equal(invoke('198.51.100.0', { refreshToken: 'dolor-sit-token' }).admitted, true,
        'listeners behind one address keep separate token budgets');

    // Missing, non-string, and oversized tokens fall back to one per-address bucket.
    for (const body of [{}, { refreshToken: ['lorem'] }, { refreshToken: 'x'.repeat(513) }]) {
        for (let index = 0; index < 3; index += 1) {
            assert.equal(invoke('203.0.113.30', body).admitted, true);
        }
    }
    assert.equal(invoke('203.0.113.30', {}).admitted, true);
    assert.equal(invoke('203.0.113.30', {}).capture.status, 429);
    assert.equal(invoke('203.0.113.31', {}).admitted, true);
});

test('refresh and login draw from separate per-address buckets without loosening login', () => {
    resetRateLimitWindowsForTests();
    const request = { ip: '203.0.113.40', socket: {} };
    const admit = (limiter: typeof authRateLimit) => {
        const { capture, response } = responseCapture();
        let admitted = false;
        limiter(request as any, response as any, () => { admitted = true; });
        return { admitted, capture };
    };

    for (let index = 0; index < 20; index += 1) assert.equal(admit(authRateLimit).admitted, true);
    const login = admit(authRateLimit);
    assert.equal(login.capture.status, 429, 'login keeps 20 attempts per 15 minutes');
    assert.equal(login.capture.headers['RateLimit-Limit'], 20);

    for (let index = 0; index < 600; index += 1) assert.equal(admit(refreshClientRateLimit).admitted, true);
    const refresh = admit(refreshClientRateLimit);
    assert.equal(refresh.capture.status, 429, 'refresh still has a per-address ceiling');
    assert.equal(refresh.capture.headers['RateLimit-Limit'], 600);
});

test('account-keyed windows separate accounts on one IP and fall back to the IP without an account', () => {
    resetRateLimitWindowsForTests();
    const limiter = rateLimit('account-key-test', 2, 60_000, undefined, accountOrClientKey);
    const invoke = (ip: string, userId?: string) => {
        const { capture, response } = responseCapture();
        let admitted = false;
        limiter({ ip, socket: {}, ...(userId ? { auth: { userId } } : {}) } as any, response as any, () => { admitted = true; });
        return { admitted, capture };
    };
    const sharedAddress = '203.0.113.30';
    assert.equal(invoke(sharedAddress, 'lorem-account').admitted, true);
    assert.equal(invoke('198.51.100.30', 'lorem-account').admitted, true);
    // A new address cannot refill an account budget.
    assert.equal(invoke('192.0.2.30', 'lorem-account').capture.status, 429);
    assert.equal(invoke(sharedAddress, 'ipsum-account').admitted, true);
    assert.equal(invoke(sharedAddress).admitted, true);
    assert.equal(invoke(sharedAddress).admitted, true);
    assert.equal(invoke(sharedAddress).capture.status, 429);
    assert.equal(invoke(sharedAddress, 'ipsum-account').admitted, true);
    // An address that spells an account ID still draws from its own IP window.
    assert.equal(invoke('dolor-account').admitted, true);
    assert.equal(invoke(sharedAddress, 'dolor-account').admitted, true);
    assert.equal(accountOrClientKey({ ip: sharedAddress, socket: {} } as any), `ip:${sharedAddress}`);
    assert.equal(accountOrClientKey({ ip: sharedAddress, socket: {}, auth: { userId: 'lorem-account' } } as any), 'account:lorem-account');
});

test('analysis capacity bounds different administrators independently from upload capacity', () => {
    const responses: EventEmitter[] = [];
    const invoke = (ip: string, limiter = roomAudioAnalysisConcurrencyLimit) => {
        const { capture, response } = responseCapture();
        const events = Object.assign(new EventEmitter(), response);
        responses.push(events);
        let admitted = false;
        limiter({ ip, socket: {} } as any, events as any, () => { admitted = true; });
        return { admitted, capture, events };
    };
    try {
        const analysis = invoke('analysis-admin-a');
        assert.equal(analysis.admitted, true);
        assert.equal(invoke('analysis-admin-b').capture.status, 429);
        assert.equal(invoke('analysis-admin-a', uploadConcurrencyLimit).admitted, true);
        analysis.events.emit('finish');
        assert.equal(invoke('analysis-admin-b').admitted, true);
    } finally { for (const response of responses) response.emit('close'); }
});

test('search has shared process and per-client bounds and releases finished capacity', () => {
    const open: EventEmitter[] = [];
    const invoke = (ip: string) => {
        const { capture, response } = responseCapture();
        const events = Object.assign(new EventEmitter(), response);
        let admitted = false;
        searchConcurrencyLimit({ ip, socket: {} } as any, events as any, () => { admitted = true; });
        if (admitted) open.push(events);
        return { admitted, capture, events };
    };
    try {
        assert.equal(invoke('client-a').admitted, true);
        assert.equal(invoke('client-a').admitted, true);
        assert.equal(invoke('client-a').capture.status, 429);
        for (let index = 0; index < 6; index++) assert.equal(invoke(`client-${index}`).admitted, true);
        assert.equal(invoke('client-b').capture.status, 429);
        open[0].emit('finish');
        open[0].emit('close');
        assert.equal(invoke('client-b').admitted, true);
        assert.equal(invoke('client-c').capture.status, 429);
    } finally { for (const response of open) response.emit('close'); }
});

test('every limiter 429 is counted per fixed scope for the operations summary and reset when taken', () => {
    resetRateLimitWindowsForTests();
    const request = { ip: '203.0.113.40', socket: {}, body: { email: 'counted@example.test' } };
    const window = rateLimit('synthetic-window', 1, 60_000);
    for (let index = 0; index < 3; index += 1) window(request as any, responseCapture().response as any, () => undefined);
    for (let index = 0; index < 11; index += 1) authEmailAccountRateLimit(request as any, responseCapture().response as any, () => undefined);
    const open: EventEmitter[] = [];
    try {
        for (let index = 0; index < 3; index += 1) {
            const events = Object.assign(new EventEmitter(), responseCapture().response);
            searchConcurrencyLimit({ ip: '203.0.113.41', socket: {} } as any, events as any, () => { open.push(events); });
        }
    } finally { for (const response of open) response.emit('close'); }
    const taken = takeLimiterRejections();
    assert.deepEqual(taken, { 'auth-account': 1, 'catalog-search': 1, 'synthetic-window': 2 });
    assert.doesNotMatch(JSON.stringify(taken), /203\.0\.113|counted@/);
    assert.deepEqual(takeLimiterRejections(), {});
});

test('limiter rejection counts keep a bounded number of scopes', () => {
    resetRateLimitWindowsForTests();
    for (let index = 0; index < 100; index += 1) {
        const limiter = rateLimit(`synthetic-scope-${index}`, 0, 60_000);
        limiter({ ip: '203.0.113.42', socket: {} } as any, responseCapture().response as any, () => undefined);
    }
    assert.equal(Object.keys(takeLimiterRejections()).length, 64);
});
