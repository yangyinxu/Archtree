import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import { getS3 } from '../src/infrastructure/s3';
import { startLocalS3 } from './support/localS3';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let mongo: MongoReplicaSetHarness | undefined;
let storage: Awaited<ReturnType<typeof startLocalS3>> | undefined;
let server: Server | undefined;
let baseUrl = '';
let artwork = Buffer.alloc(0);
const ownedEnvironment = [
    'AWS_ENDPOINT_URL_S3',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'S3_BUCKET_NAME',
    'S3_MAX_ATTEMPTS'
] as const;
const oldEnvironment = Object.fromEntries(ownedEnvironment.map(key => [key, process.env[key]]));

before(async () => {
    mongo = await startMongoReplicaSet('archtree-public-cover-art-owner-test');
    storage = await startLocalS3('public-cover-art-test');
    process.env.AWS_ENDPOINT_URL_S3 = storage.endpoint;
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'owned-local-fixture';
    process.env.AWS_SECRET_ACCESS_KEY = 'owned-local-fixture-secret';
    delete process.env.AWS_SESSION_TOKEN;
    process.env.S3_BUCKET_NAME = storage.bucket;
    process.env.S3_MAX_ATTEMPTS = '2';
    artwork = await sharp({
        create: { width: 24, height: 24, channels: 3, background: '#4a6b8c' }
    }).png().toBuffer();
    server = await new Promise<Server>(resolve => {
        const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
    for (const collection of ['audioTracks', 'imageAssets']) {
        await getDb()!.collection(collection).deleteMany({});
    }
    storage!.objects.clear();
    storage!.requests.length = 0;
});

after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    getS3().destroy();
    await storage?.stop();
    await mongo?.stop();
    for (const key of ownedEnvironment) {
        if (oldEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = oldEnvironment[key];
    }
});

/** Seeds one ready MediaTrack-owned image and its stored bytes beside the given owner row. */
const seedMediaTrackArtwork = async (owner: (mediaTrackId: string) => Record<string, unknown>) => {
    const mediaTrackObjectId = new ObjectId();
    const mediaTrackId = mediaTrackObjectId.toHexString();
    const imageObjectId = new ObjectId();
    const imageId = imageObjectId.toHexString();
    const s3Key = `images/${imageId}`;
    storage!.objects.set(s3Key, {
        bytes: artwork,
        etag: `"${createHash('md5').update(artwork).digest('hex')}"`,
        versionId: `fixture-${imageId}`,
        contentType: 'image/png'
    });
    await getDb()!.collection('imageAssets').insertOne({
        _id: imageObjectId,
        ownerType: 'audioTrack',
        ownerId: mediaTrackId,
        createdBy: 'fixture-owner',
        originalFileName: 'lorem-ipsum.png',
        contentType: 'image/png',
        s3Key,
        uploadStatus: 'ready',
        uploadUpdatedAt: new Date(),
        uploadError: null
    });
    await getDb()!.collection('audioTracks').insertOne({
        _id: mediaTrackObjectId,
        title: 'Lorem Ipsum Dolor',
        coverArtId: imageId,
        coverArtUrl: '',
        uploadError: null,
        createdBy: 'fixture-owner',
        ...owner(mediaTrackId)
    });
    return imageId;
};

const readyVideoTrack = (mediaTrackId: string) => ({
    mediaType: 'video',
    s3Key: `video/${mediaTrackId}/${new ObjectId().toHexString()}`,
    contentType: 'video/mp4',
    uploadStatus: 'ready',
    publicationStatus: 'ready'
});

const fetchArtwork = async (imageId: string) => ({
    original: await fetch(`${baseUrl}/content/images/${imageId}`),
    variant: await fetch(`${baseUrl}/content/images/${imageId}/v1/96.webp`)
});

test('a ready published Video MediaTrack serves its own artwork on the original and variant routes', async () => {
    const imageId = await seedMediaTrackArtwork(readyVideoTrack);
    const { original, variant } = await fetchArtwork(imageId);

    assert.equal(original.status, 200);
    assert.equal(original.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), artwork);

    assert.equal(variant.status, 200);
    assert.equal(variant.headers.get('content-type'), 'image/webp');
    const metadata = await sharp(Buffer.from(await variant.arrayBuffer())).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 96);
});

test('legacy Audio MediaTrack artwork remains public through the default owner lookup', async () => {
    const imageId = await seedMediaTrackArtwork((mediaTrackId) => ({
        s3Key: mediaTrackId,
        uploadStatus: 'ready'
    }));
    const { original, variant } = await fetchArtwork(imageId);

    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), artwork);
    assert.equal(variant.status, 200);
});

test('wrong-kind and unpublished Video MediaTrack owners keep their artwork private', async () => {
    for (const owner of [
        (mediaTrackId: string) => ({ ...readyVideoTrack(mediaTrackId), mediaType: 'audio' }),
        (mediaTrackId: string) => {
            const { mediaType: _legacyRowHasNoKind, ...legacy } = readyVideoTrack(mediaTrackId);
            return legacy;
        },
        (mediaTrackId: string) => ({ ...readyVideoTrack(mediaTrackId), s3Key: mediaTrackId }),
        (mediaTrackId: string) => ({ ...readyVideoTrack(mediaTrackId), publicationStatus: 'pending' }),
        (mediaTrackId: string) => ({ ...readyVideoTrack(mediaTrackId), uploadStatus: 'deleting' })
    ]) {
        const imageId = await seedMediaTrackArtwork(owner);
        const { original, variant } = await fetchArtwork(imageId);
        assert.equal(original.status, 404);
        assert.equal(original.headers.get('cache-control'), 'private, no-store');
        await original.arrayBuffer();
        assert.equal(variant.status, 404);
        await variant.arrayBuffer();
    }
    assert.deepEqual(storage!.requests, []);
});
