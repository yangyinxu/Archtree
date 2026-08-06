import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';

import { getDb } from '../src/infrastructure/database';
import { Artist } from '../src/models/artist';
import { cleanupDeletedContentReferences } from '../src/services/contentReferenceService';
import { reconcileContentReferences } from '../src/services/contentReferenceReconciliationService';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-content-reference-cleanup-test');
});

beforeEach(async () => {
    await Promise.all([
        'albums',
        'audioTracks',
        'artists',
        'carousels',
        'contentCollections',
        'pages',
        'playlists',
        'accountMutations',
        'userActivity',
        'userSaves',
        'users'
    ].map(collection => getDb()!.collection(collection).deleteMany({})));
});

after(async () => {
    await harness?.stop();
});

test('deleted Album and Soundtrack references leave only unrelated manual Grid/List items', async () => {
    const albumId = new ObjectId();
    const audioTrackId = new ObjectId();
    const retainedAlbumId = new ObjectId();
    const secondRetainedAlbumId = new ObjectId();
    const retainedAudioTrackId = new ObjectId();
    await getDb()!.collection('contentCollections').insertMany([
        {
            _id: new ObjectId(),
            mode: 'manual',
            contentType: 'album',
            items: [
                { contentType: 'album', contentId: albumId.toHexString(), order: 0 },
                { contentType: 'album', contentId: retainedAlbumId.toHexString(), order: 1 },
                { contentType: 'album', contentId: secondRetainedAlbumId.toHexString(), order: 2 }
            ]
        },
        {
            _id: new ObjectId(),
            mode: 'manual',
            contentType: 'audioTrack',
            items: [
                { contentType: 'audioTrack', contentId: audioTrackId, order: 0 },
                { contentType: 'audioTrack', contentId: retainedAudioTrackId.toHexString(), order: 1 }
            ]
        },
        {
            _id: new ObjectId(),
            mode: 'dynamic',
            contentType: 'album',
            items: [{ contentType: 'album', contentId: albumId.toHexString(), order: 0 }]
        }
    ]);
    const legacyArtistId = new ObjectId();
    const legacyTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({
            _id: legacyArtistId,
            albumIds: [albumId, retainedAlbumId.toHexString()]
        }),
        getDb()!.collection('audioTracks').insertOne({
            _id: legacyTrackId,
            albumId
        }),
        getDb()!.collection('albums').insertOne({
            _id: retainedAlbumId,
            audioTrackIds: [audioTrackId, retainedAudioTrackId.toHexString()]
        }),
        getDb()!.collection('userSaves').insertMany([
            { _id: new ObjectId(), contentType: 'album', contentId: albumId },
            { _id: new ObjectId(), contentType: 'audioTrack', contentId: audioTrackId },
            { _id: new ObjectId(), contentType: 'album', contentId: retainedAlbumId }
        ]),
        getDb()!.collection('userActivity').insertOne({
            _id: new ObjectId(),
            recentlySaved: [
                { contentType: 'album', contentId: albumId },
                { contentType: 'album', contentId: retainedAlbumId }
            ],
            recentlyPlayed: [
                { contentType: 'audioTrack', contentId: audioTrackId },
                { contentType: 'audioTrack', contentId: retainedAudioTrackId }
            ]
        }),
        getDb()!.collection('playlists').insertOne({
            _id: new ObjectId(),
            ownerUserId: new ObjectId(),
            items: [
                { itemId: 'deleted-track', audioTrackId: audioTrackId.toHexString() },
                { itemId: 'retained-track', audioTrackId: retainedAudioTrackId.toHexString() }
            ],
            revision: 1
        })
    ]);

    const uppercaseAlbumId = albumId.toHexString().toUpperCase();
    const uppercaseAudioTrackId = audioTrackId.toHexString().toUpperCase();
    await cleanupDeletedContentReferences('album', uppercaseAlbumId);
    await cleanupDeletedContentReferences('audioTrack', uppercaseAudioTrackId);
    await cleanupDeletedContentReferences('album', uppercaseAlbumId);
    await cleanupDeletedContentReferences('audioTrack', uppercaseAudioTrackId);

    const collections = await getDb()!.collection('contentCollections')
        .find()
        .sort({ contentType: 1, mode: 1 })
        .toArray();
    const manualAlbum = collections.find(collection =>
        collection.mode === 'manual' && collection.contentType === 'album'
    );
    const manualAudioTrack = collections.find(collection =>
        collection.mode === 'manual' && collection.contentType === 'audioTrack'
    );
    const dynamicAlbum = collections.find(collection => collection.mode === 'dynamic');

    assert.deepEqual(
        manualAlbum!.items.map((item: any) => ({
            contentId: String(item.contentId),
            order: item.order
        })),
        [
            { contentId: retainedAlbumId.toHexString(), order: 0 },
            { contentId: secondRetainedAlbumId.toHexString(), order: 1 }
        ]
    );
    assert.deepEqual(
        manualAudioTrack!.items.map((item: any) => ({
            contentId: String(item.contentId),
            order: item.order
        })),
        [{ contentId: retainedAudioTrackId.toHexString(), order: 0 }]
    );
    assert.deepEqual(
        dynamicAlbum!.items.map((item: any) => String(item.contentId)),
        [albumId.toHexString()]
    );
    assert.deepEqual(
        (await getDb()!.collection('artists').findOne({ _id: legacyArtistId }))!.albumIds,
        [retainedAlbumId.toHexString()]
    );
    assert.equal(
        (await getDb()!.collection('audioTracks').findOne({ _id: legacyTrackId }))!.albumId,
        undefined
    );
    assert.deepEqual(
        (await getDb()!.collection('albums').findOne({ _id: retainedAlbumId }))!.audioTrackIds,
        [retainedAudioTrackId.toHexString()]
    );
    assert.deepEqual(
        (await getDb()!.collection('userSaves').find().sort({ contentType: 1 }).toArray())
            .map(save => ({ contentType: save.contentType, contentId: String(save.contentId) })),
        [{ contentType: 'album', contentId: retainedAlbumId.toHexString() }]
    );
    const activity = await getDb()!.collection('userActivity').findOne({});
    assert.deepEqual(
        activity!.recentlySaved.map((entry: any) => String(entry.contentId)),
        [retainedAlbumId.toHexString()]
    );
    assert.deepEqual(
        activity!.recentlyPlayed.map((entry: any) => String(entry.contentId)),
        [retainedAudioTrackId.toHexString()]
    );
    const playlist = await getDb()!.collection('playlists').findOne({});
    assert.deepEqual(
        playlist!.items.map((item: any) => item.audioTrackId),
        [retainedAudioTrackId.toHexString()]
    );
    assert.equal(playlist!.revision, 2);
});

test('reconciliation reports both Album/Track mismatches and skips only true legacy fallback', async () => {
    const albumId = new ObjectId();
    const readyEmptyAlbumId = new ObjectId();
    const legacyEmptyAlbumId = new ObjectId();
    const staleAlbumId = new ObjectId();
    const actualAlbumId = new ObjectId();
    const retainedTrackId = new ObjectId();
    const missingMembershipId = new ObjectId();
    const readyEmptyMissingId = new ObjectId();
    const legacyFallbackId = new ObjectId();
    const staleMembershipId = new ObjectId();
    const pendingTrackId = new ObjectId();
    const legacyPublicationTrackId = new ObjectId();
    const nullPublicationTrackId = new ObjectId();
    const emptyPublicationTrackId = new ObjectId();
    const unknownPublicationTrackId = new ObjectId();
    await Promise.all([
        getDb()!.collection('albums').insertMany([
            { _id: albumId, audioTrackIds: [retainedTrackId.toHexString()] },
            {
                _id: readyEmptyAlbumId,
                audioTrackIds: [],
                lifecycleStatus: 'ready'
            },
            { _id: legacyEmptyAlbumId, audioTrackIds: [] },
            {
                _id: staleAlbumId,
                audioTrackIds: [staleMembershipId.toHexString()],
                lifecycleStatus: 'ready'
            },
            {
                _id: actualAlbumId,
                audioTrackIds: [staleMembershipId.toHexString()],
                lifecycleStatus: 'ready'
            }
        ]),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: retainedTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: 'ready'
            },
            {
                _id: missingMembershipId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: 'ready'
            },
            {
                _id: pendingTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: 'pending'
            },
            {
                _id: legacyPublicationTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready'
            },
            {
                _id: nullPublicationTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: null
            },
            {
                _id: emptyPublicationTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: ''
            },
            {
                _id: unknownPublicationTrackId,
                albumId: albumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: 'unknown'
            },
            {
                _id: readyEmptyMissingId,
                albumId: readyEmptyAlbumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: 'ready'
            },
            {
                _id: legacyFallbackId,
                albumId: legacyEmptyAlbumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: 'ready'
            },
            {
                _id: staleMembershipId,
                albumId: actualAlbumId.toHexString(),
                uploadStatus: 'ready',
                publicationStatus: 'ready'
            }
        ])
    ]);

    const report = await reconcileContentReferences();

    assert.deepEqual(
        report.missingAlbumTrackMemberships
            .sort((left, right) => left.audioTrackId.localeCompare(right.audioTrackId)),
        [
            {
                audioTrackId: missingMembershipId.toHexString(),
                albumId: albumId.toHexString()
            },
            {
                audioTrackId: legacyPublicationTrackId.toHexString(),
                albumId: albumId.toHexString()
            },
            {
                audioTrackId: readyEmptyMissingId.toHexString(),
                albumId: readyEmptyAlbumId.toHexString()
            }
        ].sort((left, right) => left.audioTrackId.localeCompare(right.audioTrackId))
    );
    assert.deepEqual(report.staleAlbumTrackMemberships, [{
        albumId: staleAlbumId.toHexString(),
        audioTrackId: staleMembershipId.toHexString(),
        trackAlbumId: actualAlbumId.toHexString()
    }]);
});

test('Artist deletion removes reverse track references and preserves unrelated carousel configuration', async () => {
    const artistId = new ObjectId();
    const retainedArtistId = new ObjectId();
    const affectedCarouselId = new ObjectId();
    const retainedCarouselId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertMany([
            { _id: artistId, name: 'Deleted Artist', albumIds: [] },
            { _id: retainedArtistId, name: 'Retained Artist', albumIds: [] }
        ]),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: new ObjectId(),
                artistIds: [artistId.toHexString(), retainedArtistId.toHexString()]
            },
            {
                _id: new ObjectId(),
                artistIds: [artistId, retainedArtistId]
            }
        ]),
        getDb()!.collection('carousels').insertMany([
            {
                _id: affectedCarouselId,
                name: 'Affected',
                mode: 'artist',
                artistConfig: {
                    artistId: artistId.toHexString(),
                    contentType: 'audioTrack',
                    sort: 'titleAsc',
                    limit: 20
                },
                items: []
            },
            {
                _id: retainedCarouselId,
                name: 'Retained',
                mode: 'artist',
                artistConfig: {
                    artistId: retainedArtistId.toHexString(),
                    contentType: 'album',
                    sort: 'releaseDateDesc',
                    limit: 20
                },
                items: []
            }
        ])
    ]);

    await Artist.deleteById(artistId.toHexString().toUpperCase());
    await Artist.deleteById(artistId.toHexString().toUpperCase());

    const tracks = await getDb()!.collection('audioTracks').find().toArray();
    assert.equal(await getDb()!.collection('artists').findOne({ _id: artistId }), null);
    assert.deepEqual(
        tracks.map(track => track.artistIds.map((id: unknown) => String(id))),
        [
            [retainedArtistId.toHexString()],
            [retainedArtistId.toHexString()]
        ]
    );

    const affectedCarousel = await getDb()!.collection('carousels').findOne({
        _id: affectedCarouselId
    });
    const retainedCarousel = await getDb()!.collection('carousels').findOne({
        _id: retainedCarouselId
    });
    assert.equal(affectedCarousel!.mode, 'manual');
    assert.deepEqual(affectedCarousel!.items, []);
    assert.equal(affectedCarousel!.artistConfig, undefined);
    assert.equal(retainedCarousel!.mode, 'artist');
    assert.equal(
        retainedCarousel!.artistConfig.artistId,
        retainedArtistId.toHexString()
    );
});

test('read-only reconciliation reports dangling track Artists and manual Grid/List items', async () => {
    const artistId = new ObjectId();
    const missingArtistId = new ObjectId();
    const audioTrackId = new ObjectId();
    const retainedAudioTrackId = new ObjectId();
    const missingAudioTrackId = new ObjectId();
    const albumId = new ObjectId();
    const missingAlbumId = new ObjectId();
    const albumCollectionId = new ObjectId();
    const audioTrackCollectionId = new ObjectId();
    const dynamicCollectionId = new ObjectId();
    await Promise.all([
        getDb()!.collection('artists').insertOne({ _id: artistId, name: 'Present' }),
        getDb()!.collection('albums').insertOne({ _id: albumId, title: 'Present' }),
        getDb()!.collection('audioTracks').insertMany([
            {
                _id: audioTrackId,
                artistIds: [artistId.toHexString(), missingArtistId, 'malformed-artist-id']
            },
            { _id: retainedAudioTrackId, artistIds: [artistId.toHexString()] }
        ]),
        getDb()!.collection('contentCollections').insertMany([
            {
                _id: albumCollectionId,
                mode: 'manual',
                contentType: 'album',
                items: [
                    { contentType: 'album', contentId: albumId.toHexString(), order: 0 },
                    { contentType: 'album', contentId: missingAlbumId, order: 1 }
                ]
            },
            {
                _id: audioTrackCollectionId,
                mode: 'manual',
                contentType: 'audioTrack',
                items: [
                    {
                        contentType: 'audioTrack',
                        contentId: retainedAudioTrackId.toHexString(),
                        order: 0
                    },
                    {
                        contentType: 'audioTrack',
                        contentId: missingAudioTrackId.toHexString(),
                        order: 1
                    }
                ]
            },
            {
                _id: dynamicCollectionId,
                mode: 'dynamic',
                contentType: 'album',
                items: [
                    { contentType: 'album', contentId: missingAlbumId.toHexString(), order: 0 }
                ]
            }
        ])
    ]);
    const tracksBefore = await getDb()!.collection('audioTracks').find().sort({ _id: 1 }).toArray();
    const collectionsBefore = await getDb()!.collection('contentCollections')
        .find()
        .sort({ _id: 1 })
        .toArray();

    const report = await reconcileContentReferences();

    assert.equal(report.readOnly, true);
    assert.equal(report.truncated, false);
    assert.deepEqual(report.danglingTrackArtists, [
        { audioTrackId: audioTrackId.toHexString(), artistId: missingArtistId.toHexString() },
        { audioTrackId: audioTrackId.toHexString(), artistId: 'malformed-artist-id' }
    ]);
    assert.deepEqual(
        report.danglingContentCollectionItems
            .sort((left, right) => left.contentType.localeCompare(right.contentType)),
        [
            {
                contentCollectionId: albumCollectionId.toHexString(),
                contentType: 'album',
                contentId: missingAlbumId.toHexString(),
                order: 1
            },
            {
                contentCollectionId: audioTrackCollectionId.toHexString(),
                contentType: 'audioTrack',
                contentId: missingAudioTrackId.toHexString(),
                order: 1
            }
        ]
    );
    assert.deepEqual(
        await getDb()!.collection('audioTracks').find().sort({ _id: 1 }).toArray(),
        tracksBefore
    );
    assert.deepEqual(
        await getDb()!.collection('contentCollections').find().sort({ _id: 1 }).toArray(),
        collectionsBefore
    );
});

test('read-only reconciliation reports malformed, missing, and presentation-mismatched Page targets', async () => {
    const carouselId = new ObjectId();
    const missingCarouselId = new ObjectId();
    const gridId = new ObjectId();
    const missingCollectionId = new ObjectId();
    const pageId = new ObjectId();
    await Promise.all([
        getDb()!.collection('carousels').insertOne({
            _id: carouselId,
            mode: 'manual',
            items: []
        }),
        getDb()!.collection('contentCollections').insertOne({
            _id: gridId,
            presentation: 'grid',
            mode: 'manual',
            items: []
        }),
        getDb()!.collection('pages').insertOne({
            _id: pageId,
            slug: 'home',
            items: [
                { itemType: 'carousel', carouselId: carouselId.toHexString(), order: 0 },
                { itemType: 'carousel', carouselId: missingCarouselId.toHexString(), order: 1 },
                { itemType: 'carousel', carouselId: 'bad-carousel', order: 2 },
                { itemType: 'grid', collectionId: gridId.toHexString(), order: 3 },
                { itemType: 'list', collectionId: gridId.toHexString(), order: 4 },
                { itemType: 'grid', collectionId: missingCollectionId.toHexString(), order: 5 },
                { itemType: 'list', collectionId: 'bad-collection', order: 6 }
            ]
        })
    ]);
    const pageBefore = await getDb()!.collection('pages').findOne({ _id: pageId });

    const report = await reconcileContentReferences();

    assert.deepEqual(report.danglingPageCarouselReferences, [
        {
            pageId: pageId.toHexString(),
            slug: 'home',
            carouselId: missingCarouselId.toHexString(),
            order: 1,
            reason: 'missing'
        },
        {
            pageId: pageId.toHexString(),
            slug: 'home',
            carouselId: 'bad-carousel',
            order: 2,
            reason: 'malformed'
        }
    ]);
    assert.deepEqual(report.danglingPageContentCollectionReferences, [
        {
            pageId: pageId.toHexString(),
            slug: 'home',
            itemType: 'list',
            contentCollectionId: gridId.toHexString(),
            order: 4,
            reason: 'presentationMismatch'
        },
        {
            pageId: pageId.toHexString(),
            slug: 'home',
            itemType: 'grid',
            contentCollectionId: missingCollectionId.toHexString(),
            order: 5,
            reason: 'missing'
        },
        {
            pageId: pageId.toHexString(),
            slug: 'home',
            itemType: 'list',
            contentCollectionId: 'bad-collection',
            order: 6,
            reason: 'malformed'
        }
    ]);
    assert.deepEqual(await getDb()!.collection('pages').findOne({ _id: pageId }), pageBefore);
});

test('bounded reconciliation exact-checks Page targets beyond source scans', async () => {
    const previousLimit = process.env.MAX_RECONCILIATION_OBJECTS;
    process.env.MAX_RECONCILIATION_OBJECTS = '2';
    const carouselIds = [
        new ObjectId('000000000000000000000061'),
        new ObjectId('000000000000000000000062'),
        new ObjectId('000000000000000000000063')
    ];
    const collectionIds = [
        new ObjectId('000000000000000000000071'),
        new ObjectId('000000000000000000000072'),
        new ObjectId('000000000000000000000073')
    ];
    try {
        await Promise.all([
            getDb()!.collection('carousels').insertMany(carouselIds.map((_id) => ({
                _id,
                mode: 'manual',
                items: []
            }))),
            getDb()!.collection('contentCollections').insertMany(collectionIds.map((_id) => ({
                _id,
                presentation: 'grid',
                mode: 'manual',
                items: []
            }))),
            getDb()!.collection('pages').insertOne({
                _id: new ObjectId(),
                slug: 'home',
                items: [
                    {
                        itemType: 'carousel',
                        carouselId: carouselIds[2].toHexString(),
                        order: 0
                    },
                    {
                        itemType: 'grid',
                        collectionId: collectionIds[2].toHexString(),
                        order: 1
                    }
                ]
            })
        ]);

        const report = await reconcileContentReferences();

        assert.equal(report.truncated, true);
        assert.deepEqual(report.danglingPageCarouselReferences, []);
        assert.deepEqual(report.danglingPageContentCollectionReferences, []);
    } finally {
        if (previousLimit === undefined) {
            delete process.env.MAX_RECONCILIATION_OBJECTS;
        } else {
            process.env.MAX_RECONCILIATION_OBJECTS = previousLimit;
        }
    }
});

test('Page reconciliation shares the embedded-reference and report-wide finding budgets', async () => {
    const previousLimit = process.env.MAX_RECONCILIATION_OBJECTS;
    const previousReferenceLimit = process.env.MAX_RECONCILIATION_REFERENCES;
    process.env.MAX_RECONCILIATION_OBJECTS = '5';
    process.env.MAX_RECONCILIATION_REFERENCES = '2';
    try {
        await getDb()!.collection('pages').insertOne({
            _id: new ObjectId(),
            slug: 'home',
            items: [new ObjectId(), new ObjectId(), new ObjectId()].map((carouselId, order) => ({
                itemType: 'carousel',
                carouselId: carouselId.toHexString(),
                order
            }))
        });

        const report = await reconcileContentReferences();

        assert.equal(report.truncated, true);
        assert.equal(report.danglingPageCarouselReferences.length, 2);
        assert.equal(
            Object.values(report)
                .filter(Array.isArray)
                .reduce((total, items) => total + items.length, 0),
            2
        );
    } finally {
        if (previousLimit === undefined) {
            delete process.env.MAX_RECONCILIATION_OBJECTS;
        } else {
            process.env.MAX_RECONCILIATION_OBJECTS = previousLimit;
        }
        if (previousReferenceLimit === undefined) {
            delete process.env.MAX_RECONCILIATION_REFERENCES;
        } else {
            process.env.MAX_RECONCILIATION_REFERENCES = previousReferenceLimit;
        }
    }
});

test('bounded reconciliation verifies referenced catalog records beyond each source scan', async () => {
    const previousLimit = process.env.MAX_RECONCILIATION_OBJECTS;
    process.env.MAX_RECONCILIATION_OBJECTS = '2';
    const firstArtistId = new ObjectId('000000000000000000000001');
    const secondArtistId = new ObjectId('000000000000000000000002');
    const referencedArtistId = new ObjectId('000000000000000000000003');
    const firstAlbumId = new ObjectId('000000000000000000000004');
    const secondAlbumId = new ObjectId('000000000000000000000005');
    const referencedAlbumId = new ObjectId('000000000000000000000006');
    const firstTrackId = new ObjectId('000000000000000000000007');
    const secondTrackId = new ObjectId('000000000000000000000008');
    const referencedTrackId = new ObjectId('000000000000000000000009');
    try {
        await Promise.all([
            getDb()!.collection('artists').insertMany([
                { _id: firstArtistId, name: 'First' },
                { _id: secondArtistId, name: 'Second' },
                { _id: referencedArtistId, name: 'Referenced' }
            ]),
            getDb()!.collection('albums').insertMany([
                { _id: firstAlbumId, title: 'First' },
                { _id: secondAlbumId, title: 'Second' },
                { _id: referencedAlbumId, title: 'Referenced' }
            ]),
            getDb()!.collection('audioTracks').insertMany([
                { _id: firstTrackId, artistIds: [referencedArtistId.toHexString()] },
                { _id: secondTrackId, artistIds: [] },
                { _id: referencedTrackId, artistIds: [] }
            ]),
            getDb()!.collection('contentCollections').insertMany([
                {
                    _id: new ObjectId(),
                    mode: 'manual',
                    contentType: 'album',
                    items: [
                        { contentType: 'album', contentId: referencedAlbumId.toHexString(), order: 0 }
                    ]
                },
                {
                    _id: new ObjectId(),
                    mode: 'manual',
                    contentType: 'audioTrack',
                    items: [
                        { contentType: 'audioTrack', contentId: referencedTrackId.toHexString(), order: 0 }
                    ]
                }
            ])
        ]);

        const report = await reconcileContentReferences();

        assert.equal(report.limit, 2);
        assert.equal(report.truncated, true);
        assert.deepEqual(report.danglingTrackArtists, []);
        assert.deepEqual(report.danglingContentCollectionItems, []);
    } finally {
        if (previousLimit === undefined) {
            delete process.env.MAX_RECONCILIATION_OBJECTS;
        } else {
            process.env.MAX_RECONCILIATION_OBJECTS = previousLimit;
        }
    }
});

test('bounded reconciliation exact-checks every legacy catalog relation and receipt target', async () => {
    const previousLimit = process.env.MAX_RECONCILIATION_OBJECTS;
    process.env.MAX_RECONCILIATION_OBJECTS = '2';
    const firstAlbumId = new ObjectId('000000000000000000000011');
    const secondAlbumId = new ObjectId('000000000000000000000012');
    const referencedAlbumId = new ObjectId('000000000000000000000013');
    const firstTrackId = new ObjectId('000000000000000000000021');
    const secondTrackId = new ObjectId('000000000000000000000022');
    const referencedTrackId = new ObjectId('000000000000000000000023');
    const firstArtistId = new ObjectId('000000000000000000000031');
    const secondArtistId = new ObjectId('000000000000000000000032');
    const referencedArtistId = new ObjectId('000000000000000000000033');
    const firstOwnerId = new ObjectId('000000000000000000000041');
    const secondOwnerId = new ObjectId('000000000000000000000042');
    const referencedOwnerId = new ObjectId('000000000000000000000043');
    const firstPlaylistId = new ObjectId('000000000000000000000051');
    const secondPlaylistId = new ObjectId('000000000000000000000052');
    const referencedPlaylistId = new ObjectId('000000000000000000000053');
    try {
        await Promise.all([
            getDb()!.collection('albums').insertMany([
                { _id: firstAlbumId, audioTrackIds: [referencedTrackId] },
                { _id: secondAlbumId, audioTrackIds: [] },
                { _id: referencedAlbumId, audioTrackIds: [] }
            ]),
            getDb()!.collection('audioTracks').insertMany([
                {
                    _id: firstTrackId,
                    albumId: referencedAlbumId,
                    artistIds: [referencedArtistId]
                },
                { _id: secondTrackId, artistIds: [] },
                { _id: referencedTrackId, artistIds: [] }
            ]),
            getDb()!.collection('artists').insertMany([
                { _id: firstArtistId, albumIds: [referencedAlbumId] },
                { _id: secondArtistId, albumIds: [] },
                { _id: referencedArtistId, albumIds: [] }
            ]),
            getDb()!.collection('users').insertMany([
                { _id: firstOwnerId, email: 'first-owner@example.test' },
                { _id: secondOwnerId, email: 'second-owner@example.test' },
                { _id: referencedOwnerId, email: 'referenced-owner@example.test' }
            ]),
            getDb()!.collection('playlists').insertMany([
                { _id: firstPlaylistId, ownerUserId: firstOwnerId, items: [] },
                { _id: secondPlaylistId, ownerUserId: secondOwnerId, items: [] },
                { _id: referencedPlaylistId, ownerUserId: referencedOwnerId, items: [] }
            ]),
            getDb()!.collection('userSaves').insertMany([
                { _id: new ObjectId(), contentType: 'album', contentId: referencedAlbumId },
                { _id: new ObjectId(), contentType: 'audioTrack', contentId: referencedTrackId }
            ]),
            getDb()!.collection('userActivity').insertOne({
                _id: new ObjectId(),
                recentlySaved: [{ contentType: 'album', contentId: referencedAlbumId }],
                recentlyPlayed: [{ contentType: 'audioTrack', contentId: referencedTrackId }]
            }),
            getDb()!.collection('carousels').insertOne({
                _id: new ObjectId(),
                mode: 'manual',
                items: [
                    { contentType: 'album', contentId: referencedAlbumId },
                    { contentType: 'audioTrack', contentId: referencedTrackId }
                ]
            }),
            getDb()!.collection('accountMutations').insertOne({
                _id: 'referenced-playlist-receipt',
                ownerUserId: referencedOwnerId.toHexString().toUpperCase(),
                operation: 'playlist.rename',
                targetId: referencedPlaylistId.toHexString().toUpperCase(),
                status: 'completed',
                response: {
                    statusCode: 200,
                    kind: 'playlist',
                    playlistId: referencedPlaylistId.toHexString()
                }
            })
        ]);

        const report = await reconcileContentReferences();

        assert.equal(report.truncated, true);
        assert.deepEqual(report.danglingSaves, []);
        assert.deepEqual(report.danglingActivity, []);
        assert.deepEqual(report.danglingCarouselItems, []);
        assert.deepEqual(report.danglingArtistAlbums, []);
        assert.deepEqual(report.danglingAlbumTracks, []);
        assert.deepEqual(report.danglingTrackAlbums, []);
        assert.deepEqual(report.danglingTrackArtists, []);
        assert.deepEqual(report.missingPlaylistOwners, []);
        assert.deepEqual(report.invalidAccountMutationTargets, []);
    } finally {
        if (previousLimit === undefined) {
            delete process.env.MAX_RECONCILIATION_OBJECTS;
        } else {
            process.env.MAX_RECONCILIATION_OBJECTS = previousLimit;
        }
    }
});

test('reconciliation caps embedded-reference work and the report-wide finding budget', async () => {
    const previousLimit = process.env.MAX_RECONCILIATION_OBJECTS;
    const previousReferenceLimit = process.env.MAX_RECONCILIATION_REFERENCES;
    process.env.MAX_RECONCILIATION_OBJECTS = '2';
    process.env.MAX_RECONCILIATION_REFERENCES = '2';
    const missingIds = [new ObjectId(), new ObjectId(), new ObjectId()];
    try {
        await getDb()!.collection('carousels').insertOne({
            _id: new ObjectId(),
            mode: 'manual',
            items: missingIds.map(contentId => ({ contentType: 'album', contentId }))
        });

        const report = await reconcileContentReferences();

        assert.equal(report.truncated, true);
        assert.equal(report.danglingCarouselItems.length, 2);
        assert.equal(
            Object.values(report)
                .filter(Array.isArray)
                .reduce((total, items) => total + items.length, 0),
            2
        );
    } finally {
        if (previousLimit === undefined) {
            delete process.env.MAX_RECONCILIATION_OBJECTS;
        } else {
            process.env.MAX_RECONCILIATION_OBJECTS = previousLimit;
        }
        if (previousReferenceLimit === undefined) {
            delete process.env.MAX_RECONCILIATION_REFERENCES;
        } else {
            process.env.MAX_RECONCILIATION_REFERENCES = previousReferenceLimit;
        }
    }
});

test('reconciliation distinguishes pending and malformed completed Playlist create receipts', async () => {
    const ownerId = new ObjectId();
    const playlistId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: ownerId,
            email: 'receipt-owner@example.test'
        }),
        getDb()!.collection('playlists').insertOne({
            _id: playlistId,
            ownerUserId: ownerId,
            items: []
        }),
        getDb()!.collection('accountMutations').insertMany([
            {
                _id: 'pending-create',
                ownerUserId: ownerId,
                idempotencyKeyHash: 'pending-create-hash',
                operation: 'playlist.create',
                status: 'pending'
            },
            {
                _id: 'pending-create-with-response',
                ownerUserId: ownerId,
                idempotencyKeyHash: 'pending-create-with-response-hash',
                operation: 'playlist.create',
                status: 'pending',
                response: {
                    statusCode: 201,
                    kind: 'playlist',
                    playlistId
                }
            },
            {
                _id: 'completed-create-missing-response',
                ownerUserId: ownerId,
                idempotencyKeyHash: 'completed-create-missing-response-hash',
                operation: 'playlist.create',
                status: 'completed'
            },
            {
                _id: 'completed-rename-missing-response',
                ownerUserId: ownerId,
                idempotencyKeyHash: 'completed-rename-missing-response-hash',
                operation: 'playlist.rename',
                targetId: playlistId,
                status: 'completed'
            },
            {
                _id: 'completed-create-wrong-kind',
                ownerUserId: ownerId,
                idempotencyKeyHash: 'completed-create-wrong-kind-hash',
                operation: 'playlist.create',
                status: 'completed',
                response: {
                    statusCode: 201,
                    kind: 'deleted',
                    playlistId
                }
            },
            {
                _id: 'completed-create-valid',
                ownerUserId: ownerId,
                idempotencyKeyHash: 'completed-create-valid-hash',
                operation: 'playlist.create',
                status: 'completed',
                response: {
                    statusCode: 201,
                    kind: 'playlist',
                    playlistId
                }
            },
            {
                _id: 'unknown-status',
                ownerUserId: ownerId,
                idempotencyKeyHash: 'unknown-status-hash',
                operation: 'playlist.create',
                status: 'unknown'
            },
            {
                _id: 'unknown-operation',
                ownerUserId: ownerId,
                idempotencyKeyHash: 'unknown-operation-hash',
                operation: 'playlist.unknown',
                status: 'completed',
                response: {
                    statusCode: 200,
                    kind: 'playlist',
                    playlistId
                }
            }
        ])
    ]);

    const report = await reconcileContentReferences();

    assert.deepEqual(
        report.invalidAccountMutationTargets
            .map(item => ({ mutationId: item.mutationId, reason: item.reason }))
            .sort((left, right) => left.mutationId.localeCompare(right.mutationId)),
        [
            { mutationId: 'completed-create-missing-response', reason: 'missing' },
            { mutationId: 'completed-create-wrong-kind', reason: 'responseMismatch' },
            { mutationId: 'completed-rename-missing-response', reason: 'missing' },
            { mutationId: 'pending-create-with-response', reason: 'responseMismatch' },
            { mutationId: 'unknown-operation', reason: 'operationMismatch' },
            { mutationId: 'unknown-status', reason: 'statusMismatch' }
        ]
    );
});
