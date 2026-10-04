import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createRoomSoakCommandDiagnostic,
    createRoomSoakSummary,
    readRoomSoakOptions,
    roomSoakAdmissionReason,
    roomSoakElapsedSeconds,
    roomSoakWindowAdmissionAt,
    ROOM_SOAK_MAX_DEVICE_RECOVERIES,
    type RoomSoakSample
} from '../web/e2e-social/support/roomSoakPolicy';
import { SOCIAL_LIMITS } from '../src/contracts/socialV1';

const sample = (overrides: Partial<RoomSoakSample> = {}): RoomSoakSample => ({
    rssBytes: 100, heapUsedBytes: 40, activeUpgradeTransports: 2, activeStreams: 1, ...overrides
});

test('room soak command denials retain only exact allowlisted admission categories', () => {
    for (const [message, expected] of [
        ['Too many concurrent requests.', 'concurrency'],
        ['Too many concurrent media requests.', 'media-concurrency'],
        ['Too many requests. Please try again later.', 'request-window']
    ] as const) {
        assert.equal(roomSoakAdmissionReason({ message, privatePayload: 'private-credential-value' }), expected);
    }
    for (const body of [undefined, null, [], 'Too many concurrent requests.', 429, {},
        { message: null }, { message: ['Too many concurrent requests.'] },
        { message: 'Too many concurrent requests. private-credential-value' },
        { message: ' Too many requests. Please try again later.' }, { message: 'private-credential-value' }]) {
        assert.equal(roomSoakAdmissionReason(body), 'other');
    }
});

test('awaiting the exact denied command records its reason and fences delayed former response bodies', async () => {
    const diagnostic = createRoomSoakCommandDiagnostic();
    let completeOld!: (body: unknown) => void;
    const former = diagnostic.record(429, () => new Promise(resolve => { completeOld = resolve; }));
    assert.equal(diagnostic.snapshot(), undefined);
    let exactReads = 0;
    await diagnostic.record(429, async () => { exactReads++; return { message: 'Too many requests. Please try again later.', privatePayload: 'private-credential-value' }; });
    assert.equal(exactReads, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.snapshot())), { status: 429, admissionReason: 'request-window' });
    completeOld({ message: 'Too many concurrent requests.' }); await former;
    assert.equal(diagnostic.snapshot()?.admissionReason, 'request-window');
});

test('command diagnostics retain known outcomes only and classify unreadable denial bodies without private details', async () => {
    const diagnostic = createRoomSoakCommandDiagnostic();
    await diagnostic.record(200, async () => ({ outcome: 'applied', code: 'conflict', message: 'Too many concurrent requests.', privatePayload: 'private-credential-value' }));
    assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.snapshot())), { status: 200, outcome: 'applied', code: 'conflict' });
    const saved = diagnostic.snapshot()!; saved.status = 500;
    assert.equal(diagnostic.snapshot()?.status, 200);
    await diagnostic.record(429, async () => { throw new Error('private-credential-value'); });
    assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.snapshot())), { status: 429, admissionReason: 'other' });
    await diagnostic.record(503, async () => ({ outcome: 'private-credential-value', code: 'private-credential-value' }));
    assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.snapshot())), { status: 503 });
});

test('room soak duration is absent before playback and preserves actual monotonic elapsed time', () => {
    assert.equal(roomSoakElapsedSeconds(null, 99_000), null);
    assert.equal(roomSoakElapsedSeconds(1_000.25, 1_000.25), 0);
    assert.equal(roomSoakElapsedSeconds(1_000.25, 54_210.75), 53.2105);
    assert.equal(roomSoakElapsedSeconds(1_000, 28_801_000), 28_800);
    for (const [started, now] of [[-1, 0], [1, 0], [NaN, 1], [1, NaN], [Infinity, Infinity]]) {
        assert.throws(() => roomSoakElapsedSeconds(started, now), /ordered finite monotonic clock/);
    }
});

test('room soak respects successful published window headroom before the first denied command', () => {
    const now = 1_000_125;
    for (const limit of ['120', '180']) {
        const headers = { 'ratelimit-limit': limit, 'ratelimit-remaining': '8', 'ratelimit-reset': '1061' };
        assert.equal(roomSoakWindowAdmissionAt(headers, now, 8), 1_061_000);
        assert.equal(roomSoakWindowAdmissionAt({ ...headers, 'ratelimit-remaining': '0' }, now, 2), 1_061_000);
        assert.equal(roomSoakWindowAdmissionAt({ ...headers, 'ratelimit-remaining': '9' }, now, 8), 0);
        assert.equal(roomSoakWindowAdmissionAt(headers, 1_061_000, 8), 0);
    }
});

test('room soak ignores malformed, foreign, distant, and impossible published rate windows', () => {
    const now = 1_000_125;
    const valid = { 'ratelimit-limit': '180', 'ratelimit-remaining': '0', 'ratelimit-reset': '1061' };
    for (const value of ['', ' 0', '01', '-1', '+0', '1.0', '1e0', 'NaN', 'private-credential-value']) {
        assert.equal(roomSoakWindowAdmissionAt({ ...valid, 'ratelimit-remaining': value }, now, 8), 0);
    }
    for (const value of ['', ' 1061', '01061', '+1061', '1061.0', '1061e0', '9007199254740992', '1062', '1000']) {
        assert.equal(roomSoakWindowAdmissionAt({ ...valid, 'ratelimit-reset': value }, now, 8), 0);
    }
    for (const value of ['20', '240', '0180', '180.0']) assert.equal(roomSoakWindowAdmissionAt({ ...valid, 'ratelimit-limit': value }, now, 8), 0);
    for (const value of [1, 9, 2.5, NaN]) assert.equal(roomSoakWindowAdmissionAt(valid, now, value), 0);
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(roomSoakWindowAdmissionAt(valid, value, 8), 0);
});

test('room soak policy has bounded defaults and permits explicit minimum/maximum settings', () => {
    assert.deepEqual(readRoomSoakOptions({}), { durationSeconds: 1_800, cycleSeconds: 45, members: 2 });
    assert.deepEqual(readRoomSoakOptions({
        FINITUDE_ROOM_SOAK_SECONDS: '60', FINITUDE_ROOM_SOAK_CYCLE_SECONDS: '15', FINITUDE_ROOM_SOAK_MEMBERS: '2'
    }), { durationSeconds: 60, cycleSeconds: 15, members: 2 });
    assert.deepEqual(readRoomSoakOptions({
        FINITUDE_ROOM_SOAK_SECONDS: '28800', FINITUDE_ROOM_SOAK_CYCLE_SECONDS: '300', FINITUDE_ROOM_SOAK_MEMBERS: '8'
    }), { durationSeconds: 28_800, cycleSeconds: 300, members: 8 });
});

test('room soak policy rejects malformed lexical input, coercions and unsafe integers for every option', () => {
    const invalid = ['', ' ', ' 60', '60 ', '+60', '-60', '0', '060', '0x40', '6e1', '60.0', '60.5',
        'Infinity', 'NaN', '9007199254740992', 'private-credential-value', 60, true, false, null, [], {}];
    for (const key of ['FINITUDE_ROOM_SOAK_SECONDS', 'FINITUDE_ROOM_SOAK_CYCLE_SECONDS', 'FINITUDE_ROOM_SOAK_MEMBERS']) {
        for (const value of invalid) {
            assert.throws(() => readRoomSoakOptions({ [key]: value } as any), error => {
                assert.ok(error instanceof Error);
                assert.ok(error.message.startsWith(key));
                assert.doesNotMatch(error.message, /private-credential-value/);
                return true;
            }, `${key}: ${String(value)}`);
        }
    }
});

test('room soak policy rejects values outside each range and a cycle longer than its duration', () => {
    for (const [key, values] of [
        ['FINITUDE_ROOM_SOAK_SECONDS', ['59', '28801']],
        ['FINITUDE_ROOM_SOAK_CYCLE_SECONDS', ['14', '301']],
        ['FINITUDE_ROOM_SOAK_MEMBERS', ['1', '9']]
    ] as const) {
        for (const value of values) assert.throws(() => readRoomSoakOptions({ [key]: value }));
    }
    assert.throws(() => readRoomSoakOptions({
        FINITUDE_ROOM_SOAK_SECONDS: '60', FINITUDE_ROOM_SOAK_CYCLE_SECONDS: '61'
    }), /must not exceed/);
});

test('eight-hour workloads respect real retained receipts and page-reload scope issuance budgets', () => {
    assert.deepEqual(readRoomSoakOptions({ FINITUDE_ROOM_SOAK_SECONDS: '28800', FINITUDE_ROOM_SOAK_MEMBERS: '8' }),
        { durationSeconds: 28_800, cycleSeconds: 45, members: 8 });
    assert.throws(() => readRoomSoakOptions({ FINITUDE_ROOM_SOAK_SECONDS: '28800', FINITUDE_ROOM_SOAK_CYCLE_SECONDS: '15' }),
        /real retained mutation budget/);
    assert.ok(ROOM_SOAK_MAX_DEVICE_RECOVERIES >= 1);
    assert.ok(ROOM_SOAK_MAX_DEVICE_RECOVERIES + 3 < SOCIAL_LIMITS.scopesPerDay);
});

test('room soak aggregates expose missing measurements explicitly and return independent snapshots', () => {
    const summary = createRoomSoakSummary();
    const empty = { sampleCount: 0, start: null, end: null, min: null, max: null };
    assert.deepEqual(summary.snapshot(), {
        sampleCount: 0, rssBytes: empty, heapUsedBytes: empty, activeUpgradeTransports: empty,
        activeStreams: empty, driftMs: { ...empty, convergenceExclusions: 0 }
    });
    summary.record(sample());
    const first = summary.snapshot();
    first.rssBytes.max = 999;
    assert.equal(summary.snapshot().rssBytes.max, 100);
    assert.equal(summary.snapshot().driftMs.sampleCount, 0);
    assert.equal(summary.snapshot().driftMs.max, null);
});

test('room soak records only scalar extrema and absolute steady drift, with convergence exclusions', () => {
    const summary = createRoomSoakSummary();
    summary.record(sample({ driftMs: -12.5 }));
    summary.record(sample({ rssBytes: 250, heapUsedBytes: 70, activeUpgradeTransports: 4,
        activeStreams: 3, driftMs: 1_000, driftConverging: true }));
    summary.record(sample({ rssBytes: 180, heapUsedBytes: 30, activeUpgradeTransports: 0, activeStreams: 0, driftMs: 5 }));
    assert.deepEqual(summary.snapshot(), {
        sampleCount: 3,
        rssBytes: { sampleCount: 3, start: 100, end: 180, min: 100, max: 250 },
        heapUsedBytes: { sampleCount: 3, start: 40, end: 30, min: 30, max: 70 },
        activeUpgradeTransports: { sampleCount: 3, start: 2, end: 0, min: 0, max: 4 },
        activeStreams: { sampleCount: 3, start: 1, end: 0, min: 0, max: 3 },
        driftMs: { sampleCount: 2, start: 12.5, end: 5, min: 5, max: 12.5, convergenceExclusions: 1 }
    });
});

test('invalid room soak samples fail atomically without fabricating resource or drift evidence', () => {
    const summary = createRoomSoakSummary();
    summary.record(sample({ driftMs: 5 }));
    const before = summary.snapshot();
    for (const key of ['rssBytes', 'heapUsedBytes', 'activeUpgradeTransports', 'activeStreams']) {
        for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null, undefined]) {
            assert.throws(() => summary.record(sample({ [key]: value } as any)));
            assert.deepEqual(summary.snapshot(), before);
        }
    }
    for (const driftMs of [NaN, Infinity, -Infinity, '5', null]) {
        assert.throws(() => summary.record(sample({ driftMs } as any)));
        assert.deepEqual(summary.snapshot(), before);
    }
    assert.throws(() => summary.record(sample({ driftConverging: 'true' } as any)));
    assert.deepEqual(summary.snapshot(), before);
});

test('room soak summary retains no private fields or mutable sample object even after many measurements', () => {
    const summary = createRoomSoakSummary();
    const observation = Object.assign(sample(), {
        userId: 'private-account', url: 'https://private.invalid/track', error: 'private credential failure'
    });
    for (let index = 0; index < 10_000; index += 1) summary.record(observation);
    observation.rssBytes = 999;
    const snapshot = summary.snapshot();
    assert.equal(snapshot.sampleCount, 10_000);
    assert.equal(snapshot.rssBytes.end, 100);
    assert.doesNotMatch(JSON.stringify(snapshot), /private|https|credential|userId|url|error/);
    assert.ok(JSON.stringify(snapshot).length < 1_024, 'Summary size must not grow with measurement count.');
});
