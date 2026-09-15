import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { RoomAudioAnalysisInput, RoomAudioAnalysisItem, RoomAudioAnalysisOutcome } from '../src/contracts/roomAudioAnalysis';
import { createRoomAudioAnalysisController } from '../src/controllers/contentManager/roomAudioAnalysisController';
import { attachRequestAbortSignal } from '../src/middleware/requestProtectionMiddleware';
import { RoomAudioAnalysisError } from '../src/services/roomAudioAnalysisService';

const actorId = 'a'.repeat(24);
const source = { mediaTrackId: 'b'.repeat(24), sourceRevision: 'c'.repeat(64), attemptId: 'd'.repeat(32) };
const item: RoomAudioAnalysisItem = { ...source, title: 'Current source', status: 'notAnalyzed', updatedAt: null, reason: null };
const request = (fields: Record<string, unknown> = {}) => Object.assign(new EventEmitter(), {
    auth: { role: 'admin', userId: actorId }, query: {}, body: source, is: () => false, ...fields
}) as unknown as Request;
const response = () => {
    const capture = { status: 200, body: undefined as unknown, html: '', location: '', headers: {} as Record<string, string> };
    const res = Object.assign(new EventEmitter(), {
        setHeader(name: string, value: string) { capture.headers[name] = value; },
        status(value: number) { capture.status = value; return res; },
        type() { return res; },
        json(value: unknown) { capture.body = value; return res; },
        send(value: string) { capture.html = value; return res; },
        redirect(status: number, location: string) { capture.status = status; capture.location = location; return res; }
    });
    return { capture, res: res as unknown as Response };
};
const noAnalyze = async (): Promise<RoomAudioAnalysisOutcome> => { throw new Error('Unexpected analysis.'); };

test('listing only reads a bounded page for the current administrator and exposes allowlisted JSON', async () => {
    const calls: unknown[] = [];
    const controller = createRoomAudioAnalysisController({
        list: async input => { calls.push(input); return { items: [{ ...item, s3Key: 'private-key' }], nextAfter: null }; },
        analyze: noAnalyze
    });
    for (let index = 0; index < 2; index++) {
        const { res, capture } = response();
        await controller.get(request({ query: { format: 'json', after: 'e'.repeat(24) } }), res);
        assert.equal(capture.status, 200);
        assert.equal(capture.headers['Cache-Control'], 'no-store');
        assert.deepEqual(capture.body, { items: [item], nextAfter: null });
    }
    assert.deepEqual(calls, Array(2).fill({ actorId, after: 'e'.repeat(24), limit: 25 }));
});

test('controller refuses non-admin reads and writes before service work', async () => {
    const controller = createRoomAudioAnalysisController({ list: async () => { throw new Error('Unexpected read.'); }, analyze: noAnalyze });
    for (const handler of [controller.get, controller.post]) {
        const { res, capture } = response();
        await handler(request({ auth: { role: 'user', userId: actorId } }), res);
        assert.equal(capture.status, 403);
    }
});

test('strict request decoding rejects extra fields, duplicate values and unsafe return locations', async () => {
    let calls = 0;
    const controller = createRoomAudioAnalysisController({ list: async () => { calls++; return { items: [], nextAfter: null }; }, analyze: async () => { calls++; return { ...source, outcome: 'complete', reason: null }; } });
    for (const body of [null, [], { ...source, actorId }, { ...source, mediaTrackId: [source.mediaTrackId] }, { ...source, attemptId: 'bad' }, { ...source, sourceRevision: source.sourceRevision.toUpperCase() }, { ...source, after: 'https://example.test' }]) {
        const { res, capture } = response();
        await controller.post(request({ body }), res);
        assert.equal(capture.status, 400);
    }
    for (const query of [{ after: ['e'.repeat(24)] }, { after: '../' }, { limit: '1000' }, { format: ['json'] }]) {
        const { res, capture } = response();
        await controller.get(request({ query }), res);
        assert.equal(capture.status, 400);
    }
    assert.equal(calls, 0);
});

test('analysis retains source and attempt identity, forwards cancellation and returns safe outcome fields', async () => {
    let captured: RoomAudioAnalysisInput | undefined;
    const controller = createRoomAudioAnalysisController({ list: async () => ({ items: [], nextAfter: null }), analyze: async input => {
        captured = input;
        return { mediaTrackId: input.mediaTrackId, attemptId: input.attemptId, outcome: 'unknown', reason: 'interrupted', privateDiagnostic: 'secret' };
    } });
    const req = request({ is: () => 'application/json' });
    const { res, capture } = response();
    attachRequestAbortSignal(req, res, () => undefined);
    await controller.post(req, res);
    assert.equal(captured?.actorId, actorId);
    assert.equal(captured?.sourceRevision, source.sourceRevision);
    assert.equal(captured?.attemptId, source.attemptId);
    assert.equal(captured?.signal?.aborted, false);
    req.emit('aborted');
    assert.equal(captured?.signal?.aborted, true);
    res.emit('close');
    assert.deepEqual(capture.body, { mediaTrackId: source.mediaTrackId, attemptId: source.attemptId, outcome: 'unknown', reason: 'interrupted' });
});

test('every browser outcome redirects to current state without encoding success or source tokens', async () => {
    const outcomes: RoomAudioAnalysisOutcome['outcome'][] = ['complete', 'unsupported', 'failed', 'cancelled', 'stale', 'busy', 'unknown'];
    for (const outcome of outcomes) {
        const controller = createRoomAudioAnalysisController({ list: async () => ({ items: [item], nextAfter: null }), analyze: async () => ({ ...source, outcome, reason: null }) });
        const { res, capture } = response();
        await controller.post(request({ body: { ...source, after: 'e'.repeat(24) } }), res);
        assert.equal(capture.status, 303);
        const location = new URL(capture.location, 'https://example.test');
        assert.equal(location.pathname, '/content/manage/room-audio-analysis');
        assert.equal(location.searchParams.get('after'), 'e'.repeat(24));
        assert.equal(location.searchParams.get('notice'), ['complete', 'unsupported'].includes(outcome) ? 'finished' : outcome);
        assert.doesNotMatch(capture.location, /attemptId|sourceRevision|success/);
        const followUp = response();
        await controller.get(request({ query: Object.fromEntries(location.searchParams) }), followUp.res);
        assert.match(followUp.capture.html, /Not analyzed/);
    }
});

test('unexpected service outcomes and diagnostics stay unknown and private', async () => {
    const controller = createRoomAudioAnalysisController({ list: async () => { throw new Error('private provider response'); }, analyze: async () => ({ ...source, outcome: 'private-result', reason: 'private-reason' }) as any });
    const get = response();
    await controller.get(request({ query: { format: 'json' } }), get.res);
    assert.equal(get.capture.status, 503);
    assert.doesNotMatch(JSON.stringify(get.capture.body), /private|provider/);
    const post = response();
    await controller.post(request({ is: () => 'application/json' }), post.res);
    assert.deepEqual(post.capture.body, { mediaTrackId: source.mediaTrackId, attemptId: source.attemptId, outcome: 'unknown', reason: null });
});

test('a response for a different attempt cannot confirm success for the submitted action', async () => {
    const controller = createRoomAudioAnalysisController({ list: async () => ({ items: [], nextAfter: null }), analyze: async () => ({ ...source, attemptId: 'e'.repeat(32), outcome: 'complete', reason: null }) });
    const { res, capture } = response();
    await controller.post(request({ is: () => 'application/json' }), res);
    assert.deepEqual(capture.body, { mediaTrackId: source.mediaTrackId, attemptId: source.attemptId, outcome: 'unknown', reason: null });
});

test('uncertain browser errors return to live status while revoked administrator access remains denied', async () => {
    for (const failure of [new Error('private storage error'), new RoomAudioAnalysisError(503, 'private_code')]) {
        const controller = createRoomAudioAnalysisController({ list: async () => ({ items: [], nextAfter: null }), analyze: async () => { throw failure; } });
        const { res, capture } = response();
        await controller.post(request(), res);
        assert.equal(capture.status, 303);
        assert.equal(capture.location, '/content/manage/room-audio-analysis?notice=unknown');
    }
    const controller = createRoomAudioAnalysisController({ list: async () => ({ items: [], nextAfter: null }), analyze: async () => { throw new RoomAudioAnalysisError(403, 'private_admin_record'); } });
    const { res, capture } = response();
    await controller.post(request(), res);
    assert.equal(capture.status, 403);
    assert.doesNotMatch(capture.html, /private/);
});
