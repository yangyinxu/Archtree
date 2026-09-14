import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    inspectRoomAudioUpload, prepareMediaRepresentation, roomAudioRepresentationForTrack
} from '../src/services/mediaRepresentationService';
import { createPcmWav, wavUploadFile } from './support/pcmWav';

test('bounded WAV inspection derives duration from aligned PCM bytes for buffer and disk uploads', async () => {
    for (const channels of [1, 2]) {
        const file = wavUploadFile(createPcmWav(1234, 16000, channels));
        assert.deepEqual(await inspectRoomAudioUpload(file), { durationMs: 1234, format: 'wav-pcm' });
    }
    const directory = await mkdtemp(join(tmpdir(), 'archtree-pcm-test-'));
    try {
        const file = wavUploadFile(); file.path = join(directory, 'tone.wav');
        await writeFile(file.path, file.buffer);
        assert.deepEqual(await inspectRoomAudioUpload(file), { durationMs: 2000, format: 'wav-pcm' });
        file.size += 1;
        assert.equal(await inspectRoomAudioUpload(file), null);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('truncation, false lengths, compressed codecs, inconsistent sample framing and unsupported bytes stay ineligible', async () => {
    const mutations: Array<(bytes: Buffer) => void> = [
        bytes => bytes.write('RF64', 0), bytes => bytes.writeUInt32LE(bytes.length, 4),
        bytes => bytes.writeUInt16LE(3, 20), bytes => bytes.writeUInt16LE(3, 22),
        bytes => bytes.writeUInt32LE(0, 24), bytes => bytes.writeUInt32LE(1, 28),
        bytes => bytes.writeUInt16LE(1, 32), bytes => bytes.writeUInt16LE(24, 34),
        bytes => bytes.writeUInt32LE(1, 40), bytes => bytes.writeUInt32LE(0xffffffff, 40)
    ];
    for (const change of mutations) { const bytes = createPcmWav(); change(bytes); assert.equal(await inspectRoomAudioUpload(wavUploadFile(bytes)), null); }
    assert.equal(await inspectRoomAudioUpload(wavUploadFile(Buffer.from('not actually decoded audio'))), null);
    assert.equal(await inspectRoomAudioUpload(wavUploadFile(createPcmWav().subarray(0, 100))), null);
});

test('exact representations use opaque fresh identities and eligibility requires upload validators, never display duration', async () => {
    const id = '507f1f77bcf86cd799439011';
    const key = `audio/${id}/507f1f77bcf86cd799439012`;
    const first = await prepareMediaRepresentation(wavUploadFile(), key, 'audio');
    const second = await prepareMediaRepresentation(wavUploadFile(), key, 'audio');
    assert.notEqual(first.revision, second.revision);
    assert.match(first.revision, /^mr_[a-f0-9]{32}$/);
    const track = { _id: id, title: 'Tone', uploadStatus: 'ready', publicationStatus: 'ready', mediaType: 'audio', s3Key: key, duration: '59:59', mediaRepresentation: first };
    assert.equal(roomAudioRepresentationForTrack(track), null);
    first.etag = '"uploaded-bytes"';
    const descriptor = roomAudioRepresentationForTrack(track)!;
    assert.equal(descriptor.durationMs, 2000);
    assert.equal(roomAudioRepresentationForTrack({ ...track, title: ' ' })?.title, 'Audio');
    assert.equal(descriptor.streamUrl, `/content/mediaTrack/stream/${id}?revision=${first.revision}`);
    assert.deepEqual(Object.keys(descriptor).sort(), ['durationMs', 'mediaRevision', 'mediaTrackId', 'mediaType', 'streamUrl', 'title']);
    for (const change of [
        { uploadStatus: 'deleting' }, { publicationStatus: 'pending' }, { s3Key: id }, { mediaType: 'video' },
        { mediaRepresentation: { ...first, durationMs: '2000' } },
        { mediaRepresentation: { ...first, durationMs: 86_400_001 } },
        { mediaRepresentation: { ...first, seekable: false } },
        { mediaRepresentation: { ...first, etag: '\r\nheader' } }
    ]) assert.equal(roomAudioRepresentationForTrack({ ...track, ...change }), null);
    const unsupported = await prepareMediaRepresentation(wavUploadFile(Buffer.from('mpeg bytes')), key, 'audio');
    assert.equal(unsupported.seekable, false); assert.equal(unsupported.durationMs, null);
    assert.equal((await prepareMediaRepresentation(wavUploadFile(), key, 'video')).seekable, false);
});
