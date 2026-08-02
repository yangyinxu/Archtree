import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';

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
    static insert(asset: ImageAssetRecord) {
        return getDb()!.collection(collectionId).insertOne(asset);
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

    static deleteById(imageId: string) {
        const imageObjectId = ObjectId.createFromHexString(imageId);
        return getDb()!.collection(collectionId).deleteOne({ _id: imageObjectId });
    }
}
