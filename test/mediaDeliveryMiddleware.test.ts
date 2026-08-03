import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

import {
    createMediaAdmissionController,
    MediaAdmissionController
} from '../src/middleware/mediaDeliveryMiddleware';
import {
    createMediaDeliveryMetricsRegistry,
    MediaResourceClass
} from '../src/services/mediaDeliveryService';

class TestResponse extends EventEmitter {
    statusCode = 200;
    writableEnded = false;
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
        return this;
    }

    finish(statusCode = this.statusCode) {
        this.statusCode = statusCode;
        this.writableEnded = true;
        this.emit('finish');
    }

    abort() {
        this.emit('close');
    }
}

const requestFor = (ip: string) => ({
    ip,
    socket: { remoteAddress: ip }
}) as unknown as Request;

const requestMedia = (
    controller: MediaAdmissionController,
    resourceClass: MediaResourceClass,
    ip: string
) => {
    const response = new TestResponse();
    let admitted = false;
    controller.middleware(resourceClass)(
        requestFor(ip),
        response as unknown as Response,
        (() => {
            admitted = true;
        }) as NextFunction
    );
    return { response, admitted };
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
    assert.equal(video.admitted, false);
    assert.equal(video.response.statusCode, 429);
    assert.equal(video.response.headers.get('retry-after'), '2');
    assert.deepEqual(video.response.body, {
        message: 'Too many concurrent media requests.'
    });
    assert.equal(playback.admitted, true);

    const active = controller.getMetrics();
    assert.equal(active.activeRequests, 3);
    assert.equal(active.byResource.playback.activeRequests, 1);
    assert.equal(active.byResource.video.rejectionReasons.playbackReserved, 1);
    assert.deepEqual(active.limits, {
        global: 4,
        perIp: 3,
        playbackReservedGlobal: 2,
        playbackReservedPerIp: 1
    });
    assert.equal(JSON.stringify(active).includes(ip), false);

    artwork.response.finish(200);
    avatar.response.finish(304);
    playback.response.finish(206);
    // A later close event must not release or count the same request twice.
    playback.response.emit('close');

    const finished = controller.getMetrics();
    assert.equal(finished.activeRequests, 0);
    assert.equal(finished.responseOutcomes.success, 3);
    assert.equal(finished.byResource.playback.responseOutcomes.success, 1);
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
    const video = requestMedia(controller, 'video', '198.51.100.2');
    const download = requestMedia(controller, 'download', '198.51.100.3');
    const playback = requestMedia(controller, 'playback', '198.51.100.3');

    assert.equal(artwork.admitted, true);
    assert.equal(video.admitted, true);
    assert.equal(download.admitted, false);
    assert.equal(playback.admitted, true);
    assert.equal(
        controller.getMetrics().byResource.download.rejectionReasons.playbackReserved,
        1
    );

    artwork.response.finish();
    video.response.finish();
    playback.response.finish();
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
