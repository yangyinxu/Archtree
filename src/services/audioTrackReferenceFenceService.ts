import { ClientSession, ObjectId } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';

export class AudioTrackReferenceUnavailableError extends Error {
    readonly statusCode = 409;
    readonly code = 'audio_track_reference_unavailable';

    constructor() {
        super('One or more ready Soundtracks are unavailable for new references.');
    }
}

const canonicalAudioTrackIds = (values: readonly unknown[]) => {
    const ids = [...new Set(values
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean))];
    if (ids.some((id) => !/^[0-9a-f]{24}$/.test(id))) {
        throw new AudioTrackReferenceUnavailableError();
    }
    return ids;
};

/** Touches ready storage records so deletion and every new external reference serialize. */
export const touchReadyAudioTrackReferences = async (
    audioTrackIds: readonly unknown[],
    session: ClientSession
) => {
    const ids = canonicalAudioTrackIds(audioTrackIds);
    if (ids.length === 0) return ids;
    const touched = await getDb()!.collection('audioTracks').updateMany(
        {
            _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) },
            ...readyAudioStorageFilter
        },
        {
            $inc: { contentReferenceRevision: 1 }
        },
        { session }
    );
    if (touched.matchedCount !== ids.length) throw new AudioTrackReferenceUnavailableError();
    return ids;
};

/** Commits ready-Soundtrack touches and the resulting reference mutation atomically. */
export const withReadyAudioTrackReferences = async <T>(
    audioTrackIds: readonly unknown[],
    mutation: (session: ClientSession, normalizedAudioTrackIds: string[]) => Promise<T>
): Promise<T> => {
    const session = getDatabaseClient().startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            const normalizedAudioTrackIds = await touchReadyAudioTrackReferences(
                audioTrackIds,
                session
            );
            result = await mutation(session, normalizedAudioTrackIds);
        });
    } finally {
        await session.endSession();
    }
    return result as T;
};
