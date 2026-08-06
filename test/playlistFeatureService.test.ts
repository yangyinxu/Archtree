import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPlaylistFeatureEnabled } from '../src/services/playlistFeatureService';

test('Playlist rollout defaults closed in production and open only for local development', () => {
    assert.equal(isPlaylistFeatureEnabled({ NODE_ENV: 'production' }), false);
    assert.equal(isPlaylistFeatureEnabled({ NODE_ENV: 'test' }), true);
    assert.equal(isPlaylistFeatureEnabled({ NODE_ENV: 'develop' }), true);
});

test('Playlist rollout accepts only explicit true or false overrides', () => {
    assert.equal(isPlaylistFeatureEnabled({
        NODE_ENV: 'production',
        FINITUDE_PLAYLISTS_ENABLED: ' true '
    }), true);
    assert.equal(isPlaylistFeatureEnabled({
        NODE_ENV: 'test',
        FINITUDE_PLAYLISTS_ENABLED: 'false'
    }), false);
    assert.equal(isPlaylistFeatureEnabled({
        NODE_ENV: 'production',
        FINITUDE_PLAYLISTS_ENABLED: '1'
    }), false);
});
