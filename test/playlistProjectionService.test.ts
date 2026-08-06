import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';

import type { PlaylistListRecord } from '../src/models/playlist';
import { toPlaylistPage } from '../src/services/playlistProjectionService';

const playlistRecord = (
    name: string,
    artworkAudioTrackIds: string[]
): PlaylistListRecord => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    return {
        _id: new ObjectId(),
        name,
        itemCount: artworkAudioTrackIds.length,
        artworkAudioTrackIds,
        revision: 1,
        createdAt: now,
        updatedAt: now
    };
};

test('Playlist artwork projection batches catalog reads and preserves member order', async () => {
    const unavailableTrackId = new ObjectId().toHexString();
    const inheritedTrackId = new ObjectId().toHexString();
    const ownArtworkTrackId = new ObjectId().toHexString();
    const scriptArtworkTrackId = new ObjectId().toHexString();
    const dataArtworkTrackId = new ObjectId().toHexString();
    const albumId = new ObjectId().toHexString();
    const managedImageId = new ObjectId().toHexString();
    const trackCalls: string[][] = [];
    const albumCalls: string[][] = [];

    const page = await toPlaylistPage({
        records: [
            playlistRecord('Inherited first', [unavailableTrackId, inheritedTrackId]),
            playlistRecord('Own first', [ownArtworkTrackId, inheritedTrackId]),
            playlistRecord('Reject script scheme', [scriptArtworkTrackId]),
            playlistRecord('Reject data scheme', [dataArtworkTrackId])
        ],
        nextCursor: 'next'
    }, {
        findReadyTracks: async (audioTrackIds) => {
            trackCalls.push(audioTrackIds);
            return [
                {
                    _id: ObjectId.createFromHexString(inheritedTrackId),
                    coverArtUrl: 'x'.repeat(2_049),
                    albumId
                },
                {
                    _id: ObjectId.createFromHexString(ownArtworkTrackId),
                    coverArtId: managedImageId,
                    albumId
                },
                {
                    _id: ObjectId.createFromHexString(scriptArtworkTrackId),
                    coverArtUrl: 'javascript:alert(1)',
                    albumId
                },
                {
                    _id: ObjectId.createFromHexString(dataArtworkTrackId),
                    coverArtUrl: 'data:image/svg+xml,unsafe',
                    albumId
                }
            ];
        },
        findAlbums: async (albumIds) => {
            albumCalls.push(albumIds);
            return [{
                _id: ObjectId.createFromHexString(albumId),
                coverArtUrl: '/album-art.jpg'
            }];
        }
    });

    assert.deepEqual(trackCalls, [[
        unavailableTrackId,
        inheritedTrackId,
        ownArtworkTrackId,
        scriptArtworkTrackId,
        dataArtworkTrackId
    ]]);
    assert.deepEqual(albumCalls, [[albumId]]);
    assert.deepEqual(page.items.map((item) => item.artworkUrl), [
        '/album-art.jpg',
        `/content/images/${managedImageId}`,
        '/album-art.jpg',
        '/album-art.jpg'
    ]);
    assert.equal(page.nextCursor, 'next');
    assert.equal('artworkAudioTrackIds' in page.items[0], false);
});

test('Playlist artwork projection caps candidates and avoids empty catalog reads', async () => {
    let trackReads = 0;
    let albumReads = 0;
    const empty = await toPlaylistPage({
        records: [playlistRecord('Empty', [])],
        nextCursor: null
    }, {
        findReadyTracks: async () => {
            trackReads += 1;
            return [];
        },
        findAlbums: async () => {
            albumReads += 1;
            return [];
        }
    });
    assert.equal(empty.items[0].artworkUrl, '');
    assert.equal(trackReads, 0);
    assert.equal(albumReads, 0);

    const candidates = Array.from({ length: 501 }, () => new ObjectId().toHexString());
    await toPlaylistPage({
        records: [playlistRecord('Bounded', candidates)],
        nextCursor: null
    }, {
        findReadyTracks: async (audioTrackIds) => {
            trackReads += 1;
            assert.equal(audioTrackIds.length, 500);
            return [];
        },
        findAlbums: async () => {
            albumReads += 1;
            return [];
        }
    });
    assert.equal(trackReads, 1);
    assert.equal(albumReads, 0);

    const recordTrackIds = Array.from({ length: 101 }, () => new ObjectId().toHexString());
    const boundedPage = await toPlaylistPage({
        records: recordTrackIds.map((audioTrackId, index) =>
            playlistRecord(`Page ${index}`, [audioTrackId])
        ),
        nextCursor: 'bounded-next'
    }, {
        findReadyTracks: async (audioTrackIds) => {
            trackReads += 1;
            assert.deepEqual(audioTrackIds, recordTrackIds.slice(0, 100));
            return [];
        },
        findAlbums: async () => {
            albumReads += 1;
            return [];
        }
    });
    assert.equal(boundedPage.items.length, 100);
    assert.equal(boundedPage.nextCursor, 'bounded-next');
    assert.equal(trackReads, 2);
    assert.equal(albumReads, 0);
});
