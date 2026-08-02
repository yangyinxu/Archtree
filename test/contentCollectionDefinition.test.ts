import assert from 'node:assert/strict';
import test from 'node:test';

import { parseContentCollectionDefinition } from '../src/controllers/contentCollectionController';

test('accepts manual album grids and homogeneous manual lists', () => {
    assert.deepEqual(parseContentCollectionDefinition({
        presentation: 'grid', mode: 'manual', contentType: 'album'
    }), {
        presentation: 'grid', mode: 'manual', contentType: 'album'
    });
    assert.deepEqual(parseContentCollectionDefinition({
        presentation: 'list', mode: 'manual', contentType: 'audioTrack'
    }), {
        presentation: 'list', mode: 'manual', contentType: 'audioTrack'
    });
});

test('rejects soundtrack grids so one contentGrid cannot produce both layouts', () => {
    assert.equal(parseContentCollectionDefinition({
        presentation: 'grid', mode: 'manual', contentType: 'audioTrack'
    }), null);
});

test('allows only the agreed presentation for each downloaded dynamic source', () => {
    assert.deepEqual(parseContentCollectionDefinition({
        presentation: 'grid',
        mode: 'dynamic',
        contentType: 'album',
        dynamicSource: 'downloadedAlbums'
    }), {
        presentation: 'grid',
        mode: 'dynamic',
        contentType: 'album',
        dynamicSource: 'downloadedAlbums'
    });
    assert.deepEqual(parseContentCollectionDefinition({
        presentation: 'list',
        mode: 'dynamic',
        contentType: 'audioTrack',
        dynamicSource: 'downloadedSongs'
    }), {
        presentation: 'list',
        mode: 'dynamic',
        contentType: 'audioTrack',
        dynamicSource: 'downloadedSongs'
    });
    assert.equal(parseContentCollectionDefinition({
        presentation: 'list',
        mode: 'dynamic',
        contentType: 'album',
        dynamicSource: 'downloadedAlbums'
    }), null);
});
