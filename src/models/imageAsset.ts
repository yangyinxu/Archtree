import { ClientSession, ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import {
    touchActiveAccount,
    withActiveAccount
} from '../services/accountReferenceFenceService';

const collectionId = 'imageAssets';

export type ImageOwnerType = 'artist' | 'album' | 'audioTrack' | 'user';
export type ImageUploadStatus = 'pending' | 'ready' | 'failed' | 'deleting' | 'deleteFailed';

export interface ImageAssetRecord {
    _id: ObjectId;
    ownerType: ImageOwnerType;
    ownerId: string;
    createdBy: string;
    originalFileName: string;
    contentType: string;
    s3Key: string;
    uploadStatus: ImageUploadStatus;
    uploadUpdatedAt: Date;
    uploadError: string | null;
}

export class ImageAsset {
    static async insert(asset: ImageAssetRecord, session?: ClientSession) {
        if (asset.ownerType === 'user') {
            return getDb()!.collection(collectionId).insertOne(
                asset,
                session ? { session } : {}
            );
        }
        if (session) {
            await touchActiveAccount(asset.createdBy, session);
            return getDb()!.collection(collectionId).insertOne(asset, { session });
        }
        return withActiveAccount(
            asset.createdBy,
            (activeSession) => getDb()!.collection(collectionId).insertOne(
                asset,
                { session: activeSession }
            )
        );
    }

    static findById(imageId: string) {
        const imageObjectId = ObjectId.createFromHexString(imageId);
        return getDb()!.collection(collectionId).findOne({ _id: imageObjectId });
    }

    static updateById(imageId: string, update: Record<string, unknown>) {
        const imageObjectId = ObjectId.createFromHexString(imageId);
        return getDb()!.collection(collectionId).updateOne(
            { _id: imageObjectId },
            { $set: update }
        );
    }

    /** Applies a lifecycle transition only while the exact observed state still owns the row. */
    static updateByIdWhere(
        imageId: string,
        expected: Record<string, unknown>,
        update: Record<string, unknown>,
        session?: ClientSession
    ) {
        const imageObjectId = ObjectId.createFromHexString(imageId);
        return getDb()!.collection(collectionId).updateOne(
            { _id: imageObjectId, ...expected },
            { $set: update },
            session ? { session } : {}
        );
    }

    static deleteById(imageId: string) {
        const imageObjectId = ObjectId.createFromHexString(imageId);
        return getDb()!.collection(collectionId).deleteOne({ _id: imageObjectId });
    }


    /** Removes only a lifecycle row that remains in the caller's finalized state. */
    static deleteByIdWhere(imageId: string, expected: Record<string, unknown>) {
        const imageObjectId = ObjectId.createFromHexString(imageId);
        return getDb()!.collection(collectionId).deleteOne({
            _id: imageObjectId,
            ...expected
        });
    }
}
