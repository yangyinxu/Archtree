import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';

import {
    decodeMotionPreviewVideo,
    MotionPreviewDecodeError,
    UndecodableMotionPreviewError
} from '../../src/services/media/motionPreviewDecoder';
import { MOTION_PREVIEW_MAX_HEIGHT, MOTION_PREVIEW_MAX_WIDTH } from '../../src/models/motionPreview';

interface FakeRun {
    stdout?: string;
    stderr?: string;
    code: number;
}

/** Replaces spawn with a scripted FFmpeg run and records every argument list; no binary is needed. */
const fakeDecoder = (context: TestContext, run: FakeRun) => {
    const calls: string[][] = [];
    context.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[]) => {
        calls.push([...args]);
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill: () => { setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; }
        });
        setImmediate(() => {
            if (run.stdout) child.stdout.write(run.stdout);
            if (run.stderr) child.stderr.write(run.stderr);
            setImmediate(() => child.emit('close', run.code, null));
        });
        return child as unknown as ChildProcess;
    });
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    return calls;
};

// The input path is never opened because spawn is replaced.
const file = { path: path.join(tmpdir(), 'archtree-motion-preview-decoder-test.mp4') } as Express.Multer.File;
const completed = 'frame=72\nout_time_us=3000000\nprogress=end\n';

test('the decoder caps decoded frame size with input options placed before -i', async (context) => {
    const calls = fakeDecoder(context, { stdout: completed, code: 0 });
    await decodeMotionPreviewVideo(file, 3000);
    assert.equal(calls.length, 1);
    const [args] = calls;
    const input = args.indexOf('-i');
    const option = (name: string) => {
        const index = args.indexOf(name);
        assert.ok(index >= 0 && index < input, `${name} is an input option`);
        return args[index + 1];
    };
    const maximumPixels = Number(option('-max_pixels'));
    // FFmpeg checks the stride-aligned width of whole macroblocks: 512 × 864 for a portrait 480 × 854 clip.
    assert.ok(Number.isSafeInteger(maximumPixels) && maximumPixels >= 512 * 864, 'a largest legitimate clip still decodes');
    assert.ok(maximumPixels >= MOTION_PREVIEW_MAX_WIDTH * MOTION_PREVIEW_MAX_HEIGHT);
    assert.ok(maximumPixels < 1280 * 720, '720p and larger streams are refused');
    assert.equal(option('-flags2'), '+ignorecrop');
    assert.equal(option('-max_alloc'), '33554432');
    assert.equal(option('-protocol_whitelist'), 'file,pipe');
    assert.equal(option('-format_whitelist'), 'mov');
    assert.equal(args[input + 1], file.path);
    assert.deepEqual(args.slice(-2), ['null', '-']);
});

test('a frame over the pixel cap is an undecodable clip, not a missing decoder', async (context) => {
    fakeDecoder(context, {
        stderr: '[h264 @ 0x1] Picture size 3840x2160 exceeds specified max pixel count 442368, see the documentation if you wish to increase it\n'
            + '[h264 @ 0x1] video_get_buffer: image parameters invalid\n[h264 @ 0x1] get_buffer() failed\n'
            + 'Error while decoding stream #0:0: Invalid argument\n',
        code: 1
    });
    await assert.rejects(decodeMotionPreviewVideo(file, 3000), (error: unknown) =>
        error instanceof UndecodableMotionPreviewError && !(error instanceof MotionPreviewDecodeError));
});

test('an FFmpeg build without the cap options stays a retryable runtime failure', async (context) => {
    fakeDecoder(context, { stderr: "Unrecognized option 'max_pixels'.\nError splitting the argument list: Option not found\n", code: 1 });
    await assert.rejects(decodeMotionPreviewVideo(file, 3000), (error: unknown) =>
        error instanceof MotionPreviewDecodeError && error.code === 'decoder_unavailable');
});
