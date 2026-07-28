import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { getS3 } from '../infrastructure/s3';
import { AudioTrack } from '../models/audioTrack';
import { cleanupDeletedContentReferences } from './contentReferenceService';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { deleteCoverArt } from './imageStorageService';

const errorMessage = (error: unknown) => {
    if (error instanceof Error) {
        return error.message.substring(0, 500);
    }
    return String(error).substring(0, 500);
};

const encodeMetadataValue = (value: string) => {
    return encodeURIComponent(value).substring(0, 1800);
};

export const uploadAudioObject = async (
    audioTrackId: string,
    uploadFile: Express.Multer.File,
    ownerId: string,
    abortSignal?: AbortSignal
) => {
    const originalFileName = normalizeUtf8Text(uploadFile.originalname);
    const contentType = uploadFile.mimetype || 'audio/mpeg';
    const pendingAt = new Date();

    const pendingUpdate = await AudioTrack.updateById(audioTrackId, {
        originalFileName,
        contentType,
        s3Key: audioTrackId,
        uploadStatus: 'pending',
        uploadUpdatedAt: pendingAt,
        uploadError: null
    });
    if (pendingUpdate.matchedCount !== 1) {
        throw new Error(`Audio track ${audioTrackId} no longer exists.`);
    }

    try {
        const body = uploadFile.path ? createReadStream(uploadFile.path) : uploadFile.buffer;
        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId,
            Body: body,
            ContentLength: uploadFile.size,
            ContentType: contentType,
            Metadata: {
                trackid: audioTrackId,
                ownerid: ownerId,
                originalfilename: encodeMetadataValue(originalFileName)
            }
        }), { abortSignal });

        await AudioTrack.updateById(audioTrackId, {
            uploadStatus: 'ready',
            uploadUpdatedAt: new Date(),
            uploadError: null
        });
    } catch (error) {
        await AudioTrack.updateById(audioTrackId, {
            uploadStatus: 'failed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error)
        }).catch((statusError) => {
            console.log(`Unable to mark audio track ${audioTrackId} as failed:`, statusError);
        });
        throw error;
    }
};

export const deleteAudioObjectAndTrack = async (audioTrackId: string) => {
    const track = await AudioTrack.findById(audioTrackId);
    if (!track) {
        throw new Error(`Audio track ${audioTrackId} no longer exists.`);
    }

    const deletingUpdate = await AudioTrack.updateById(audioTrackId, {
        uploadStatus: 'deleting',
        uploadUpdatedAt: new Date(),
        uploadError: null
    });
    if (deletingUpdate.matchedCount !== 1) {
        throw new Error(`Audio track ${audioTrackId} no longer exists.`);
    }

    try {
        await getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId
        }));
        await deleteCoverArt(track.coverArtId);
    } catch (error) {
        await AudioTrack.updateById(audioTrackId, {
            uploadStatus: 'deleteFailed',
            uploadUpdatedAt: new Date(),
            uploadError: errorMessage(error)
        }).catch((statusError) => {
            console.log(`Unable to mark audio track ${audioTrackId} deletion as failed:`, statusError);
        });
        throw error;
    }

    await cleanupDeletedContentReferences('audioTrack', audioTrackId);
    await AudioTrack.deleteById(audioTrackId);
};
