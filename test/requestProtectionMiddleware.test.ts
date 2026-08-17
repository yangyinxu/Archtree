import assert from 'node:assert/strict';
import test from 'node:test';

import {
    contentManagerUploadRateLimit,
    resetRateLimitWindowsForTests
} from '../src/middleware/requestProtectionMiddleware';

const responseCapture = () => {
    const capture: {
        status?: number;
        type?: string;
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
        type(value: string) {
            capture.type = value;
            return this;
        },
        send(value: unknown) {
            capture.body = value;
            return this;
        }
    };
    return { capture, response };
};

test('Content Manager upload throttling returns a browser recovery surface with retry headers', () => {
    resetRateLimitWindowsForTests();
    const request = { ip: '203.0.113.10', socket: {} };
    let accepted = 0;
    for (let index = 0; index < 20; index += 1) {
        const { capture, response } = responseCapture();
        contentManagerUploadRateLimit(request as any, response as any, () => { accepted += 1; });
        assert.equal(capture.status, undefined);
    }
    const rejected = responseCapture();
    contentManagerUploadRateLimit(request as any, rejected.response as any, () => {
        throw new Error('The 21st upload must not continue.');
    });

    assert.equal(accepted, 20);
    assert.equal(rejected.capture.status, 429);
    assert.equal(rejected.capture.type, 'html');
    assert.match(String(rejected.capture.body), /Upload temporarily limited/);
    assert.match(String(rejected.capture.body), /No catalog changes were made/);
    assert.equal(Number(rejected.capture.headers['Retry-After']) > 0, true);
    assert.equal(rejected.capture.headers['RateLimit-Limit'], 20);
    assert.equal(rejected.capture.headers['RateLimit-Remaining'], 0);
});
