import assert from 'node:assert/strict';
import { Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let baseUrl = '';
let accessToken = '';

const ids = {
    user: new ObjectId(),
    session: new ObjectId(),
    artist: new ObjectId(),
    album: new ObjectId(),
    readyOne: new ObjectId(),
    readyTwo: new ObjectId(),
    pending: new ObjectId(),
    missing: new ObjectId(),
    manualCarousel: new ObjectId(),
    personalizedCarousel: new ObjectId(),
    grid: new ObjectId()
};

const closeServer = (target?: Server) => new Promise<void>((resolve, reject) => {
    if (!target) return resolve();
    target.close((error) => error ? reject(error) : resolve());
});

const allObjectKeys = (value: unknown, keys = new Set<string>()) => {
    if (!value || typeof value !== 'object') return keys;
    if (Array.isArray(value)) {
        for (const item of value) allObjectKeys(item, keys);
        return keys;
    }
    for (const [key, nested] of Object.entries(value)) {
        keys.add(key);
        allObjectKeys(nested, keys);
    }
    return keys;
};

const expectSafe = (payload: unknown) => {
    const keys = allObjectKeys(payload);
    for (const forbidden of ['createdBy', 's3Key', 'uploadStatus', 'uploadError']) {
        assert.equal(keys.has(forbidden), false, `response exposed ${forbidden}`);
    }
};

before(async () => {
    harness = await startMongoReplicaSet('archtree-listener-content-test');
    const db = getDb()!;
    const userId = ids.user.toString();
    const artistId = ids.artist.toString();
    const albumId = ids.album.toString();
    await Promise.all([
        db.collection('users').insertOne({
            _id: ids.user,
            email: 'listener@example.com',
            username: 'listener',
            password: 'unused',
            posts: [],
            role: 'user'
        }),
        db.collection('authSessions').insertOne({
            _id: ids.session,
            userId,
            refreshTokenHash: 'integration-hash',
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000)
        }),
        db.collection('artists').insertOne({
            _id: ids.artist,
            name: 'Needle Artist',
            bio: 'Public biography',
            coverArtUrl: '/artist.jpg',
            albumIds: [albumId],
            createdBy: 'private-owner'
        }),
        db.collection('albums').insertOne({
            _id: ids.album,
            title: 'Needle Album',
            coverArtUrl: '/album.jpg',
            audioTrackIds: [
                ids.pending.toString(),
                ids.readyTwo.toString(),
                ids.missing.toString(),
                ids.readyOne.toString()
            ],
            releaseDate: { year: 2026, month: 8 },
            createdBy: 'private-owner'
        }),
        db.collection('audioTracks').insertMany([
            {
                _id: ids.readyOne,
                title: 'Needle Ready One',
                artistIds: [artistId],
                albumId,
                duration: '03:10',
                coverArtUrl: '',
                uploadStatus: 'ready',
                s3Key: 'private/ready-one',
                uploadError: null,
                createdBy: 'private-owner'
            },
            {
                _id: ids.readyTwo,
                title: 'Needle Ready Two',
                artistIds: [artistId],
                albumId,
                duration: '04:20',
                coverArtUrl: '/track-two.jpg',
                uploadStatus: 'ready',
                s3Key: 'private/ready-two',
                uploadError: null,
                createdBy: 'private-owner'
            },
            {
                _id: ids.pending,
                title: 'Needle Pending',
                artistIds: [artistId],
                albumId,
                coverArtUrl: '',
                uploadStatus: 'pending',
                s3Key: ids.pending.toString(),
                uploadError: 'private failure detail',
                createdBy: 'private-owner'
            }
        ]),
        db.collection('carousels').insertMany([
            {
                _id: ids.manualCarousel,
                name: 'Featured',
                mode: 'manual',
                items: [
                    { contentType: 'album', contentId: albumId, order: 0 },
                    { contentType: 'audioTrack', contentId: ids.pending.toString(), order: 1 },
                    { contentType: 'audioTrack', contentId: ids.readyOne.toString(), order: 2 }
                ]
            },
            {
                _id: ids.personalizedCarousel,
                name: 'Recently Saved',
                mode: 'personalized',
                items: [],
                personalizedConfig: { source: 'recentlySaved', limit: 20 }
            }
        ]),
        db.collection('contentCollections').insertOne({
            _id: ids.grid,
            name: 'Grid Picks',
            mode: 'manual',
            contentType: 'audioTrack',
            items: [{ contentType: 'audioTrack', contentId: ids.readyTwo.toString(), order: 0 }]
        }),
        db.collection('pages').insertOne({
            slug: 'home',
            title: 'Listen Now',
            items: [
                { itemType: 'carousel', carouselId: ids.manualCarousel.toString(), order: 0 },
                { itemType: 'carousel', carouselId: ids.personalizedCarousel.toString(), order: 1 },
                { itemType: 'grid', collectionId: ids.grid.toString(), order: 2 }
            ]
        }),
        db.collection('userActivity').insertOne({
            userId,
            recentlySaved: [
                { contentType: 'audioTrack', contentId: ids.pending.toString(), occurredAt: new Date() },
                { contentType: 'audioTrack', contentId: ids.readyTwo.toString(), occurredAt: new Date() }
            ]
        }),
        db.collection('userSaves').insertMany([
            {
                userId,
                contentType: 'album',
                contentId: albumId,
                savedAt: new Date('2026-08-01T00:00:00Z'),
                lastActivityAt: new Date('2026-08-01T00:00:00Z')
            },
            {
                userId,
                contentType: 'audioTrack',
                contentId: ids.readyOne.toString(),
                savedAt: new Date('2026-08-02T00:00:00Z'),
                lastActivityAt: new Date('2026-08-02T00:00:00Z')
            },
            {
                userId,
                contentType: 'audioTrack',
                contentId: ids.pending.toString(),
                savedAt: new Date('2026-08-03T00:00:00Z'),
                lastActivityAt: new Date('2026-08-03T00:00:00Z')
            }
        ])
    ]);

    accessToken = jwt.sign({
        userId,
        email: 'listener@example.com',
        role: 'user',
        sessionId: ids.session.toString(),
        tokenType: 'access'
    }, process.env.JWT_SECRET!, { expiresIn: 60 });

    const app = createApp({
        listenerDistPath: path.join(os.tmpdir(), 'archtree-listener-content-missing')
    });
    server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    await closeServer(server);
    await harness?.stop();
});

test('listener read layer preserves composition and exposes only ready safe DTOs', async () => {
    const anonymousHomeResponse = await fetch(`${baseUrl}/api/listener/v1/home`);
    assert.equal(anonymousHomeResponse.status, 200);
    const anonymousHome: any = await anonymousHomeResponse.json();
    assert.deepEqual(anonymousHome.sections.map((section: any) => section.presentation), [
        'carousel',
        'carousel',
        'grid'
    ]);
    assert.deepEqual(
        anonymousHome.sections[0].items.map((item: any) => item.id),
        [ids.album.toString(), ids.readyOne.toString()]
    );
    assert.deepEqual(anonymousHome.sections[1].items, []);
    assert.equal(anonymousHome.sections[0].items[0].artistNames[0], 'Needle Artist');
    expectSafe(anonymousHome);

    const expiredToken = jwt.sign({
        userId: ids.user.toString(),
        email: 'listener@example.com',
        role: 'user',
        sessionId: ids.session.toString(),
        tokenType: 'access'
    }, process.env.JWT_SECRET!, { expiresIn: -1 });
    const expiredHomeResponse = await fetch(`${baseUrl}/api/listener/v1/home`, {
        headers: { Authorization: `Bearer ${expiredToken}` }
    });
    assert.equal(expiredHomeResponse.status, 200);
    const expiredHome: any = await expiredHomeResponse.json();
    assert.deepEqual(expiredHome.sections[1].items, []);

    const authenticatedHomeResponse = await fetch(`${baseUrl}/api/listener/v1/home`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const authenticatedHome: any = await authenticatedHomeResponse.json();
    assert.deepEqual(
        authenticatedHome.sections[1].items.map((item: any) => item.id),
        [ids.readyTwo.toString()]
    );
    assert.equal(authenticatedHomeResponse.headers.get('cache-control'), 'private, no-store');

    const searchResponse = await fetch(`${baseUrl}/api/listener/v1/search?q=Needle`);
    const search: any = await searchResponse.json();
    assert.deepEqual(search.audioTracks.map((track: any) => track.id), [
        ids.readyOne.toString(),
        ids.readyTwo.toString()
    ]);
    assert.equal(search.albums[0].artistNames[0], 'Needle Artist');
    expectSafe(search);

    const albumResponse = await fetch(`${baseUrl}/api/listener/v1/albums/${ids.album}`);
    const album: any = await albumResponse.json();
    assert.deepEqual(album.tracks.map((track: any) => track.id), [
        ids.readyTwo.toString(),
        ids.readyOne.toString()
    ]);
    expectSafe(album);

    const artistResponse = await fetch(`${baseUrl}/api/listener/v1/artists/${ids.artist}`);
    const artist: any = await artistResponse.json();
    assert.equal(artist.audioTracks.length, 2);
    expectSafe(artist);

    const trackResponse = await fetch(`${baseUrl}/api/listener/v1/tracks/${ids.readyOne}`);
    const track: any = await trackResponse.json();
    assert.equal(track.audioTrack.artworkUrl, '/album.jpg');
    assert.equal(track.audioTrack.streamUrl, `/content/audioTrack/stream/${ids.readyOne}`);
    expectSafe(track);

    const pendingMetadata = await fetch(`${baseUrl}/api/listener/v1/tracks/${ids.pending}`);
    assert.equal(pendingMetadata.status, 404);
    const pendingHead = await fetch(`${baseUrl}/content/audioTrack/stream/${ids.pending}`, { method: 'HEAD' });
    assert.equal(pendingHead.status, 404);
    const pendingStream = await fetch(`${baseUrl}/content/audioTrack/stream/${ids.pending}`);
    assert.equal(pendingStream.status, 404);
});

test('listener Library requires authentication and retains non-ready items safely', async () => {
    const anonymous = await fetch(`${baseUrl}/api/listener/v1/library`);
    assert.equal(anonymous.status, 401);

    const response = await fetch(`${baseUrl}/api/listener/v1/library?limit=100`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    assert.equal(response.status, 200);
    const library: any = await response.json();
    assert.deepEqual(
        library.items.map((item: any) => item.contentId).sort(),
        [ids.album.toString(), ids.readyOne.toString(), ids.pending.toString()].sort()
    );
    const ready = library.items.find((item: any) => item.contentId === ids.readyOne.toString());
    const pending = library.items.find((item: any) => item.contentId === ids.pending.toString());
    assert.equal(ready.audioTrack.available, true);
    assert.equal(ready.audioTrack.streamUrl, `/content/audioTrack/stream/${ids.readyOne}`);
    assert.equal(pending.audioTrack.available, false);
    assert.equal(pending.audioTrack.streamUrl, null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    expectSafe(library);
});
