import assert from 'node:assert/strict';
import test from 'node:test';

import {
    InvalidSoundtrackVideoError,
    validateParsedSoundtrackVideo,
    validateSoundtrackVideoFile
} from '../src/services/videoMetadataService';

const parsedMetadata = (overrides: Record<string, unknown> = {}) => ({
    format: {
        container: 'MPEG-4',
        codec: 'AAC+<avc1>',
        duration: 123.5,
        hasAudio: true,
        hasVideo: true,
        trackInfo: [
            { type: 1, codecName: 'AAC' },
            { type: 2, codecName: '<avc1>' }
        ],
        tagTypes: [],
        ...overrides
    },
    native: {},
    common: {},
    quality: { warnings: [] }
}) as any;

const uploadFile = (overrides: Partial<Express.Multer.File> = {}) => ({
    fieldname: 'videoFile',
    originalname: 'performance.mp4',
    encoding: '7bit',
    mimetype: 'video/mp4',
    size: 1024,
    buffer: Buffer.from('fixture'),
    ...overrides
}) as Express.Multer.File;

test('accepts only parsed progressive MP4 metadata with AVC video and AAC audio', () => {
    assert.deepEqual(validateParsedSoundtrackVideo(parsedMetadata()), {
        contentType: 'video/mp4',
        durationSeconds: 123.5
    });
    assert.deepEqual(validateParsedSoundtrackVideo(parsedMetadata({ duration: Number.NaN })), {
        contentType: 'video/mp4',
        durationSeconds: null
    });

    for (const format of [
        { container: 'Matroska' },
        { container: 'QuickTime' },
        { container: 'notmp4' },
        { hasAudio: false },
        { hasVideo: false },
        { codec: 'AAC+VP9', trackInfo: [] },
        { codec: 'H.264+Opus', trackInfo: [] }
    ]) {
        assert.throws(
            () => validateParsedSoundtrackVideo(parsedMetadata(format)),
            InvalidSoundtrackVideoError
        );
    }
});

test('validates declared size and MIME before invoking the bounded parser', async () => {
    let parserCalls = 0;
    const parser = async () => {
        parserCalls += 1;
        return parsedMetadata();
    };

    await assert.rejects(validateSoundtrackVideoFile(uploadFile({ size: 0 }), parser));
    await assert.rejects(validateSoundtrackVideoFile(
        uploadFile({ mimetype: 'application/octet-stream' }),
        parser
    ));
    assert.equal(parserCalls, 0);
    assert.deepEqual(await validateSoundtrackVideoFile(uploadFile(), parser), {
        contentType: 'video/mp4',
        durationSeconds: 123.5
    });
    assert.equal(parserCalls, 1);
});

test('maps parser failures to a bounded client-safe validation error', async () => {
    await assert.rejects(
        validateSoundtrackVideoFile(uploadFile(), async () => {
            throw new Error('private parser detail');
        }),
        (error: any) => error instanceof InvalidSoundtrackVideoError
            && !String(error.message).includes('private parser detail')
    );
});
