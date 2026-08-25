import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resetRateLimitWindowsForTests,
    uploadRateLimit
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
