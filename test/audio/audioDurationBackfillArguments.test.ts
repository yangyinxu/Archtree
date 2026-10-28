import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioDurationBackfillArgumentError, parseAudioDurationBackfillArguments } from '../../src/services/audio/audioDurationBackfill';

test('the duration preview accepts only its documented flags and has no write mode', () => {
    assert.deepEqual(parseAudioDurationBackfillArguments([]), { limit: 100, catalogOnly: false });
    assert.deepEqual(parseAudioDurationBackfillArguments(['--after=507f1f77bcf86cd799439011', '--limit=1000', '--catalog-only', '--log=preview.jsonl']),
        { after: '507f1f77bcf86cd799439011', limit: 1000, catalogOnly: true, logPath: 'preview.jsonl' });
    for (const argv of [['--apply'], ['--confirm=BACKFILL'], ['--limit=0'], ['--limit=1001'], ['--limit=1e3'], ['--after=507F1F77BCF86CD799439011'],
        ['--catalog-only=true'], ['--log='], ['--limit=5', '--limit=6'], ['unexpected']]) {
        assert.throws(() => parseAudioDurationBackfillArguments(argv), AudioDurationBackfillArgumentError, argv.join(' '));
    }
});
