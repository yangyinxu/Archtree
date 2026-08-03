import assert from 'node:assert/strict';
import test from 'node:test';
import type { Response } from 'express';

import {
    requireAdmin,
    requireAdminForWeb,
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
    const capture: {
        statusCode: number;
        body?: unknown;
        contentType?: string;
        headers: Record<string, string | string[]>;
    } = { statusCode: 200, headers: {} };
    const response = {
        status(code: number) {
            capture.statusCode = code;
            return response;
        },
        type(contentType: string) {
            capture.contentType = contentType;
            return response;
        },
        setHeader(name: string, value: string | string[]) {
            capture.headers[name.toLowerCase()] = value;
            return response;
        },
        json(body: unknown) {
            capture.body = body;
            return response;
        },
        send(body: unknown) {
            capture.body = body;
            return response;
        }
    } as unknown as Response;
    return { capture, response };
};

const adminRequestFor = (role?: unknown) => ({
    ...(role === undefined
        ? {}
        : { auth: { userId: 'account-1', email: 'account@example.com', role } })
}) as unknown as AuthenticatedRequest;

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

test('API admin guard grants only the exact admin role', () => {
    for (const role of ['user', 'creator', 'ADMIN', ' admin ', '', null]) {
        const { capture, response } = responseCapture();
        let proceeded = false;
        requireAdmin(adminRequestFor(role), response, () => { proceeded = true; });
        assert.equal(proceeded, false, `role ${String(role)} must fail closed`);
        assert.equal(capture.statusCode, 403);
        assert.deepEqual(capture.body, { message: 'Administrator access is required.' });
    }

    const { response } = responseCapture();
    let proceeded = false;
    requireAdmin(adminRequestFor('admin'), response, () => { proceeded = true; });
    assert.equal(proceeded, true);
});

test('API admin guard rejects requests without authenticated context', () => {
    const { capture, response } = responseCapture();
    let proceeded = false;
    requireAdmin(adminRequestFor(), response, () => { proceeded = true; });
    assert.equal(proceeded, false);
    assert.equal(capture.statusCode, 401);
    assert.deepEqual(capture.body, { message: 'Missing or invalid credentials.' });
});

test('Web admin guard returns a private plain-text denial for ordinary users', () => {
    const { capture, response } = responseCapture();
    let proceeded = false;
    requireAdminForWeb(adminRequestFor('user'), response, () => { proceeded = true; });
    assert.equal(proceeded, false);
    assert.equal(capture.statusCode, 403);
    assert.equal(capture.contentType, 'text/plain');
    assert.equal(capture.body, 'Administrator access is required.');
    assert.equal(capture.headers['cache-control'], 'no-store');
    assert.equal(capture.headers.pragma, 'no-cache');
});

test('Web admin guard accepts an authenticated administrator', () => {
    const { response } = responseCapture();
    let proceeded = false;
    requireAdminForWeb(adminRequestFor('admin'), response, () => { proceeded = true; });
    assert.equal(proceeded, true);
});
