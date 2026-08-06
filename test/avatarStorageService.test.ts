import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
    AvatarMutationOutcomeUnknownError,
    AvatarAssetDeletionDependencies,
    deleteAvatarOwnerAndAsset,
    isAvatarObjectKeyForImage,
    normalizeAvatar,
    replaceAvatarOwnerAndCleanup
} from '../src/services/avatarStorageService';
import { maxAvatarUploadMb } from '../src/middleware/imageUpload';

const upload = (buffer: Buffer, mimetype = 'image/png') => ({
    fieldname: 'avatar',
    originalname: 'profile.png',
    encoding: '7bit',
    mimetype,
    size: buffer.length,
    buffer
}) as Express.Multer.File;

test('avatar storage keys are bound to the requested image identity', () => {
    const imageId = '507f1f77bcf86cd799439011';
    assert.equal(isAvatarObjectKeyForImage(`avatars/${imageId}`, imageId), true);
    assert.equal(isAvatarObjectKeyForImage('avatars/507f1f77bcf86cd799439012', imageId), false);
    assert.equal(isAvatarObjectKeyForImage(`images/${imageId}`, imageId), false);
    assert.equal(isAvatarObjectKeyForImage('avatars/not-an-id', 'not-an-id'), false);
});

test('avatar deletion retains lifecycle evidence when the owner clear loses its CAS', async () => {
    const imageId = '507f1f77bcf86cd799439011';
    const userId = '507f1f77bcf86cd799439099';
    let asset: any = {
        _id: imageId,
        ownerType: 'user',
        ownerId: userId,
        s3Key: `avatars/${imageId}`,
        uploadStatus: 'ready'
    };
    const deletedObjects: string[] = [];
    const dependencies: AvatarAssetDeletionDependencies = {
        findAsset: async () => asset ? { ...asset } : null,
        updateAsset: async (_id, update) => {
            if (!asset) return { matchedCount: 0 };
            asset = { ...asset, ...update };
            return { matchedCount: 1 };
        },
        deleteObject: async key => { deletedObjects.push(key); },
        deleteAsset: async () => {
            if (!asset) return { deletedCount: 0 };
            asset = null;
            return { deletedCount: 1 };
        }
    };

    const conflicted = await deleteAvatarOwnerAndAsset(
        imageId,
        userId,
        async () => ({ value: null }),
        dependencies
    );

    assert.deepEqual(conflicted, { ownerCleared: false, cleanupPending: true });
    assert.equal(asset.uploadStatus, 'deleting');
    assert.deepEqual(deletedObjects, [`avatars/${imageId}`]);

    const retried = await deleteAvatarOwnerAndAsset(
        imageId,
        userId,
        async () => ({ value: { avatarAssetId: imageId } }),
        dependencies
    );
    assert.deepEqual(retried, { ownerCleared: true, cleanupPending: false });
    assert.equal(asset, null);
    assert.deepEqual(deletedObjects, [`avatars/${imageId}`, `avatars/${imageId}`]);
});

test('avatar deletion retains lifecycle evidence when the owner clear throws', async () => {
    const imageId = '507f1f77bcf86cd799439011';
    const userId = '507f1f77bcf86cd799439099';
    let asset: any = {
        ownerType: 'user',
        ownerId: userId,
        s3Key: `avatars/${imageId}`,
        uploadStatus: 'ready'
    };
    const dependencies: AvatarAssetDeletionDependencies = {
        findAsset: async () => ({ ...asset }),
        updateAsset: async (_id, update) => {
            asset = { ...asset, ...update };
            return { matchedCount: 1 };
        },
        deleteObject: async () => undefined,
        deleteAsset: async () => {
            asset = null;
            return { deletedCount: 1 };
        }
    };

    await assert.rejects(
        deleteAvatarOwnerAndAsset(
            imageId,
            userId,
            async () => { throw new Error('database unavailable'); },
            dependencies
        ),
        /database unavailable/
    );
    assert.equal(asset.uploadStatus, 'deleting');
});

test('avatar replacement confirms a committed owner write after its response is lost', async () => {
    const previousImageId = '507f1f77bcf86cd799439010';
    const replacementImageId = '507f1f77bcf86cd799439011';
    const userId = '507f1f77bcf86cd799439099';
    const assets = new Map<string, any>([
        [previousImageId, {
            ownerType: 'user', ownerId: userId,
            s3Key: `avatars/${previousImageId}`, uploadStatus: 'ready'
        }],
        [replacementImageId, {
            ownerType: 'user', ownerId: userId,
            s3Key: `avatars/${replacementImageId}`, uploadStatus: 'ready'
        }]
    ]);
    const dependencies: AvatarAssetDeletionDependencies = {
        findAsset: async id => assets.get(id) ?? null,
        updateAsset: async (id, update) => {
            const asset = assets.get(id);
            if (!asset) return { matchedCount: 0 };
            assets.set(id, { ...asset, ...update });
            return { matchedCount: 1 };
        },
        deleteObject: async () => undefined,
        deleteAsset: async id => ({ deletedCount: assets.delete(id) ? 1 : 0 })
    };

    const result = await replaceAvatarOwnerAndCleanup(
        replacementImageId,
        userId,
        previousImageId,
        4,
        async () => { throw new Error('database response lost'); },
        async () => ({ avatarAssetId: replacementImageId, avatarRevision: 5 }),
        dependencies
    );

    assert.equal(result.ownerReplaced, true);
    assert.equal(result.cleanupPending, false);
    assert.equal(assets.has(previousImageId), false);
    assert.equal(assets.has(replacementImageId), true);
});

test('avatar deletion finalizes lifecycle evidence after a committed clear response is lost', async () => {
    const imageId = '507f1f77bcf86cd799439011';
    const userId = '507f1f77bcf86cd799439099';
    let asset: any = {
        ownerType: 'user', ownerId: userId,
        s3Key: `avatars/${imageId}`, uploadStatus: 'ready'
    };
    const result = await deleteAvatarOwnerAndAsset(
        imageId,
        userId,
        async () => { throw new Error('database response lost'); },
        {
            findAsset: async () => asset,
            updateAsset: async (_id, update) => {
                asset = { ...asset, ...update };
                return { matchedCount: 1 };
            },
            deleteObject: async () => undefined,
            deleteAsset: async () => {
                asset = null;
                return { deletedCount: 1 };
            },
            confirmOwnerCleared: async () => true
        }
    );

    assert.deepEqual(result, { ownerCleared: true, cleanupPending: false });
    assert.equal(asset, null);
});

test('avatar deletion preserves lifecycle evidence when clear confirmation is unavailable', async () => {
    const imageId = '507f1f77bcf86cd799439011';
    const userId = '507f1f77bcf86cd799439099';
    let asset: any = {
        ownerType: 'user', ownerId: userId,
        s3Key: `avatars/${imageId}`, uploadStatus: 'ready'
    };
    await assert.rejects(
        deleteAvatarOwnerAndAsset(
            imageId,
            userId,
            async () => { throw new Error('database response lost'); },
            {
                findAsset: async () => asset,
                updateAsset: async (_id, update) => {
                    asset = { ...asset, ...update };
                    return { matchedCount: 1 };
                },
                deleteObject: async () => undefined,
                deleteAsset: async () => ({ deletedCount: 1 }),
                confirmOwnerCleared: async () => { throw new Error('confirmation unavailable'); }
            }
        ),
        (error: any) => error instanceof AvatarMutationOutcomeUnknownError
            && error.cleanupPending === true
    );
    assert.equal(asset.uploadStatus, 'deleting');
});

test('normalizes avatars to a square metadata-free JPEG', async () => {
    const source = await sharp({
        create: {
            width: 320,
            height: 180,
            channels: 3,
            background: '#336699'
        }
    })
        .withMetadata({ orientation: 6 })
        .png()
        .toBuffer();

    const normalized = await normalizeAvatar(upload(source));
    const metadata = await sharp(normalized).metadata();

    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 1_024);
    assert.equal(metadata.height, 1_024);
    assert.equal(metadata.exif, undefined);
});

test('rejects a declared unsupported avatar type', async () => {
    const source = await sharp({
        create: {
            width: 10,
            height: 10,
            channels: 3,
            background: '#ffffff'
        }
    }).png().toBuffer();

    await assert.rejects(
        normalizeAvatar(upload(source, 'image/gif')),
        /valid JPG, PNG, or WebP/
    );
});

test('rejects oversized avatar input before decoding', async () => {
    const oversized = Buffer.alloc(maxAvatarUploadMb * 1024 * 1024 + 1);

    await assert.rejects(
        normalizeAvatar(upload(oversized)),
        /maximum size/
    );
});
