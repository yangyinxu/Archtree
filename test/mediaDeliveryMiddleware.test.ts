import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

import {
    createMediaAdmissionController,
    MediaAdmissionController,
    observeMediaDeliveryFor
} from '../src/middleware/mediaDeliveryMiddleware';
import {
    createMediaDeliveryMetricsRegistry,
    MediaResourceClass
} from '../src/services/mediaDeliveryService';
import { runRequestWork } from '../src/services/serverLifecycleService';

class TestResponse extends EventEmitter {
    statusCode = 200;
    writableEnded = false;
    destroyed = false;
    locals: Record<string, unknown> = {};
    headers = new Map<string, string>();
    body: unknown;

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
        this.emit('finish');
        return this;
    }

    finish(statusCode = this.statusCode) {
        this.statusCode = statusCode;
        this.writableEnded = true;
        this.emit('finish');
    }

    abort() {
        this.destroyed = true;
        this.emit('close');
    }
}

const requestFor = (ip: string) => ({
    method: 'GET',
    ip,
    socket: { remoteAddress: ip }
}) as unknown as Request;

const requestMedia = (
    controller: MediaAdmissionController,
    resourceClass: MediaResourceClass,
    ip: string,
    method = 'GET'
) => {
    const response = new TestResponse();
    const request = requestFor(ip);
    request.method = method;
    let admitted = false;
    controller.middleware(resourceClass)(
        request,
        response as unknown as Response,
        (() => {
            admitted = true;
        }) as NextFunction
    );
    return { response, request, get admitted() { return admitted; } };
};

test('derives the reviewed playback reserve from the existing default pool size', () => {
    const controller = createMediaAdmissionController({
        globalLimit: 40,
        perIpLimit: 8,
        metrics: createMediaDeliveryMetricsRegistry()
    });

    assert.deepEqual(controller.limits, {
        global: 40,
        perIp: 8,
        playbackReservedGlobal: 16,
        playbackReservedPerIp: 2
    });
});

test('reserves per-client and global capacity for active playback', () => {
    const metrics = createMediaDeliveryMetricsRegistry();
    const controller = createMediaAdmissionController({
        globalLimit: 4,
        perIpLimit: 3,
        playbackReservedGlobal: 2,
        playbackReservedPerIp: 1,
        metrics
    });
    const ip = '203.0.113.44';

    const artwork = requestMedia(controller, 'artwork', ip);
    const avatar = requestMedia(controller, 'avatar', ip);
    const video = requestMedia(controller, 'video', ip);
    const playback = requestMedia(controller, 'playback', ip);

    assert.equal(artwork.admitted, true);
    assert.equal(avatar.admitted, true);
    assert.equal(video.admitted, true);
    assert.equal(playback.admitted, false);
    assert.equal(playback.response.statusCode, 429);
    assert.equal(playback.response.headers.get('retry-after'), '2');
    assert.deepEqual(playback.response.body, {
        message: 'Too many concurrent media requests.'
    });

    const active = controller.getMetrics();
    assert.equal(active.activeRequests, 3);
    assert.equal(active.byResource.video.activeRequests, 1);
    assert.equal(active.byResource.playback.rejectionReasons.perIp, 1);
    assert.deepEqual(active.limits, {
        global: 4,
        perIp: 3,
        playbackReservedGlobal: 2,
        playbackReservedPerIp: 1
    });
    assert.equal(JSON.stringify(active).includes(ip), false);

    artwork.response.finish(200);
    avatar.response.finish(304);
    video.response.finish(206);
    // A later close event must not release or count the same request twice.
    video.response.emit('close');

    const finished = controller.getMetrics();
    assert.equal(finished.activeRequests, 0);
    assert.equal(finished.responseOutcomes.success, 3);
    assert.equal(finished.byResource.video.responseOutcomes.success, 1);
});

test('the shared non-playback ceiling cannot consume the global playback reserve', () => {
    const metrics = createMediaDeliveryMetricsRegistry();
    const controller = createMediaAdmissionController({
        globalLimit: 3,
        perIpLimit: 3,
        playbackReservedGlobal: 1,
        playbackReservedPerIp: 0,
        metrics
    });

    const artwork = requestMedia(controller, 'artwork', '198.51.100.1');
    const download = requestMedia(controller, 'download', '198.51.100.2');
    const avatar = requestMedia(controller, 'avatar', '198.51.100.3');
    const video = requestMedia(controller, 'video', '198.51.100.3');

    assert.equal(artwork.admitted, true);
    assert.equal(download.admitted, true);
    assert.equal(avatar.admitted, false);
    assert.equal(video.admitted, true);
    assert.equal(
        controller.getMetrics().byResource.avatar.rejectionReasons.playbackReserved,
        1
    );

    artwork.response.finish();
    download.response.finish();
    video.response.finish();
});

test('reports total and per-client rejection reasons independently', () => {
    const metrics = createMediaDeliveryMetricsRegistry();
    const controller = createMediaAdmissionController({
        globalLimit: 2,
        perIpLimit: 1,
        playbackReservedGlobal: 0,
        playbackReservedPerIp: 0,
        metrics
    });

    const first = requestMedia(controller, 'playback', '192.0.2.1');
    const sameClient = requestMedia(controller, 'playback', '192.0.2.1');
    const second = requestMedia(controller, 'playback', '192.0.2.2');
    const overGlobal = requestMedia(controller, 'playback', '192.0.2.3');

    assert.equal(first.admitted, true);
    assert.equal(sameClient.admitted, false);
    assert.equal(second.admitted, true);
    assert.equal(overGlobal.admitted, false);
    const snapshot = controller.getMetrics();
    assert.equal(snapshot.rejectionReasons.perIp, 1);
    assert.equal(snapshot.rejectionReasons.global, 1);

    first.response.finish();
    second.response.finish();
});

test('an aborted response releases its slot and records an anonymous terminal outcome', () => {
    const metrics = createMediaDeliveryMetricsRegistry();
    const controller = createMediaAdmissionController({
        globalLimit: 2,
        perIpLimit: 2,
        playbackReservedGlobal: 1,
        playbackReservedPerIp: 1,
        metrics
    });
    const ip = '192.0.2.90';
    const first = requestMedia(controller, 'artwork', ip);
    assert.equal(first.admitted, true);

    first.response.abort();
    const afterAbort = controller.getMetrics();
    assert.equal(afterAbort.activeRequests, 0);
    assert.equal(afterAbort.byResource.artwork.responseOutcomes.aborted, 1);

    const replacement = requestMedia(controller, 'artwork', ip);
    assert.equal(replacement.admitted, true);
    replacement.response.finish();
});

test('independently scheduled artwork remains observable without consuming playback admission', () => {
    const metrics = createMediaDeliveryMetricsRegistry();
    const responses = Array.from({ length: 10 }, (_, index) => {
        const response = new TestResponse();
        let observed = false;
        observeMediaDeliveryFor('artwork', metrics)(
            requestFor(`198.51.100.${index + 1}`),
            response as unknown as Response,
            (() => { observed = true; }) as NextFunction
        );
        assert.equal(observed, true);
        assert.equal(response.statusCode, 200);
        return response;
    });

    assert.equal(metrics.snapshot().byResource.artwork.activeRequests, 10);
    for (const response of responses) response.finish();
    assert.equal(metrics.snapshot().byResource.artwork.activeRequests, 0);
    assert.equal(metrics.snapshot().byResource.artwork.responseOutcomes.success, 10);
});

test('replacement playback waits for an existing slot without raising active ceilings', () => {
    const controller = createMediaAdmissionController({ globalLimit: 2, perIpLimit: 2, playbackWaitMs: 100 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    const second = requestMedia(controller, 'video', '192.0.2.1');
    const replacement = requestMedia(controller, 'playback', '192.0.2.1');
    assert.equal(replacement.admitted, false);
    assert.equal(controller.getQueuedPlaybackRequests(), 1);
    assert.equal(controller.getMetrics().activeRequests, 2);
    first.response.finish();
    assert.equal(replacement.admitted, true);
    assert.equal(controller.getQueuedPlaybackRequests(), 0);
    assert.equal(controller.getMetrics().activeRequests, 2);
    second.response.finish(); replacement.response.finish();
    assert.equal(controller.getMetrics().activeRequests, 0);
});

test('disconnect retains an active slot until its admitted storage work settles', async () => {
    const controller = createMediaAdmissionController({ globalLimit: 1, perIpLimit: 1, playbackWaitMs: 100 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    let settle!: () => void;
    const work = runRequestWork(first.request, () => new Promise<void>(resolve => { settle = resolve; }));
    await Promise.resolve();
    const replacement = requestMedia(controller, 'playback', '192.0.2.1');
    first.response.abort();
    assert.equal(replacement.admitted, false);
    assert.equal(controller.getMetrics().activeRequests, 1);
    settle(); await work;
    assert.equal(replacement.admitted, true);
    assert.equal(controller.getMetrics().responseOutcomes.aborted, 1);
    replacement.response.finish();
    assert.equal(controller.getMetrics().activeRequests, 0);
});

test('queued disconnect detaches work and does not consume a later slot', () => {
    const controller = createMediaAdmissionController({ globalLimit: 1, perIpLimit: 1, playbackWaitMs: 100 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    const cancelled = requestMedia(controller, 'playback', '192.0.2.1');
    cancelled.response.abort();
    assert.equal(controller.getQueuedPlaybackRequests(), 0);
    assert.equal(cancelled.response.listenerCount('finish'), 0);
    first.response.finish();
    assert.equal(cancelled.admitted, false);
    assert.equal(controller.getMetrics().activeRequests, 0);
});

test('playback queues are bounded and deadline rejection retains Retry-After', async () => {
    const controller = createMediaAdmissionController({ globalLimit: 1, perIpLimit: 1,
        playbackWaitMs: 20, playbackQueueGlobal: 1, playbackQueuePerIp: 1 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    const queued = requestMedia(controller, 'playback', '192.0.2.1');
    const overflow = requestMedia(controller, 'playback', '192.0.2.1');
    assert.equal(overflow.response.statusCode, 429);
    assert.equal(controller.getQueuedPlaybackRequests(), 1);
    await once(queued.response, 'finish');
    assert.equal(queued.response.statusCode, 429);
    assert.equal(queued.response.headers.get('retry-after'), '2');
    assert.equal(controller.getQueuedPlaybackRequests(), 0);
    first.response.finish();
    assert.equal(queued.admitted, false);
    assert.equal(controller.getMetrics().activeRequests, 0);
});

test('a blocked client does not starve a later queued client with capacity', () => {
    const controller = createMediaAdmissionController({ globalLimit: 2, perIpLimit: 1, playbackWaitMs: 100 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    const second = requestMedia(controller, 'playback', '192.0.2.2');
    const blocked = requestMedia(controller, 'playback', '192.0.2.1');
    const available = requestMedia(controller, 'playback', '192.0.2.3');
    second.response.finish();
    assert.equal(blocked.admitted, false); assert.equal(available.admitted, true);
    first.response.finish(); assert.equal(blocked.admitted, true);
    blocked.response.finish(); available.response.finish();
    assert.equal(controller.getQueuedPlaybackRequests(), 0);
});

test('HEAD and non-playback requests reject immediately instead of joining the playback queue', () => {
    const controller = createMediaAdmissionController({ globalLimit: 1, perIpLimit: 1, playbackWaitMs: 100 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    for (const [resourceClass, method] of [
        ['playback', 'HEAD'], ['video', 'HEAD'], ['download', 'GET'], ['artwork', 'GET'], ['avatar', 'GET']
    ] as const) {
        const rejected = requestMedia(controller, resourceClass, '192.0.2.1', method);
        assert.equal(rejected.admitted, false);
        assert.equal(rejected.response.statusCode, 429);
        assert.equal(controller.getQueuedPlaybackRequests(), 0);
    }
    first.response.finish();
});

test('a per-client pending bound leaves the remaining queue available to another client', () => {
    const controller = createMediaAdmissionController({ globalLimit: 1, perIpLimit: 1,
        playbackWaitMs: 100, playbackQueueGlobal: 3, playbackQueuePerIp: 1 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    const queued = requestMedia(controller, 'playback', '192.0.2.1');
    const overflow = requestMedia(controller, 'playback', '192.0.2.1');
    const otherClient = requestMedia(controller, 'video', '192.0.2.2');
    assert.equal(overflow.response.statusCode, 429);
    assert.equal(controller.getQueuedPlaybackRequests(), 2);
    first.response.finish();
    assert.equal(queued.admitted, true);
    assert.equal(otherClient.admitted, false);
    queued.response.finish();
    assert.equal(otherClient.admitted, true);
    otherClient.response.finish();
    assert.equal(controller.getQueuedPlaybackRequests(), 0);
});

test('closed transports cannot queue or dispatch work', () => {
    const controller = createMediaAdmissionController({ globalLimit: 1, perIpLimit: 1, playbackWaitMs: 100 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    for (const closedState of ['aborted', 'destroyed', 'ended'] as const) {
        const request = requestFor('192.0.2.1');
        const response = new TestResponse();
        if (closedState === 'aborted') request.aborted = true;
        if (closedState === 'destroyed') response.destroyed = true;
        if (closedState === 'ended') response.writableEnded = true;
        let dispatched = false;
        controller.middleware('playback')(request, response as unknown as Response,
            () => { dispatched = true; });
        assert.equal(dispatched, false);
        assert.equal(controller.getQueuedPlaybackRequests(), 0);
        assert.equal(response.listenerCount('close'), 0);
    }
    first.response.finish();
});

test('source validation occurs after admission and sees changes made while queued', () => {
    const controller = createMediaAdmissionController({ globalLimit: 1, perIpLimit: 1, playbackWaitMs: 100 });
    const first = requestMedia(controller, 'playback', '192.0.2.1');
    const response = new TestResponse();
    let currentRevision = 'original';
    let validations = 0;
    let storageReads = 0;
    controller.middleware('playback')(requestFor('192.0.2.1'), response as unknown as Response, () => {
        validations++;
        if (currentRevision !== 'original') {
            response.status(409).json({ message: 'The media source changed.' });
            return;
        }
        storageReads++;
    });
    assert.equal(validations, 0);
    assert.equal(storageReads, 0);
    currentRevision = 'replacement';
    first.response.finish();
    assert.equal(validations, 1);
    assert.equal(storageReads, 0);
    assert.equal(response.statusCode, 409);
    assert.equal(controller.getMetrics().activeRequests, 0);
    assert.equal(controller.getQueuedPlaybackRequests(), 0);
});
