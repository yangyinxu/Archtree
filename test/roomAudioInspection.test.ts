import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { inspectRoomAudioFile, RoomAudioInspectionError } from '../src/services/roomAudioInspection';
import { inspectRoomMp3 } from '../src/services/roomAudioInspectionMp3';
import { inspectRoomMp4 } from '../src/services/roomAudioInspectionMp4';
import { RoomAudioReader } from '../src/services/roomAudioInspectionReader';
import { createPcmWav, wavUploadFile } from './support/pcmWav';

const fixturePath = (name: string) => resolve('test/fixtures/room-audio', name);
const upload = (buffer: Buffer) => ({ ...wavUploadFile(buffer), originalname: 'misleading.ogg', mimetype: 'application/octet-stream' });
const diskUpload = async (name: string) => ({ ...upload(Buffer.alloc(0)), path: fixturePath(name), size: (await stat(fixturePath(name))).size });

// These original synthetic tones exercise actual decoder execution; a missing FFmpeg runtime is a failed prerequisite.
test('full-file MP3 and AAC inspection accepts CBR, indexed VBR, MPEG2 mono and both MP4 metadata placements', async () => {
    for (const [name, durationMs, format] of [
        ['cbr.mp3', 2000, 'mp3'], ['vbr.mp3', 2000, 'mp3'], ['cbr-mono-no-index.mp3', 2088, 'mp3'],
        ['aac-lc.m4a', 2000, 'm4a-aac'], ['aac-lc-moov-tail.m4a', 2000, 'm4a-aac'],
        ['room-tone.mp3', 120000, 'mp3'], ['room-tone-vbr.mp3', 120000, 'mp3'], ['room-tone.m4a', 120000, 'm4a-aac']
    ] as const) {
        assert.deepEqual(await inspectRoomAudioFile(await diskUpload(name)), { durationMs, format }, name);
    }
    for (const [name, format] of [['cbr.mp3', 'mp3'], ['aac-lc.m4a', 'm4a-aac']] as const) {
        assert.deepEqual(await inspectRoomAudioFile(upload(await readFile(fixturePath(name)))), { durationMs: 2000, format });
    }
    assert.deepEqual(await inspectRoomAudioFile(wavUploadFile(createPcmWav(2345))), { durationMs: 2345, format: 'wav-pcm' });
});

test('MP3 framing rejects truncation, junk, inconsistent frames, lying frame counts and misleading VBR indexes', async () => {
    const original = await readFile(fixturePath('cbr.mp3'));
    const marker = original.indexOf('Info');
    assert.ok(marker > 0);
    const changes: Array<(bytes: Buffer) => void> = [
        bytes => bytes[6] = 128,
        bytes => bytes[3] = 9,
        bytes => bytes.writeUInt32BE(bytes.readUInt32BE(marker + 8) + 1, marker + 8),
        bytes => bytes.writeUInt32BE(bytes.readUInt32BE(marker + 12) - 1, marker + 12),
        bytes => bytes[marker + 16 + 50] = 0,
        bytes => bytes[461 + 1] &= ~8 // The second frame cannot change MPEG version halfway through a track.
    ];
    for (const change of changes) { const bytes = Buffer.from(original); change(bytes); assert.equal(await inspectRoomAudioFile(upload(bytes)), null); }
    assert.equal(await inspectRoomAudioFile(upload(original.subarray(0, original.length - 1))), null);
    assert.equal(await inspectRoomAudioFile(upload(Buffer.concat([original, Buffer.from('unframed junk')]))), null);
    const variable = await readFile(fixturePath('vbr.mp3'));
    const xing = variable.indexOf('Xing'); variable.write('Info', xing);
    assert.equal(await inspectRoomAudioFile(upload(variable)), null);
});

test('AAC sample indexes, codec config, source references and complete container framing are all admission boundaries', async () => {
    const original = await readFile(fixturePath('aac-lc.m4a'));
    const changes: Array<(bytes: Buffer) => void> = [
        bytes => bytes.writeUInt32BE(0xffffffff, 0),
        bytes => bytes.write('enca', bytes.indexOf('mp4a')),
        bytes => bytes.writeUInt32BE(1, bytes.indexOf('tkhd') + 24),
        bytes => bytes.write('vide', bytes.indexOf('hdlr') + 12),
        bytes => bytes.writeUInt32BE(0, bytes.indexOf('url ') + 4),
        bytes => bytes.writeUInt32BE(0xffffffff, bytes.indexOf('stsz') + 12),
        bytes => bytes.writeUInt32BE(0xffffffff, bytes.indexOf('stco') + 12),
        bytes => bytes.writeUInt32BE(2, bytes.indexOf('stsc') + 12),
        bytes => bytes.writeUInt32BE(0, bytes.indexOf('stts') + 16),
        bytes => bytes.writeUInt32BE(3, bytes.indexOf('stsc') + 20),
        bytes => bytes[bytes.indexOf(Buffer.from('121056e500', 'hex'))] = 0x2a,
        bytes => bytes.writeUInt32BE(0xffffffff, bytes.indexOf('elst') + 16)
    ];
    for (const change of changes) { const bytes = Buffer.from(original); change(bytes); assert.equal(await inspectRoomAudioFile(upload(bytes)), null); }
    assert.equal(await inspectRoomAudioFile(upload(original.subarray(0, original.length - 1))), null);
    assert.equal(await inspectRoomAudioFile(upload(Buffer.concat([original, Buffer.alloc(7)]))), null);
});

test('valid compressed headers cannot hide corrupt encoded payloads at the end of either format', async () => {
    for (const [name, scan] of [['cbr.mp3', inspectRoomMp3], ['aac-lc.m4a', inspectRoomMp4]] as const) {
        const bytes = await readFile(fixturePath(name));
        // Corrupt the last MP3 frame's side information or final AAC packets, preserving all structural headers/indexes.
        if (name === 'cbr.mp3') bytes.fill(255, 32643 + 4, 32643 + 36);
        else bytes.fill(255, bytes.length - 64);
        const file = upload(bytes); const reader = await RoomAudioReader.create(file);
        try { assert.equal(await scan(reader), 2000); } finally { await reader.close(); }
        assert.equal(await inspectRoomAudioFile(file), null, name);
    }
});

test('unsupported and size-mismatched sources stay ineligible without trusting names, MIME or display durations', async () => {
    assert.equal(await inspectRoomAudioFile(upload(Buffer.from('not actual audio data'))), null);
    const file = await diskUpload('cbr.mp3'); file.size += 1;
    assert.equal(await inspectRoomAudioFile(file), null);
    for (const size of [-1, Infinity, 0xffffffff + 1]) assert.equal(await inspectRoomAudioFile({ ...upload(Buffer.alloc(16)), size }), null);
    const directory = await mkdtemp(join(tmpdir(), 'archtree-audio-size-'));
    try {
        const path = join(directory, 'oversized.mp3'); const handle = await import('node:fs/promises').then(fs => fs.open(path, 'w'));
        try { await handle.write(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00')); await handle.truncate(512 * 1024 * 1024 + 1); }
        finally { await handle.close(); }
        assert.equal(await inspectRoomAudioFile({ ...upload(Buffer.alloc(0)), path, size: 512 * 1024 * 1024 + 1 }), null);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing decoder is retryable, while WAV remains available independently of that runtime', async () => {
    const previous = process.env.ROOM_AUDIO_FFMPEG_PATH;
    try {
        process.env.ROOM_AUDIO_FFMPEG_PATH = '/nonexistent/archtree-test-ffmpeg';
        await assert.rejects(inspectRoomAudioFile(await diskUpload('cbr.mp3')), (error: unknown) => error instanceof RoomAudioInspectionError && error.code === 'decoder_unavailable');
        process.env.ROOM_AUDIO_FFMPEG_PATH = 'untrusted/relative-path';
        await assert.rejects(inspectRoomAudioFile(await diskUpload('aac-lc.m4a')), (error: unknown) => error instanceof RoomAudioInspectionError && error.code === 'decoder_unavailable');
        assert.deepEqual(await inspectRoomAudioFile(wavUploadFile()), { durationMs: 2000, format: 'wav-pcm' });
    } finally { if (previous === undefined) delete process.env.ROOM_AUDIO_FFMPEG_PATH; else process.env.ROOM_AUDIO_FFMPEG_PATH = previous; }
});

test('cancellation aborts a running decoder and preserves an explicit retryable error boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-audio-abort-')); const previous = process.env.ROOM_AUDIO_FFMPEG_PATH;
    try {
        const path = join(directory, 'decoder');
        await writeFile(path, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 }); await chmod(path, 0o700);
        process.env.ROOM_AUDIO_FFMPEG_PATH = path;
        const controller = new AbortController(); const running = inspectRoomAudioFile(await diskUpload('cbr.mp3'), { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === 'AbortError');
        const alreadyAborted = AbortSignal.abort();
        await assert.rejects(inspectRoomAudioFile(wavUploadFile(), { signal: alreadyAborted }), { name: 'AbortError' });
    } finally {
        if (previous === undefined) delete process.env.ROOM_AUDIO_FFMPEG_PATH; else process.env.ROOM_AUDIO_FFMPEG_PATH = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

test('compressed decoder capacity is bounded and aborted jobs release slots only after cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-audio-capacity-')); const previous = process.env.ROOM_AUDIO_FFMPEG_PATH;
    const controller = new AbortController();
    try {
        const path = join(directory, 'decoder');
        await writeFile(path, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
        process.env.ROOM_AUDIO_FFMPEG_PATH = path;
        const file = await diskUpload('cbr.mp3');
        const first = inspectRoomAudioFile(file, { signal: controller.signal });
        const second = inspectRoomAudioFile(file, { signal: controller.signal });
        const settled = Promise.allSettled([first, second]);
        await new Promise(resolve => setTimeout(resolve, 30));
        await assert.rejects(inspectRoomAudioFile(file), (error: unknown) => error instanceof RoomAudioInspectionError && error.code === 'analysis_failed');
        controller.abort();
        const results = await settled;
        assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
        if (previous === undefined) delete process.env.ROOM_AUDIO_FFMPEG_PATH; else process.env.ROOM_AUDIO_FFMPEG_PATH = previous;
        assert.deepEqual(await inspectRoomAudioFile(file), { durationMs: 2000, format: 'mp3' });
    } finally {
        controller.abort();
        if (previous === undefined) delete process.env.ROOM_AUDIO_FFMPEG_PATH; else process.env.ROOM_AUDIO_FFMPEG_PATH = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

test('decoder timeout is retryable and decoder diagnostics never escape the bounded error result', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-audio-timeout-')); const previous = process.env.ROOM_AUDIO_FFMPEG_PATH;
    try {
        const path = join(directory, 'decoder');
        await writeFile(path, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
        process.env.ROOM_AUDIO_FFMPEG_PATH = path;
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const { decodeRoomAudio } = await import('../src/services/roomAudioInspectionDecoder');
        const result = decodeRoomAudio(await diskUpload('cbr.mp3'), 'mp3', 2000);
        const rejection = assert.rejects(result, (error: unknown) => error instanceof RoomAudioInspectionError && error.code === 'analysis_timeout' && error.message === 'analysis_timeout');
        context.mock.timers.tick(60_000);
        await rejection;
        context.mock.timers.reset();
        await writeFile(path, `#!${process.execPath}\nprocess.stderr.write('private media metadata'.repeat(1000));\nprocess.exitCode = 1;\n`, { mode: 0o700 });
        assert.equal(await inspectRoomAudioFile(await diskUpload('cbr.mp3')), null);
    } finally {
        context.mock.timers.reset();
        if (previous === undefined) delete process.env.ROOM_AUDIO_FFMPEG_PATH; else process.env.ROOM_AUDIO_FFMPEG_PATH = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

test('existing large PCM WAV inspection remains compatible above the compressed file-size limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-audio-large-wav-'));
    try {
        const dataSize = 1024 * 1024 * 1024; const path = join(directory, 'sparse.wav');
        const header = createPcmWav(1, 48000, 2).subarray(0, 44);
        header.writeUInt32LE(dataSize + 36, 4); header.writeUInt32LE(dataSize, 40);
        const handle = await import('node:fs/promises').then(fs => fs.open(path, 'w'));
        try { await handle.write(header); await handle.truncate(dataSize + 44); } finally { await handle.close(); }
        assert.deepEqual(await inspectRoomAudioFile({ ...upload(Buffer.alloc(0)), path, size: dataSize + 44 }), {
            format: 'wav-pcm', durationMs: Math.round(dataSize / (48000 * 4) * 1000)
        });
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing FFmpeg capabilities remain retryable and the same media succeeds after runtime repair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-audio-capability-')); const previous = process.env.ROOM_AUDIO_FFMPEG_PATH;
    try {
        const path = join(directory, 'decoder'); const file = await diskUpload('cbr.mp3');
        process.env.ROOM_AUDIO_FFMPEG_PATH = path;
        for (const diagnostic of [
            "Unrecognized option 'max_error_rate'.",
            "Unknown decoder 'mp3'.",
            'Decoder (codec aac) not found for input stream #0:0',
            "Unknown input format: 'mov'",
            "Requested output format 'null' is not known.",
            'Automatic encoder selection failed for output stream #0:0. Default encoder for format null (codec pcm_s16le) is probably disabled.',
            'Protocol not found',
            'Option max_streams not found.',
            'error while loading shared libraries: unavailable.so'
        ]) {
            // Splitting the message tests the bounded overlap, while a private suffix must never escape through the error.
            const fullDiagnostic = `${diagnostic}\nprivate fixture path and metadata\n`;
            const source = `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(fullDiagnostic.slice(0, 7))});\nsetTimeout(() => { process.stderr.write(${JSON.stringify(fullDiagnostic.slice(7))}); process.exitCode = 1; }, 10);\n`;
            await writeFile(path, source, { mode: 0o700 });
            await assert.rejects(inspectRoomAudioFile(file), (error: unknown) => error instanceof RoomAudioInspectionError
                && error.code === 'decoder_unavailable' && error.message === 'decoder_unavailable');
        }
        await writeFile(path, `#!${process.execPath}\nprocess.stderr.write('Error while decoding: invalid data found when processing input.'); process.exitCode = 1;\n`, { mode: 0o700 });
        assert.equal(await inspectRoomAudioFile(file), null);
        if (previous === undefined) delete process.env.ROOM_AUDIO_FFMPEG_PATH; else process.env.ROOM_AUDIO_FFMPEG_PATH = previous;
        assert.deepEqual(await inspectRoomAudioFile(file), { durationMs: 2000, format: 'mp3' });
    } finally {
        if (previous === undefined) delete process.env.ROOM_AUDIO_FFMPEG_PATH; else process.env.ROOM_AUDIO_FFMPEG_PATH = previous;
        await rm(directory, { recursive: true, force: true });
    }
});
