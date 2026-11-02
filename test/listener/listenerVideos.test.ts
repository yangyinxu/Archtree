import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';

import { videos } from '../../src/controllers/listenerController';
import { isListenerVideoCursor } from '../../src/services/listener/listenerContentService';
import { decodeVideoGridCursor, encodeVideoGridCursor } from '../../src/services/content/videoPageService';

test('Video cursors admit only bounded snapshot tokens without trimming or query syntax', () => {
    assert.equal(isListenerVideoCursor('vg1.abc.' + 'a'.repeat(43)), true);
    for (const cursor of ['', '0123456789abcdef01234567', '0123456789ABCDEF01234567', ' vg1.abc.' + 'a'.repeat(43), 'x'.repeat(2_049), '{"$lt":"id"}', 'bad-id']) {
        assert.equal(isListenerVideoCursor(cursor), false);
    }
});

test('Video cursor signatures bind the exact revision and anchor and reject tampering', (t) => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'video-cursor-unit-test-secret';
    t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
    const revision = 'cr_' + 'a'.repeat(43), id = '0123456789abcdef01234567';
    const token = encodeVideoGridCursor(revision, 2, id);
    assert.deepEqual(decodeVideoGridCursor(token), { revision, index: 2, id });
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    assert.throws(() => decodeVideoGridCursor(tampered), (error: any) => error.code === 'invalid_video_cursor');
});

test('Videos rejects untrusted query structures before accessing the catalog', async () => {
    for (const [query, expected] of [
        [{ sort: 'title' }, 'invalid_video_query'],
        [{ limit: '0' }, 'invalid_video_limit'],
        [{ limit: '01' }, 'invalid_video_limit'],
        [{ limit: '2.5' }, 'invalid_video_limit'],
        [{ limit: '1e2' }, 'invalid_video_limit'],
        [{ limit: ['2', '3'] }, 'invalid_video_limit'],
        [{ cursor: { $lt: 'id' } }, 'invalid_video_cursor'],
        [{ cursor: ['0123456789abcdef01234567', '0123456789abcdef01234568'] }, 'invalid_video_cursor'],
        [{ cursor: ' 0123456789abcdef01234567 ' }, 'invalid_video_cursor']
    ] as const) {
        let code = 0; let payload: unknown;
        const response = {
            status(value: number) { code = value; return this; },
            json(value: unknown) { payload = value; return this; }
        } as unknown as Response;
        await videos({ query } as unknown as Request, response);
        assert.equal(code, 400);
        assert.equal((payload as { code: string }).code, expected);
    }
});
