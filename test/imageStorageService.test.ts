import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getCoverArtObject,
    isPublicCoverArtAsset
} from '../src/services/imageStorageService';

const readyAsset = (ownerType: 'artist' | 'album' | 'audioTrack' | 'user') => ({
    ownerType,
    uploadStatus: 'ready' as const
});

test('public cover art accepts ready catalog images', () => {
    assert.equal(isPublicCoverArtAsset(readyAsset('artist')), true);
    assert.equal(isPublicCoverArtAsset(readyAsset('album')), true);
    assert.equal(isPublicCoverArtAsset(readyAsset('audioTrack')), true);
});

test('public cover art rejects private avatars and incomplete catalog images', () => {
    assert.equal(isPublicCoverArtAsset(readyAsset('user')), false);
    assert.equal(isPublicCoverArtAsset({ ownerType: 'album', uploadStatus: 'pending' }), false);
    assert.equal(isPublicCoverArtAsset(null), false);
});

test('public cover art rejects a ready private avatar before requesting storage', async () => {
    let storageCalls = 0;
    const result = await getCoverArtObject('private-avatar', {}, {
        findAsset: async () => ({
            ownerType: 'user',
            ownerId: 'listener',
            uploadStatus: 'ready',
            s3Key: 'avatars/private-avatar'
        }) as any,
        getObject: async () => {
            storageCalls += 1;
            throw new Error('Private storage must not be reached.');
        }
    });

    assert.equal(result, null);
    assert.equal(storageCalls, 0);
});
