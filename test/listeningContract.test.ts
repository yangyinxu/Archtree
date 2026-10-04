import assert from 'node:assert/strict';
import test from 'node:test';
import { parseListeningReport } from '../src/contracts/listeningV1';
import { parseSocialCommand } from '../src/contracts/socialV1';

const identity = { scopeToken: 'synthetic-signed-scope-token', commandId: 'synthetic-command-01' };
const playback = { sourceId: 'synthetic-source-001', occurrenceId: 'synthetic-occurrence-001', mediaTrackId: 'a'.repeat(24), positionMs: 100, room: null };
const report = { clientId: 'synthetic-client-001', publicationId: identity.commandId, expectedPreferenceRevision: 1,
    expectedPublisherRevision: 2, sequence: 1, state: 'playing', observedAtMs: 10_000, playback };

test('listening settings and publisher claims preserve explicit observed revision intent', () => {
    for (const command of [
        { ...identity, action: 'setListeningSharing', enabled: false, expectedRevision: 0 },
        { ...identity, action: 'claimListening', clientId: report.clientId, expectedPreferenceRevision: 1, expectedPublisherRevision: 0 }
    ]) {
        const parsed = parseSocialCommand(command);
        assert.deepEqual(parsed, command); assert.ok(Object.isFrozen(parsed));
        assert.equal(parseSocialCommand({ ...command, accountId: 'private-account' }), null);
    }
    for (const value of [-1, 0.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(parseSocialCommand({ ...identity, action: 'setListeningSharing', enabled: true, expectedRevision: value }), null);
    }
    assert.equal(parseSocialCommand({ ...identity, action: 'claimListening', clientId: 'short', expectedPreferenceRevision: 1, expectedPublisherRevision: 1 }), null);
    assert.equal(parseSocialCommand({ ...identity, action: 'claimListening', clientId: report.clientId, expectedPreferenceRevision: 0, expectedPublisherRevision: 1 }), null);
});

test('playing reports freeze independent source and occurrence identities with exact room evidence', () => {
    const room = { roomId: 'room-1', memberId: 'member-1', epoch: 2, controllerGeneration: 3,
        playbackGeneration: 4, entryId: 'entry-1', mediaRevision: `mr_${'b'.repeat(32)}` };
    const input = { ...report, playback: { ...playback, room } };
    const parsed = parseListeningReport(input);
    assert.deepEqual(parsed, input); assert.ok(Object.isFrozen(parsed));
    assert.ok(parsed?.state === 'playing');
    assert.ok(Object.isFrozen(parsed.playback)); assert.ok(Object.isFrozen(parsed.playback.room));
    room.entryId = 'later-entry'; input.playback.positionMs = 200;
    assert.equal(parsed.playback.room?.entryId, 'entry-1'); assert.equal(parsed.playback.positionMs, 100);
    assert.deepEqual(parseListeningReport(report), report);
});

test('reports reject coercion, unknown payloads, unbounded values and incomplete room authority', () => {
    for (const value of [null, [], { ...report, sequence: 0 }, { ...report, sequence: '1' },
        { ...report, observedAtMs: Infinity }, { ...report, currentRoom: 'private' },
        { ...report, playback: { ...playback, sourceId: 'short' } },
        { ...report, playback: { ...playback, positionMs: -1 } },
        { ...report, playback: { ...playback, positionMs: 86_400_001 } },
        { ...report, playback: { ...playback, positionMs: 1.5 } },
        { ...report, playback: { ...playback, mediaTrackId: 'A'.repeat(24) } },
        { ...report, playback: { ...playback, room: {} } },
        { ...report, playback: { ...playback, streamUrl: 'https://example.test/private' } }]) {
        assert.equal(parseListeningReport(value), null);
    }
});

test('stops capture only exact publisher and occurrence, never a mutable current-song placeholder', () => {
    const { playback: _playback, observedAtMs: _time, ...base } = report;
    const stopped = { ...base, state: 'stopped', sequence: 2, playbackSequence: 1, occurrenceId: playback.occurrenceId };
    assert.deepEqual(parseListeningReport(stopped), stopped);
    assert.equal(parseListeningReport({ ...base, state: 'stopped' }), null);
    assert.equal(parseListeningReport({ ...stopped, playback }), null);
    assert.equal(parseListeningReport({ ...stopped, occurrenceId: '*' }), null);
    assert.equal(parseListeningReport({ ...stopped, playbackSequence: 2 }), null);
    assert.equal(parseListeningReport({ ...stopped, playbackSequence: 0 }), null);
});
