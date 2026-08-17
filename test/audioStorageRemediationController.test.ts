import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

import {
    postAudioMissingTrackDelete,
    postAudioOrphanDelete,
    postAudioPublicationRetry
} from '../src/controllers/adminController';

const responseCapture = () => {
    const capture: { statusCode: number; body?: any; redirect?: string; headers: Record<string, string> } = {
        statusCode: 200,
        headers: {}
    };
    const response = {
        setHeader(name: string, value: string) { capture.headers[name] = value; },
        status(statusCode: number) { capture.statusCode = statusCode; return response; },
        json(body: unknown) { capture.body = body; return response; },
        redirect(statusCode: number, location: string) {
            capture.statusCode = statusCode;
            capture.redirect = location;
            return response;
        }
    } as unknown as Response;
    return { capture, response };
};

test('invalid orphan deletion stays JSON for API requests', async () => {
    const { capture, response } = responseCapture();
    let nextError: unknown;
    await postAudioOrphanDelete({
        body: { s3Key: 'images/not-audio' },
        is: () => false
    } as unknown as Request, response, ((error?: unknown) => { nextError = error; }) as NextFunction);

    assert.equal(nextError, undefined);
    assert.equal(capture.statusCode, 400);
    assert.equal(capture.body.code, 'invalid_audio_storage_key');
    assert.equal(capture.headers['Cache-Control'], 'no-store');
});

test('browser remediation failures redirect back to the audit with a safe message', async () => {
    const { capture, response } = responseCapture();
    await postAudioOrphanDelete({
        body: { s3Key: 'images/not-audio' },
        is: (contentType: string) => contentType === 'application/x-www-form-urlencoded'
            ? contentType
            : false
    } as unknown as Request, response, (() => undefined) as NextFunction);

    assert.equal(capture.statusCode, 303);
    assert.match(capture.redirect ?? '', /^\/admin\/audio-storage\/reconciliation\?/);
    assert.match(capture.redirect ?? '', /error=1/);
    assert.doesNotMatch(capture.redirect ?? '', /images\/not-audio/);
});

test('failed browser publication retry returns to the same guided audit', async () => {
    const { capture, response } = responseCapture();
    await postAudioPublicationRetry({
        body: { audioTrackIds: '' },
        is: () => 'application/x-www-form-urlencoded'
    } as unknown as Request, response, (() => undefined) as NextFunction);

    assert.equal(capture.statusCode, 303);
    assert.match(capture.redirect ?? '', /0%20publications%20completed/);
    assert.match(capture.redirect ?? '', /error=1/);
});

test('invalid MongoDB-only browser deletion returns to the audit without exposing input', async () => {
    const { capture, response } = responseCapture();
    await postAudioMissingTrackDelete({
        body: { audioTrackId: 'not-an-id', expectedS3Key: 'unsafe-key' },
        is: () => 'application/x-www-form-urlencoded'
    } as unknown as Request, response, (() => undefined) as NextFunction);

    assert.equal(capture.statusCode, 303);
    assert.match(capture.redirect ?? '', /error=1/);
    assert.doesNotMatch(capture.redirect ?? '', /not-an-id|unsafe-key/);
    assert.equal(capture.headers['Cache-Control'], 'no-store');
});
