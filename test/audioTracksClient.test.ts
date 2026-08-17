import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const audioTracksClient = readFileSync(
    new URL('../src/public/audio-tracks.js', import.meta.url),
    'utf8'
);

test('Soundtrack filters combine query, storage status, and album assignment', () => {
    assert.match(audioTracksClient, /matchesSearch && matchesStatus && matchesAlbum/);
    assert.match(audioTracksClient, /track-status-filter/);
    assert.match(audioTracksClient, /track-album-filter/);
    assert.match(audioTracksClient, /item\.hidden = !matches/);
});

test('Soundtrack identifiers remain available through copy actions', () => {
    assert.match(audioTracksClient, /querySelectorAll\('\[data-copy-id\]'\)/);
    assert.match(audioTracksClient, /navigator\.clipboard\.writeText/);
});
