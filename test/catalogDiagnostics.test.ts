import assert from 'node:assert/strict';
import test from 'node:test';
import { logCatalogFailure } from '../src/controllers/catalogDiagnostics';

test('Catalog diagnostics retain server correlation but exclude raw error and uploaded content', () => {
    const original = console.error;
    const messages: string[] = [];
    console.error = (value: string) => messages.push(value);
    try {
        logCatalogFailure(
            { locals: { requestId: 'server-generated-request-id' } } as any,
            'media_upload_failed',
            Object.assign(new Error('secret uploaded filename and private payload'), {
                code: 'ETIMEDOUT',
                details: { filename: 'private-recording.mp3' }
            })
        );
        assert.deepEqual(JSON.parse(messages[0]), {
            category: 'media_upload_failed',
            requestId: 'server-generated-request-id',
            errorCategory: 'timeout'
        });
        assert.doesNotMatch(messages[0], /secret|filename|payload|private-recording/);

        logCatalogFailure({} as any, 'audio_metadata_unavailable', new Error('untrusted error'));
        assert.deepEqual(JSON.parse(messages[1]), {
            category: 'audio_metadata_unavailable',
            errorCategory: 'internal'
        });
    } finally {
        console.error = original;
    }
});
