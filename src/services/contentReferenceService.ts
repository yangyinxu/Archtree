import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export type ContentReferenceType = 'artist' | 'album' | 'audioTrack';

const referenceConfig: Record<ContentReferenceType, { collection: string; label: string }> = {
    artist: { collection: 'artists', label: 'Artist' },
    album: { collection: 'albums', label: 'Album' },
    audioTrack: { collection: 'audioTracks', label: 'Audio track' }
};

export type ContentReferenceValidation = {
    valid: boolean;
    ids: string[];
    message?: string;
};

export const validateOwnedContentReferences = async (
    req: AuthenticatedRequest,
    type: ContentReferenceType,
    values: string[]
): Promise<ContentReferenceValidation> => {
    const config = referenceConfig[type];
    const ids = [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    if (ids.length === 0) {
        if (values.length > 0) {
            return {
                valid: false,
                ids,
                message: `${config.label} ID is required.`
            };
        }
        return { valid: true, ids };
    }

    const invalidId = ids.find((id) => !ObjectId.isValid(id) || String(new ObjectId(id)) !== id.toLowerCase());
    if (invalidId) {
        return {
            valid: false,
            ids,
            message: `${config.label} ID "${invalidId}" is not a valid ID.`
        };
    }

    const db = getDb();
    if (!db) {
        throw new Error('Database is unavailable.');
    }

    const documents = await db.collection(config.collection).find({
        _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) }
    }, {
        projection: { createdBy: 1 }
    }).toArray();
    const documentsById = new Map(documents.map((document) => [String(document._id), document]));

    const missingId = ids.find((id) => !documentsById.has(id));
    if (missingId) {
        return {
            valid: false,
            ids,
            message: `${config.label} ID "${missingId}" does not refer to an existing ${config.label.toLowerCase()}.`
        };
    }

    const inaccessibleId = ids.find((id) => {
        const document = documentsById.get(id);
        return req.auth?.role !== 'admin' && String(document?.createdBy ?? '') !== req.auth?.userId;
    });
    if (inaccessibleId) {
        return {
            valid: false,
            ids,
            message: `${config.label} ID "${inaccessibleId}" belongs to content you cannot modify.`
        };
    }

    return { valid: true, ids };
};
