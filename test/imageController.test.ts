import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

import { createApp } from '../src/app';
import { createGetImageVariant } from '../src/controllers/imageController';
import { coverArtVariantEtag } from '../src/services/imageStorageService';

const imageId = '507f1f77bcf86cd799439011';
const asset = {
    ownerType: 'album' as const,
    ownerId: '507f191e810c19729de860ea',
    uploadStatus: 'ready' as const,
    s3Key: `images/${imageId}`,
    contentType: 'image/jpeg'
};

class RequestDouble extends EventEmitter {
    params: Record<string, string>;
    headers: Record<string, string>;
    aborted = false;

    constructor(params: Record<string, string>, headers: Record<string, string> = {}) {
        super();
        this.params = params;
        this.headers = headers;
    }
}

class ResponseDouble extends EventEmitter {
    statusCode = 200;
    writableEnded = false;
    headersSent = false;
    headers = new Map<string, string>();
    body: unknown;
    destroyedWith: unknown;

    setHeader(name: string, value: string | number) {
        this.headers.set(name.toLowerCase(), String(value));
        return this;
    }

    status(statusCode: number) {
        this.statusCode = statusCode;
        return this;
    }

    json(body: unknown) {
        this.body = body;
        this.writableEnded = true;
        return this;
    }

    end(body?: unknown) {
        this.body = body;
        this.writableEnded = true;
        return this;
    }

    destroy(error?: unknown) {
        this.destroyedWith = error;
        return this;
    }
}

const invoke = async (
    handler: ReturnType<typeof createGetImageVariant>,
    params: Record<string, string>,
    headers: Record<string, string> = {}
) => {
    const request = new RequestDouble(params, headers);
    const response = new ResponseDouble();
    let nextError: unknown;
    await handler(
        request as unknown as Request,
        response as unknown as Response,
        ((error?: unknown) => { nextError = error; }) as NextFunction
    );
    return { request, response, nextError };
};

test('variant controller rejects invalid IDs and widths before service work', async () => {
    let serviceCalls = 0;
    const handler = createGetImageVariant({
        getVariant: async () => {
            serviceCalls += 1;
            return null;
        }
    });

    for (const params of [
        { imageId: 'not-an-object-id', width: '320' },
        { imageId, width: '321' },
        { imageId, width: '320px' }
    ]) {
        const { response, nextError } = await invoke(handler, params);
        assert.equal(response.statusCode, 400);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.equal(nextError, undefined);
    }
    assert.equal(serviceCalls, 0);
});

test('variant controller keeps unavailable or detached images non-cacheable', async () => {
    const handler = createGetImageVariant({ getVariant: async () => null });
    const { response, nextError } = await invoke(handler, { imageId, width: '192' });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { message: 'Image not found.' });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(nextError, undefined);
});

test('variant controller revalidates a 304 with its v1 ETag', async () => {
    const etag = coverArtVariantEtag(imageId, 640);
    let received: any;
    const handler = createGetImageVariant({
        getVariant: async (...args) => {
            received = args;
            return { asset, etag, notModified: true };
        }
    });
    const { response, nextError } = await invoke(
        handler,
        { imageId, width: '640' },
        { 'if-none-match': etag }
    );

    assert.equal(received[0], imageId);
    assert.equal(received[1], 640);
    assert.equal(received[2].ifNoneMatch, etag);
    assert.equal(typeof received[3].attachSource, 'function');
    assert.equal(response.statusCode, 304);
    assert.equal(response.body, undefined);
    assert.equal(response.headers.get('cache-control'), 'public, no-cache');
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('etag'), etag);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(nextError, undefined);
});

test('variant controller returns transformed bytes with revalidation headers', async () => {
    const body = Buffer.from('webp-variant');
    const etag = coverArtVariantEtag(imageId, 96);
    const handler = createGetImageVariant({
        getVariant: async () => ({ asset, body, etag, notModified: false })
    });
    const { response, nextError } = await invoke(handler, { imageId, width: '96' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, body);
    assert.equal(response.headers.get('cache-control'), 'public, no-cache');
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('content-length'), String(body.length));
    assert.equal(response.headers.get('etag'), etag);
    assert.equal(nextError, undefined);
});

test('variant controller forwards processing failures before response headers are sent', async () => {
    const expected = new Error('transform failed');
    const handler = createGetImageVariant({
        getVariant: async () => { throw expected; }
    });
    const { response, nextError } = await invoke(handler, { imageId, width: '320' });

    assert.equal(nextError, expected);
    assert.equal(response.headersSent, false);
    assert.equal(response.destroyedWith, undefined);
});

test('content routing exposes the v1 derivative path without replacing the original path', async () => {
    const app = createApp({
        listenerDistPath: path.join(os.tmpdir(), 'archtree-image-route-test-missing')
    });
    const server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const invalidId = await fetch(`${baseUrl}/content/images/not-an-id/v1/96.webp`);
        const invalidWidth = await fetch(`${baseUrl}/content/images/${imageId}/v1/97.webp`);
        const original = await fetch(`${baseUrl}/content/images/not-an-id`);

        assert.equal(invalidId.status, 400);
        assert.equal(invalidWidth.status, 400);
        assert.equal(original.status, 400);
        assert.equal(invalidId.headers.get('cache-control'), 'private, no-store');
        assert.equal(invalidWidth.headers.get('cache-control'), 'private, no-store');
        assert.equal(original.headers.get('cache-control'), 'private, no-store');
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});
