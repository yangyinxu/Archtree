import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { extractVideoCoverFrame, processVideoSource, VideoProcessingError } from '../../src/services/media/videoProcessingService';
import { runVideoProcess } from '../../src/services/media/videoProcessRunner';

// Tiny original fixtures are synthetic color movies with tones, not copies of user media.
const fixture = (name: string) => resolve('test/fixtures/video', name);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('real H264 MOV remux strips source metadata and fully validates the unchanged encoded movie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-video-integration-'));
    try {
        const inputPath = fixture('h264-with-tags.mov'), original = digest(await readFile(inputPath));
        const progress: { stage: string; progress: number | null }[] = [];
        const result = await processVideoSource({ inputPath, workDirectory: directory, onProgress(event) { progress.push(event); } });
        assert.equal(result.plan, 'remux'); assert.equal(result.videoCodec, 'h264'); assert.equal(result.audioCodec, 'aac');
        assert.equal(result.width, 160); assert.equal(result.height, 96); assert.ok(Math.abs(result.durationSeconds - 1) < .1);
        assert.ok(progress.some(event => event.stage === 'validate') && progress.some(event => event.stage === 'adapt')); assert.ok(result.cover);
        assert.equal(progress.filter(event => event.stage === 'validate' && event.progress === 100).length, 2, 'both full decodes report confirmed completion');
        assert.ok(progress.some(event => event.stage === 'validate' && event.progress !== null && event.progress > 0 && event.progress < 100));
        const metadata = JSON.parse(await runVideoProcess('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', result.outputPath]));
        assert.ok(!metadata.format.tags.location); assert.equal(metadata.streams.length, 2);
        assert.equal(digest(await readFile(inputPath)), original);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real HEVC is remuxed without transcoding and its embedded still wins over the movie frame', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-hevc-integration-'));
    try {
        const inputPath = fixture('hevc-attached-cover.mp4');
        const result = await processVideoSource({ inputPath, workDirectory: directory });
        assert.equal(result.plan, 'remux'); assert.equal(result.videoCodec, 'hevc'); assert.equal(result.cover?.source, 'embedded');
        const metadata = await sharp(result.cover!.path).metadata(), stats = await sharp(result.cover!.path).stats();
        assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined); assert.equal(metadata.iptc, undefined);
        assert.ok(stats.channels[0].mean > stats.channels[1].mean + 100, 'the red attached image was used');
        const frame = await extractVideoCoverFrame({ inputPath, workDirectory: directory, timeSeconds: .5 });
        const selected = await sharp(frame.path).stats();
        assert.ok(selected.channels[1].mean > selected.channels[0].mean + 50, 'manual selection uses the green movie, not its still');
        await assert.rejects(extractVideoCoverFrame({ inputPath, workDirectory: directory, timeSeconds: 2 }), error =>
            error instanceof VideoProcessingError && error.code === 'invalid_source');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('corrupt source processing never reports a ready result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-invalid-video-'));
    try {
        const inputPath = join(directory, 'declared.MOV'); await writeFile(inputPath, Buffer.from('invalid movie bytes'));
        await assert.rejects(processVideoSource({ inputPath, workDirectory: directory }), error =>
            error instanceof VideoProcessingError && error.code === 'invalid_source');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('audio-only adaptation copies the already compatible movie without another video encode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-video-audio-adaptation-'));
    try {
        const inputPath = join(directory, 'source.mov');
        await runVideoProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fixture('h264-with-tags.mov'), '-c:v', 'copy', '-c:a', 'pcm_s16le', '-y', inputPath]);
        const result = await processVideoSource({ inputPath, workDirectory: directory });
        assert.equal(result.plan, 'transcode'); assert.equal(result.videoCodec, 'h264'); assert.equal(result.audioCodec, 'aac');
        const encodedMovieHash = (path: string) => runVideoProcess('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
        assert.equal(await encodedMovieHash(result.outputPath), await encodedMovieHash(inputPath));
    } finally { await rm(directory, { recursive: true, force: true }); }
});
