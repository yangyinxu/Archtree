import { ClientSession, ObjectId } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';

export type ArtistLifecycleStatus = 'ready' | 'deleting' | 'deleteFailed';

/** Treats pre-lifecycle Artist records as ready while excluding failed/deleting states. */
export const readyArtistLifecycleFilter = {
    $or: [
        { lifecycleStatus: 'ready' },
        { lifecycleStatus: { $exists: false } }
    ]
};

export const isReadyArtistLifecycle = (artist: any) =>
    artist?.lifecycleStatus === undefined || artist?.lifecycleStatus === 'ready';

export class ArtistReferenceUnavailableError extends Error {
    readonly statusCode = 409;
    readonly code = 'artist_reference_unavailable';

    constructor() {
        super('One or more Artists are unavailable for new references.');
    }
}

const canonicalArtistIds = (values: readonly unknown[]) => {
    const ids = [...new Set(values.map((value) => String(value ?? '').trim().toLowerCase()))];
    if (ids.some((id) => !/^[0-9a-f]{24}$/.test(id))) {
        throw new ArtistReferenceUnavailableError();
    }
    return ids;
};

/** Writes the Artist fence inside the caller's transaction before a new reference is stored. */
export const touchReadyArtistReferences = async (
    artistIds: readonly unknown[],
    session: ClientSession
) => {
    const ids = canonicalArtistIds(artistIds);
    if (ids.length === 0) return ids;
    const touched = await getDb()!.collection('artists').updateMany(
        {
            _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) },
            ...readyArtistLifecycleFilter
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
    if (touched.matchedCount !== ids.length) {
        throw new ArtistReferenceUnavailableError();
    }
    return ids;
};

/** Commits an Artist readiness touch and every resulting cross-document reference atomically. */
export const withReadyArtistReferences = async <T>(
    artistIds: readonly unknown[],
    mutation: (session: ClientSession, normalizedArtistIds: string[]) => Promise<T>
): Promise<T> => {
    const session = getDatabaseClient().startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            const normalizedArtistIds = await touchReadyArtistReferences(artistIds, session);
            result = await mutation(session, normalizedArtistIds);
        });
    } finally {
        await session.endSession();
    }
    return result as T;
};
