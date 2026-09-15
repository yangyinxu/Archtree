import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import {
    resetRateLimitWindowsForTests,
    uploadRateLimit,
    searchConcurrencyLimit,
    roomAudioAnalysisConcurrencyLimit,
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
