import assert from 'node:assert/strict';
import test from 'node:test';
import type { Response } from 'express';

import {
    requireCurrentAccountViewer,
    type AuthenticatedRequest
} from '../src/middleware/authMiddleware';

const requestFor = (requestedViewer?: string) => ({
    auth: { userId: 'listener-1', email: 'listener@example.com', role: 'user' },
    get: (name: string) => name.toLowerCase() === 'x-finitude-account-viewer'
        ? requestedViewer
        : undefined
}) as AuthenticatedRequest;

const responseCapture = () => {
    const capture: { statusCode: number; body?: unknown } = { statusCode: 200 };
    const response = {
        status(code: number) {
            capture.statusCode = code;
            return response;
        },
        json(body: unknown) {
            capture.body = body;
            return response;
        }
    } as unknown as Response;
    return { capture, response };
};

test('account viewer guard preserves native clients and matching Web actions', () => {
    for (const requestedViewer of [undefined, 'listener-1']) {
        const { response } = responseCapture();
        let proceeded = false;
        requireCurrentAccountViewer(
            requestFor(requestedViewer),
            response,
            () => { proceeded = true; }
        );
        assert.equal(proceeded, true);
    }
});

test('account viewer guard rejects an action from a stale Web identity', () => {
    const { capture, response } = responseCapture();
    let proceeded = false;
    requireCurrentAccountViewer(
        requestFor('listener-2'),
        response,
        () => { proceeded = true; }
    );
    assert.equal(proceeded, false);
    assert.equal(capture.statusCode, 409);
    assert.deepEqual(capture.body, {
        message: 'The active account changed. Refresh the account before trying again.'
    });
});
