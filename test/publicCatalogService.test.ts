import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isReadyPublicAudioTrack,
    projectPublicAlbums,
    toPublicAlbum,
    toPublicArtist,
    toPublicAudioTrack,
    toPublicFeedPost
} from '../src/services/publicCatalogService';

const forbiddenKeys = new Set([
    'createdBy',
    'updatedBy',
    'coverArtId',
    's3Key',
    'uploadStatus',
    'uploadUpdatedAt',
    'uploadError',
    'originalFileName',
    'contentType'
]);

const collectKeys = (value: unknown, keys = new Set<string>()) => {
    if (!value || typeof value !== 'object') return keys;
    if (Array.isArray(value)) {
        for (const item of value) collectKeys(item, keys);
        return keys;
    }
    for (const [key, nested] of Object.entries(value)) {
        keys.add(key);
        collectKeys(nested, keys);
    }
    return keys;
};

const assertNoInternalFields = (value: unknown) => {
    const keys = collectKeys(value);
    for (const key of forbiddenKeys) assert.equal(keys.has(key), false, `${key} must stay private`);
};

const objectIdFor = (value: number) => value.toString(16).padStart(24, '0');

test('public Artist and Album DTOs expose only database-confirmed relationships', () => {
    const artist = toPublicArtist({
        _id: '64b000000000000000000001',
        name: 'Public Artist',
        albumIds: [
            '64B000000000000000000002',
            '64b000000000000000000003',
            'not-an-object-id'
        ],
        bio: 'Biography',
        coverArtId: '64b000000000000000000004',
        coverArtUrl: '/stale.jpg',
        birthDate: { year: 1990, month: 13, day: 2 },
        createdBy: 'private-owner'
    }, new Set(['64b000000000000000000002']));
    const album = toPublicAlbum({
        _id: '64b000000000000000000002',
        title: 'Public Album',
        coverArtId: '64b000000000000000000005',
        audioTrackIds: [
            '64b000000000000000000006',
            '64b000000000000000000007'
        ],
        releaseDate: { year: 2026, month: 8, day: 3 },
        createdBy: 'private-owner'
    }, ['64B000000000000000000006']);

    assert.deepEqual(artist.albumIds, ['64b000000000000000000002']);
    assert.equal(artist.coverArtUrl, '/content/images/64b000000000000000000004');
    assert.deepEqual(artist.birthDate, { year: 1990, day: 2 });
    assert.deepEqual(album.audioTrackIds, ['64b000000000000000000006']);
    assert.equal(album.coverArtUrl, '/content/images/64b000000000000000000005');
    assertNoInternalFields({ artist, album });
});

test('legacy Albums receive independent 500-track fallback windows beyond 10,000 total', async () => {
    const albums = Array.from({ length: 21 }, (_, albumIndex) => ({
        _id: objectIdFor(albumIndex + 1),
        title: `Legacy Album ${albumIndex + 1}`,
        audioTrackIds: []
    }));
    const fallbackCalls: Array<{ albumId: string; limit: number }> = [];
    let declaredCalls = 0;

    const projected = await projectPublicAlbums(albums, {
        findReadyDeclaredTracks: async () => {
            declaredCalls += 1;
            return [];
        },
        findReadyFallbackTracksForAlbum: async (albumId, limit) => {
            fallbackCalls.push({ albumId, limit });
            const albumIndex = albums.findIndex((album) => album._id === albumId);
            return Array.from({ length: 501 }, (_, trackIndex) => ({
                _id: objectIdFor(100_000 + albumIndex * 1_000 + trackIndex),
                albumId,
                uploadStatus: 'ready',
                s3Key: `audio/${albumId}/${trackIndex}`
            }));
        }
    });

    assert.equal(declaredCalls, 0);
    assert.equal(fallbackCalls.length, albums.length);
    assert.deepEqual(fallbackCalls.map((call) => call.albumId), albums.map((album) => album._id));
    assert.equal(fallbackCalls.every((call) => call.limit === 500), true);
    assert.equal(projected.reduce((total, album) => total + album.audioTrackIds.length, 0), 10_500);
    for (const [albumIndex, album] of projected.entries()) {
        assert.equal(album.audioTrackIds.length, 500);
        assert.equal(album.audioTrackIds[0], objectIdFor(100_000 + albumIndex * 1_000));
        assert.equal(album.audioTrackIds[499], objectIdFor(100_499 + albumIndex * 1_000));
    }
});

test('a lifecycle Album with an empty canonical order never uses reverse-link fallback', async () => {
    const albumId = objectIdFor(22);
    let fallbackCalls = 0;
    const [projected] = await projectPublicAlbums([{
        _id: albumId,
        title: 'Lifecycle Album',
        audioTrackIds: [],
        lifecycleStatus: 'ready'
    }], {
        findReadyDeclaredTracks: async () => [],
        findReadyFallbackTracksForAlbum: async () => {
            fallbackCalls += 1;
            return [{ _id: objectIdFor(22_001), albumId }];
        }
    });

    assert.equal(fallbackCalls, 0);
    assert.deepEqual(projected.audioTrackIds, []);
});

test('an Album with declared track IDs never appends reverse-linked fallback tracks', async () => {
    const albumId = objectIdFor(30);
    const declaredReadyId = objectIdFor(30_001);
    const declaredUnavailableId = objectIdFor(30_002);
    let fallbackCalls = 0;

    const [album] = await projectPublicAlbums([{
        _id: albumId,
        title: 'Declared Order Album',
        audioTrackIds: [declaredReadyId, declaredUnavailableId]
    }], {
        findReadyDeclaredTracks: async (trackIds) => {
            assert.deepEqual(trackIds, [declaredReadyId, declaredUnavailableId]);
            return [{ _id: declaredReadyId }];
        },
        findReadyFallbackTracksForAlbum: async () => {
            fallbackCalls += 1;
            return [{
                _id: objectIdFor(30_003),
                albumId,
                uploadStatus: 'ready',
                s3Key: 'audio/reverse-linked'
            }];
        }
    });

    assert.equal(fallbackCalls, 0);
    assert.deepEqual(album.audioTrackIds, [declaredReadyId]);
});

test('public Soundtrack DTO requires a ready record with a traceable object key', () => {
    const pending = {
        _id: '64b000000000000000000010',
        title: 'Pending Track',
        uploadStatus: 'pending',
        s3Key: 'pending-key'
    };
    const missingObjectKey = {
        ...pending,
        uploadStatus: 'ready',
        s3Key: ''
    };
    assert.equal(isReadyPublicAudioTrack(pending), false);
    assert.equal(toPublicAudioTrack(pending), null);
    assert.equal(isReadyPublicAudioTrack(missingObjectKey), false);
    assert.equal(toPublicAudioTrack(missingObjectKey), null);
    assert.equal(isReadyPublicAudioTrack({
        ...pending,
        uploadStatus: 'ready',
        s3Key: pending._id,
        publicationStatus: null
    }), false);

    const ready = toPublicAudioTrack({
        _id: '64b000000000000000000011',
        title: 'Ready Track',
        artistIds: ['64B000000000000000000012', 'invalid'],
        genres: ['Ambient', ''],
        albumId: '64B000000000000000000013',
        releaseDate: { year: 2026 },
        duration: '03:15',
        format: { type: 'FLAC', bitrate: 960 },
        coverArtUrl: '',
        uploadStatus: 'ready',
        s3Key: '64b000000000000000000011',
        uploadError: 'must not leak',
        originalFileName: 'private-name.flac',
        createdBy: 'private-owner'
    }, {
        coverArtId: '64b000000000000000000014'
    });

    assert.ok(ready);
    assert.equal(ready.displayCoverArtUrl, '/content/images/64b000000000000000000014');
    assert.equal(ready.albumId, '64b000000000000000000013');
    assert.deepEqual(ready.artistIds, ['64b000000000000000000012']);
    assert.deepEqual(ready.format, { type: 'FLAC', bitrate: 960 });
    assertNoInternalFields(ready);
});

test('public Feed Post DTO retains only the existing client contract', () => {
    const post = toPublicFeedPost({
        _id: '64b000000000000000000020',
        title: 'Public Post',
        description: 'Public description',
        mainImageUrl: '/main.jpg',
        imageUrls: ['/one.jpg', ''],
        userId: '64b000000000000000000021',
        createdAt: new Date('2026-08-03T12:00:00.000Z'),
        moderationNotes: 'private',
        createdBy: 'private-owner'
    });

    assert.deepEqual(Object.keys(post), [
        '_id',
        'title',
        'description',
        'mainImageUrl',
        'imageUrls',
        'userId',
        'createdAt'
    ]);
    assert.equal(post.createdAt, '2026-08-03T12:00:00.000Z');
    assertNoInternalFields(post);
});
