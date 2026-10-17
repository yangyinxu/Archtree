import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseConversionIntent, CONVERSION_PRESET } from '../../src/administration/conversion/conversionContract';
import { conversionAlbumMembershipRevision, conversionTrackSourceRevision } from '../../src/administration/conversion/conversionSources';
import { validateConversionMp3 } from '../../src/administration/conversion/conversionMp3';

let directory = '';
const files = new Map<string, Buffer>();
const output = (buffer: Buffer) => ({ sha256: createHash('sha256').update(buffer).digest('hex'), byteLength: buffer.length, filename: 'Output.mp3', preset: CONVERSION_PRESET });
const upload = (buffer: Buffer) => ({ buffer, size: buffer.length, mimetype: 'audio/mpeg', originalname: 'Output.mp3' } as Express.Multer.File);
const code = (value: string) => (error: any) => error.code === value;
before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'archtree-conversion-validator-'));
    for (const [name, rate, channels, bitrate] of [['stereo', 44100, 2, 320], ['mono', 48000, 1, 320], ['low', 44100, 2, 128]] as const) {
        const target = path.join(directory, `${name}.mp3`);
        const result = spawnSync(process.env.ROOM_AUDIO_FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=0.6`, '-ac', String(channels),
            '-codec:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-write_xing', '1', target], { shell: false, windowsHide: true });
        assert.equal(result.status, 0, 'The isolated synthetic MP3 fixture must be generated successfully.');
        files.set(name, await readFile(target));
    }
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('both disclosed 320 kbps channel/sample-rate profiles validate complete real MP3s', async () => {
    for (const [name, sampleRate, channels] of [['stereo', 44100, 2], ['mono', 48000, 1]] as const) {
        const buffer = files.get(name)!;
        const actual = await validateConversionMp3(upload(buffer), output(buffer));
        assert.equal(actual.sampleRate, sampleRate); assert.equal(actual.channels, channels);
        assert.ok(actual.durationMs >= 550 && actual.durationMs <= 680);
        const spooled = { ...upload(buffer), buffer: undefined, path: path.join(directory, `${name}.mp3`) } as unknown as Express.Multer.File;
        assert.deepEqual(await validateConversionMp3(spooled, output(buffer)), actual);
    }
});
test('a valid lower-bitrate MP3 cannot claim the high-quality preset', async () => {
    const buffer = files.get('low')!;
    await assert.rejects(validateConversionMp3(upload(buffer), output(buffer)), code('ADMIN_CONVERSION_INVALID_MP3'));
});
test('truncated frames, non-MP3 bytes and a false hash never produce validated output', async () => {
    const valid = files.get('stereo')!, truncated = valid.subarray(0, valid.length - 1), fake = Buffer.alloc(100, 3);
    for (const buffer of [truncated, fake]) await assert.rejects(validateConversionMp3(upload(buffer), output(buffer)), code('ADMIN_CONVERSION_INVALID_MP3'));
    await assert.rejects(validateConversionMp3(upload(valid), { ...output(valid), sha256: '0'.repeat(64) }), code('ADMIN_CONVERSION_OUTPUT_CHANGED'));
    await assert.rejects(validateConversionMp3({ ...upload(valid), mimetype: 'audio/flac' }, output(valid)), code('ADMIN_CONVERSION_INVALID_MP3'));
});
test('cancelled validation dispatches no success or storage work', async () => {
    const controller = new AbortController(); controller.abort(); const valid = files.get('stereo')!;
    await assert.rejects(validateConversionMp3(upload(valid), output(valid), controller.signal), (error: any) => error.name === 'AbortError');
});
test('conversion intents reject paths, weak identities, excessive files and extra fields', () => {
    const body = { operationId: randomUUID(), expectedRevision: `cr_${'a'.repeat(43)}`, sourceRevision: `mr_${'1'.repeat(32)}`,
        sourceEtag: '"synthetic"', sourceByteLength: 100, album: null, output: output(files.get('stereo')!) };
    assert.deepEqual(parseConversionIntent(body), body);
    for (const invalid of [{ ...body, sourceEtag: 'W/"weak"' }, { ...body, sourceByteLength: 513 * 1024 ** 2 },
        { ...body, output: { ...body.output, filename: '../private.mp3' } }, { ...body, output: { ...body.output, preset: 'mp3-128' } },
        { ...body, s3Key: 'untrusted' }, { ...body, album: { id: '1'.repeat(24), revision: body.expectedRevision, membershipRevision: 'wrong' } }]) {
        assert.throws(() => parseConversionIntent(invalid), code('ADMIN_CONVERSION_INVALID_INPUT'));
    }
});
test('source identities change with bytes while Album membership ignores successful media replacement', () => {
    const id = '1'.repeat(24), track = { _id: id, s3Key: id, mediaType: 'audio', originalFileName: 'Source.flac' };
    const initial = conversionTrackSourceRevision(track);
    assert.match(initial, /^mr_[a-f0-9]{32}$/);
    assert.notEqual(conversionTrackSourceRevision({ ...track, s3Key: `audio/${id}/${'2'.repeat(24)}` }), initial);
    assert.notEqual(conversionTrackSourceRevision({ ...track, mediaRepresentation: { revision: 'new' } }), initial);
    assert.match(conversionAlbumMembershipRevision([id]), /^cm_[A-Za-z0-9_-]{43}$/);
    assert.equal(conversionAlbumMembershipRevision([id]), conversionAlbumMembershipRevision([id]));
    assert.notEqual(conversionAlbumMembershipRevision([id, '2'.repeat(24)]), conversionAlbumMembershipRevision(['2'.repeat(24), id]));
});
