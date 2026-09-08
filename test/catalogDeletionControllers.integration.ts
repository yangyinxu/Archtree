import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Server } from 'node:http';
import express, { NextFunction, Request, Response } from 'express';
import { ObjectId } from 'mongodb';

import { deleteArtist } from '../src/controllers/artistController';
import { deleteAlbum } from '../src/controllers/albumController';
import { deleteArtistWeb } from '../src/controllers/contentManager/artistController';
import { deleteAlbumWeb } from '../src/controllers/contentManager/albumController';
import { getDb } from '../src/infrastructure/database';
import { AuthenticatedRequest } from '../src/middleware/authMiddleware';
import { asyncHandler } from '../src/middleware/requestProtectionMiddleware';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let origin: string;

before(async () => {
    harness = await startMongoReplicaSet('archtree-catalog-deletion-controller-test');
    const app = express();
    app.use(express.json());
    // Authentication is synthetic; the actual controller role guards and Mongo lifecycle run below.
    app.use((req, _res, next) => {
        const role = req.get('X-Test-Role');
        if (role) (req as AuthenticatedRequest).auth = { userId: 'fixture-admin', role };
        next();
    });
    app.delete('/content/artist/:artistId', asyncHandler(deleteArtist));
    app.delete('/content/album/:albumId', asyncHandler(deleteAlbum));
    app.post('/content/manage/artist/delete', asyncHandler(deleteArtistWeb));
    app.post('/content/manage/album/delete', asyncHandler(deleteAlbumWeb));
    app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
        res.status(error.statusCode ?? 500).json({ code: error.code ?? 'unexpected_test_error' });
    });
    server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
    await Promise.all(['artists', 'albums', 'imageAssets', 'catalogDeletionOperations']
        .map((name) => getDb()!.collection(name).deleteMany({})));
});

after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await harness?.stop();
});

/** Represents a committed owner deletion whose S3 preparation succeeded before final metadata cleanup. */
const seedOwnerlessReceipt = async (ownerType: 'artist' | 'album') => {
    const ownerId = new ObjectId();
    const imageId = new ObjectId();
    const receiptId = `${ownerType}:${ownerId.toHexString()}`;
    await getDb()!.collection<any>('catalogDeletionOperations').insertOne({
        _id: receiptId, ownerType, ownerId: ownerId.toHexString(), referenceRevision: 1,
        coverArtId: imageId.toHexString(), preparedImageIds: [imageId.toHexString()],
        token: 'stopped-test-worker', status: 'failed', leaseUntil: new Date(0), updatedAt: new Date(0)
    });
    await getDb()!.collection('imageAssets').insertOne({
        _id: imageId, ownerType, ownerId: ownerId.toHexString(),
        s3Key: `images/${imageId.toHexString()}`, uploadStatus: 'deleting'
    });
    return { ownerId: ownerId.toHexString(), imageId, receiptId };
};

for (const type of ['artist', 'album'] as const) {
    const label = type === 'artist' ? 'Artist' : 'Album';
    for (const surface of ['json', 'web'] as const) {
        const request = (id: string, role: string | undefined = 'admin') => fetch(
            `${origin}/content/${surface === 'json' ? `${type}/${id}` : `manage/${type}/delete`}`,
            {
                method: surface === 'json' ? 'DELETE' : 'POST', redirect: 'manual',
                headers: { 'Content-Type': 'application/json', ...(role ? { 'X-Test-Role': role } : {}) },
                ...(surface === 'web' ? { body: JSON.stringify({ [`${type}Id`]: id }) } : {})
            }
        );
        const webMessage = (response: globalThis.Response) => new URL(response.headers.get('Location')!, origin).searchParams.get('message');

        test(`${type} ${surface}: retries final artwork cleanup after the owner was deleted`, async () => {
            const seeded = await seedOwnerlessReceipt(type);
            const response = await request(seeded.ownerId);
            if (surface === 'json') {
                assert.equal(response.status, 200);
                assert.deepEqual(await response.json(), { message: `${label} deleted successfully.`, cleanupPending: false });
            } else {
                assert.equal(response.status, 302);
                assert.equal(webMessage(response), `${label} deleted successfully.`);
            }
            assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 0);
            assert.equal(await getDb()!.collection('catalogDeletionOperations').countDocuments(), 0);
            assert.equal(await getDb()!.collection(type === 'artist' ? 'artists' : 'albums').countDocuments(), 0);
        });

        test(`${type} ${surface}: no owner and no receipt retain the existing not-found outcome`, async () => {
            const response = await request(new ObjectId().toHexString());
            assert.equal(response.status, surface === 'json' ? 404 : 302);
            assert.equal(surface === 'json' ? (await response.json()).message : webMessage(response), `${label} not found.`);
            assert.equal(await getDb()!.collection('catalogDeletionOperations').countDocuments(), 0);
        });

        test(`${type} ${surface}: an unsafe image retains its receipt and reports pending cleanup`, async () => {
            const seeded = await seedOwnerlessReceipt(type);
            // Finalization must not erase another owner's asset even if the receipt lists its ID.
            await getDb()!.collection('imageAssets').updateOne({ _id: seeded.imageId }, {
                $set: { ownerId: new ObjectId().toHexString() }
            });
            const response = await request(seeded.ownerId);
            if (surface === 'json') {
                assert.equal(response.status, 200);
                assert.equal((await response.json()).cleanupPending, true);
            } else {
                assert.equal(response.status, 302);
                assert.equal(webMessage(response), `${label} deleted successfully. Cover-art cleanup will need to be retried.`);
            }
            assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 1);
            assert.equal(await getDb()!.collection('catalogDeletionOperations').countDocuments(), 1);
        });

        test(`${type} ${surface}: an active receipt remains a conflict instead of becoming not-found`, async () => {
            const seeded = await seedOwnerlessReceipt(type);
            await getDb()!.collection<any>('catalogDeletionOperations').updateOne({ _id: seeded.receiptId }, {
                $set: { status: 'inProgress', leaseUntil: new Date(Date.now() + 60_000) }
            });
            const response = await request(seeded.ownerId);
            assert.equal(response.status, 409);
            assert.equal((await response.json()).code, `${type}_deletion_in_progress`);
            assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 1);
        });

        test(`${type} ${surface}: invalid IDs never create recovery receipts`, async () => {
            const response = await request('invalid-id');
            assert.equal(response.status, surface === 'json' ? 404 : 302);
            if (surface === 'web') assert.equal(webMessage(response), `${label} ID is not valid.`);
            assert.equal(await getDb()!.collection('catalogDeletionOperations').countDocuments(), 0);
        });

        test(`${type} ${surface}: recovery still requires administrator authorization`, async () => {
            const seeded = await seedOwnerlessReceipt(type);
            const ordinary = await request(seeded.ownerId, 'user');
            assert.equal(ordinary.status, 403);
            const anonymous = await request(seeded.ownerId, '');
            assert.equal(anonymous.status, surface === 'json' ? 401 : 302);
            if (surface === 'web') assert.equal(anonymous.headers.get('Location'), '/auth/login-web?returnTo=%2Fcontent%2Fmanage');
            assert.equal(await getDb()!.collection('imageAssets').countDocuments(), 1);
            assert.equal(await getDb()!.collection('catalogDeletionOperations').countDocuments(), 1);
        });
    }
}
