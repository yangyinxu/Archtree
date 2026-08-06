import { ClientSession, ObjectId } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';

export type AlbumLifecycleStatus = 'ready' | 'deleting' | 'deleteFailed';

/** Treats pre-lifecycle Album records as ready while excluding failed/deleting states. */
export const readyAlbumLifecycleFilter = {
    $or: [
        { lifecycleStatus: 'ready' },
        { lifecycleStatus: { $exists: false } }
    ]
};

export const isReadyAlbumLifecycle = (album: any) =>
    album?.lifecycleStatus === undefined || album?.lifecycleStatus === 'ready';

export class AlbumReferenceUnavailableError extends Error {
    readonly statusCode = 409;
    readonly code = 'album_reference_unavailable';

    constructor() {
        super('One or more Albums are unavailable for new references.');
    }
}

const canonicalAlbumIds = (values: readonly unknown[]) => {
    const ids = [...new Set(values
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean))];
    if (ids.some((id) => !/^[0-9a-f]{24}$/.test(id))) {
        throw new AlbumReferenceUnavailableError();
    }
    return ids;
};

/** Writes the Album deletion fence inside the caller's transaction before storing references. */
export const touchReadyAlbumReferences = async (
    albumIds: readonly unknown[],
    session: ClientSession
) => {
    const ids = canonicalAlbumIds(albumIds);
    if (ids.length === 0) return ids;
    const touched = await getDb()!.collection('albums').updateMany(
        {
            _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) },
            ...readyAlbumLifecycleFilter
        },
        {
            $set: {
                lifecycleStatus: 'ready',
                lifecycleUpdatedAt: new Date(),
                lifecycleError: null
            },
            $inc: { referenceRevision: 1 }
        },
        { session }
    );
    if (touched.matchedCount !== ids.length) throw new AlbumReferenceUnavailableError();
    return ids;
};

/** Commits an Album readiness touch and every resulting cross-document reference atomically. */
export const withReadyAlbumReferences = async <T>(
    albumIds: readonly unknown[],
    mutation: (session: ClientSession, normalizedAlbumIds: string[]) => Promise<T>
): Promise<T> => {
    const session = getDatabaseClient().startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            const normalizedAlbumIds = await touchReadyAlbumReferences(albumIds, session);
            result = await mutation(session, normalizedAlbumIds);
        });
    } finally {
        await session.endSession();
    }
    return result as T;
};
