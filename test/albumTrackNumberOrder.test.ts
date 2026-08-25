import assert from 'node:assert/strict';
import test from 'node:test';

import { sortTrackIdsByEmbeddedTrackNumber } from '../src/services/albumTrackLinkService';

test('embedded Track Numbers define one order independent of administrator input order', () => {
    const numbers = new Map<string, unknown>([
        ['existing-3', 3],
        ['existing-1', 1],
        ['new-1', 1],
        ['new-2-a', 2],
        ['new-2-b', 2],
        ['invalid', 0]
    ]);

    assert.deepEqual(
        sortTrackIdsByEmbeddedTrackNumber(
            ['existing-3', 'invalid', 'new-2-b', 'new-1', 'new-2-a', 'existing-1'],
            numbers
        ),
        ['existing-1', 'new-1', 'new-2-a', 'new-2-b', 'existing-3', 'invalid']
    );
    assert.deepEqual(
        sortTrackIdsByEmbeddedTrackNumber(
            ['new-1', 'existing-1', 'new-2-a', 'new-2-b', 'existing-3', 'invalid'],
            numbers
        ),
        ['existing-1', 'new-1', 'new-2-a', 'new-2-b', 'existing-3', 'invalid']
    );
});
