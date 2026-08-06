import { ObjectId, type ClientSession } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';
import {
    AlbumReferenceUnavailableError,
    isReadyAlbumLifecycle,
    readyAlbumLifecycleFilter,
    touchReadyAlbumReferences,
    withReadyAlbumReferences
} from './albumReferenceFenceService';
import { touchReadyArtistReferences } from './artistReferenceFenceService';
import { touchReadyAudioTrackReferences } from './audioTrackReferenceFenceService';
import {
    isAudioObjectKeyForTrack,
    readyAudioObjectFilter,
    readyAudioStorageFilter
} from '../utils/audioStorageKey';

type AlbumPublicationMode = 'published' | 'staged';

export interface AlbumTrackReplacementOptions {
    expectedCoverArtId?: string | null;
    requireExpectedCoverArtMatch?: boolean;
}

export interface AudioTrackAlbumUpdateOptions {
    expectedCoverArtId?: string | null;
    requireExpectedCoverArtMatch?: boolean;
}

/** Signals a write that may have committed but whose complete relationship cannot be proven. */
export class CatalogRelationshipUpdateOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'catalog_relationship_update_outcome_unknown';
    readonly cleanupPending = true;
    readonly reconciliationRequired = true;
    readonly outcomeUnknown = true;
    readonly cause: unknown;

    constructor(message: string, cause: unknown) {
        super(message);
        this.cause = cause;
    }
}

const normalizeTrackIds = (values: readonly unknown[], allowEmpty = false) => {
    const ids = [...new Set(values.map((value) => String(value).trim().toLowerCase()))];
    if ((!allowEmpty && ids.length === 0) || ids.some((id) => !/^[0-9a-f]{24}$/.test(id))) {
        throw new Error('One or more Soundtrack IDs are invalid.');
    }
    return ids;
};

const normalizeAlbumId = (value: unknown, allowEmpty = true) => {
    const id = String(value ?? '').trim().toLowerCase();
    if ((!allowEmpty && !id) || (id && !/^[0-9a-f]{24}$/.test(id))) {
        throw new Error('Album ID is invalid.');
    }
    return id;
};

const canonicalStoredTrackIds = (values: unknown) => normalizeTrackIds(
    Array.isArray(values)
        ? values.filter((value) => /^[0-9a-f]{24}$/i.test(String(value ?? '')))
        : [],
    true
);

const hasExactCanonicalTrackOrder = (values: unknown, expected: readonly string[]) =>
    Array.isArray(values)
    && values.length === expected.length
    && values.every((value, index) => typeof value === 'string' && value === expected[index]);

const publicationFailureMessage = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Covers all historical MongoDB representations while every new write stays lowercase. */
const storageReferenceValues = (ids: readonly string[]) => ids.flatMap((id) => [
    id,
    id.toUpperCase(),
    ObjectId.createFromHexString(id)
]);

const expectedCoverArtReference = (expectedImageId: string | null | undefined) =>
    expectedImageId
        ? { coverArtId: expectedImageId }
        : { $or: [{ coverArtId: null }, { coverArtId: { $exists: false } }] };

const relationshipWriteMayHaveCommitted = (error: any) =>
    error?.hasErrorLabel?.('UnknownTransactionCommitResult') === true
    || [
        'MongoNetworkError',
        'MongoNetworkTimeoutError',
        'MongoPoolClearedError',
        'MongoServerSelectionError',
        'MongoTimeoutError'
    ].includes(String(error?.name ?? ''));

const comparableValue = (value: any): any => {
    if (value instanceof ObjectId) return { $objectId: value.toHexString() };
    if (value instanceof Date) return { $date: value.toISOString() };
    if (Array.isArray(value)) return value.map(comparableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [
            key,
            comparableValue(value[key])
        ]));
    }
    return value;
};

const requestedFieldsMatch = (document: any, update: Record<string, unknown>) =>
    Object.entries(update).every(([field, expected]) =>
        JSON.stringify(comparableValue(document?.[field]))
        === JSON.stringify(comparableValue(expected))
    );

/**
 * Removes canonical membership from every prior Album before assigning the
 * requested Album. All reads and writes run inside the caller's transaction.
 */
const replaceCanonicalAlbumMembership = async (
    session: ClientSession,
    normalizedAudioTrackIds: readonly string[],
    normalizedAlbumId: string,
    options: {
        exactTargetOrder?: readonly string[];
        targetAlbumUpdate?: Record<string, unknown>;
        targetAlbumExpectedFilter?: Record<string, unknown>;
        targetExists?: boolean;
        updateTrackAlbumId?: boolean;
    } = {}
) => {
    const referenceValues = storageReferenceValues(normalizedAudioTrackIds);
    if (normalizedAudioTrackIds.length > 0) {
        const priorAlbums = await getDb()!.collection('albums').find(
            {
                audioTrackIds: { $in: referenceValues },
                ...(normalizedAlbumId
                    ? { _id: { $ne: ObjectId.createFromHexString(normalizedAlbumId) } }
                    : {})
            },
            { session, projection: { _id: 1, lifecycleStatus: 1 } }
        ).limit(1_001).toArray();
        if (priorAlbums.length > 1_000) {
            throw new Error('Soundtrack relink exceeds the 1000-Album safety limit.');
        }
        if (priorAlbums.some((album) => !isReadyAlbumLifecycle(album))) {
            throw new AlbumReferenceUnavailableError();
        }
        if (priorAlbums.length > 0) {
            const removed = await getDb()!.collection('albums').updateMany(
                {
                    _id: { $in: priorAlbums.map((album) => album._id) },
                    ...readyAlbumLifecycleFilter
                },
                {
                    $pull: { audioTrackIds: { $in: referenceValues } },
                    $inc: { referenceRevision: 1 }
                } as any,
                { session }
            );
            if (removed.matchedCount !== priorAlbums.length) {
                throw new AlbumReferenceUnavailableError();
            }
        }

        if (options.updateTrackAlbumId !== false) {
            const tracks = await getDb()!.collection('audioTracks').updateMany(
                {
                    _id: {
                        $in: normalizedAudioTrackIds.map((id) => ObjectId.createFromHexString(id))
                    },
                    ...readyAudioStorageFilter
                },
                { $set: { albumId: normalizedAlbumId } },
                { session }
            );
            if (tracks.matchedCount !== normalizedAudioTrackIds.length) {
                throw new Error('One or more Soundtracks changed while linking the Album.');
            }
        }
    }

    if (normalizedAlbumId && options.targetExists !== false) {
        const targetAlbum = await getDb()!.collection('albums').findOne(
            {
                _id: ObjectId.createFromHexString(normalizedAlbumId),
                ...readyAlbumLifecycleFilter
            },
            { session, projection: { audioTrackIds: 1 } }
        );
        if (!targetAlbum) throw new AlbumReferenceUnavailableError();
        const exactTargetOrder = options.exactTargetOrder
            ? normalizeTrackIds(options.exactTargetOrder, true)
            : undefined;
        const targetAudioTrackIds = exactTargetOrder ?? (() => {
            const existing = canonicalStoredTrackIds(targetAlbum.audioTrackIds);
            const seen = new Set(existing);
            for (const audioTrackId of normalizedAudioTrackIds) {
                if (seen.has(audioTrackId)) continue;
                seen.add(audioTrackId);
                existing.push(audioTrackId);
            }
            return existing;
        })();
        const albumConditions: Record<string, unknown>[] = [readyAlbumLifecycleFilter];
        if (options.targetAlbumExpectedFilter) {
            albumConditions.push(options.targetAlbumExpectedFilter);
        }
        const album = await getDb()!.collection('albums').updateOne(
            {
                _id: ObjectId.createFromHexString(normalizedAlbumId),
                $and: albumConditions
            },
            {
                $set: {
                    ...(options.targetAlbumUpdate ?? {}),
                    audioTrackIds: targetAudioTrackIds
                }
            },
            { session }
        );
        if (album.matchedCount !== 1) {
            throw new AlbumReferenceUnavailableError();
        }
    }
};

const loadAlbumReferencesForTracks = async (audioTrackIds: readonly string[]) => {
    if (audioTrackIds.length === 0) return [];
    return getDb()!.collection('albums').find({
        audioTrackIds: { $in: storageReferenceValues(audioTrackIds) }
    }, {
        projection: { _id: 1, audioTrackIds: 1, lifecycleStatus: 1 }
    }).limit(1_001).toArray();
};

/** Confirms every Album-list field and both sides after a possibly lost commit reply. */
export const confirmReadyAlbumTrackReplacement = async (
    albumId: string,
    desiredAudioTrackIds: readonly string[],
    albumUpdate: Record<string, unknown>
) => {
    const normalizedAlbumId = normalizeAlbumId(albumId, false);
    const desired = normalizeTrackIds(desiredAudioTrackIds, true);
    const album = await getDb()!.collection('albums').findOne({
        _id: ObjectId.createFromHexString(normalizedAlbumId),
        ...readyAlbumLifecycleFilter
    });
    if (!album
        || !hasExactCanonicalTrackOrder(album.audioTrackIds, desired)
        || !requestedFieldsMatch(album, albumUpdate)) {
        return false;
    }

    const linkedTracks = await getDb()!.collection('audioTracks').find({
        albumId: { $in: storageReferenceValues([normalizedAlbumId]) }
    }, { projection: { _id: 1 } }).limit(desired.length + 1).toArray();
    const linkedIds = normalizeTrackIds(linkedTracks.map((track) => track._id), true);
    if (linkedTracks.length !== desired.length
        || linkedIds.length !== desired.length
        || linkedIds.some((id, index) => id !== desired[index] && !desired.includes(id))) {
        return false;
    }
    if (new Set(linkedIds).size !== desired.length
        || desired.some((id) => !linkedIds.includes(id))) {
        return false;
    }

    if (desired.length > 0) {
        const readyTracks = await getDb()!.collection('audioTracks').find({
            _id: { $in: desired.map((id) => ObjectId.createFromHexString(id)) },
            ...readyAudioStorageFilter
        }, { projection: { _id: 1, albumId: 1 } }).limit(desired.length + 1).toArray();
        if (readyTracks.length !== desired.length || readyTracks.some((track) =>
            typeof track.albumId !== 'string' || track.albumId !== normalizedAlbumId
        )) {
            return false;
        }
        const albumReferences = await loadAlbumReferencesForTracks(desired);
        if (albumReferences.length !== 1
            || String(albumReferences[0]._id) !== normalizedAlbumId
            || !isReadyAlbumLifecycle(albumReferences[0])) {
            return false;
        }
    }
    return true;
};

/** Reassigns validated Tracks before a new Album owner is inserted in the same transaction. */
export const assignReadyAudioTracksToNewAlbum = async (
    session: ClientSession,
    albumId: string,
    audioTrackIds: readonly string[]
) => {
    const normalizedAlbumId = normalizeAlbumId(albumId, false);
    const normalizedAudioTrackIds = normalizeTrackIds(audioTrackIds, true);
    await replaceCanonicalAlbumMembership(
        session,
        normalizedAudioTrackIds,
        normalizedAlbumId,
        { targetExists: false }
    );
    return normalizedAudioTrackIds;
};

/**
 * Replaces an Album's ordered list, metadata/CAS, and both relationship sides
 * in one transaction. Removed dangling/non-ready rows do not block cleanup.
 */
export const replaceReadyAlbumAudioTracks = async (
    albumId: string,
    audioTrackIds: readonly unknown[],
    albumUpdate: Record<string, unknown> = {},
    options: AlbumTrackReplacementOptions = {}
) => {
    const normalizedAlbumId = normalizeAlbumId(albumId, false);
    const desiredAudioTrackIds = normalizeTrackIds(audioTrackIds, true);
    try {
        return await withReadyAlbumReferences(
            [normalizedAlbumId],
            async (session, [readyAlbumId]) => {
                const album = await getDb()!.collection('albums').findOne(
                    {
                        _id: ObjectId.createFromHexString(readyAlbumId),
                        ...readyAlbumLifecycleFilter
                    },
                    { session, projection: { audioTrackIds: 1 } }
                );
                if (!album) throw new AlbumReferenceUnavailableError();

                // Desired and retained rows must be published/ready. Removed
                // dangling rows are conditionally cleared without a readiness fence.
                await touchReadyAudioTrackReferences(desiredAudioTrackIds, session);
                await getDb()!.collection('audioTracks').updateMany(
                    {
                        albumId: { $in: storageReferenceValues([readyAlbumId]) },
                        ...(desiredAudioTrackIds.length > 0
                            ? {
                                _id: {
                                    $nin: desiredAudioTrackIds.map(
                                        (id) => ObjectId.createFromHexString(id)
                                    )
                                }
                            }
                            : {})
                    },
                    { $set: { albumId: '' } },
                    { session }
                );

                await replaceCanonicalAlbumMembership(
                    session,
                    desiredAudioTrackIds,
                    readyAlbumId,
                    {
                        exactTargetOrder: desiredAudioTrackIds,
                        targetAlbumUpdate: albumUpdate,
                        targetAlbumExpectedFilter: options.requireExpectedCoverArtMatch
                            ? expectedCoverArtReference(options.expectedCoverArtId)
                            : undefined
                    }
                );
                return { matchedCount: 1, modifiedCount: 1 };
            }
        );
    } catch (error) {
        if (!relationshipWriteMayHaveCommitted(error)) throw error;
        let confirmed = false;
        let confirmationError: unknown;
        try {
            confirmed = await confirmReadyAlbumTrackReplacement(
                normalizedAlbumId,
                desiredAudioTrackIds,
                albumUpdate
            );
        } catch (errorDuringConfirmation) {
            confirmationError = errorDuringConfirmation;
        }
        if (confirmed) return { matchedCount: 1, modifiedCount: 1 };
        throw new CatalogRelationshipUpdateOutcomeUnknownError(
            `Album ${normalizedAlbumId} update outcome could not be confirmed.`,
            { writeError: error, confirmationError }
        );
    }
};

const confirmArtistReferences = async (update: Record<string, unknown>) => {
    if (!Object.prototype.hasOwnProperty.call(update, 'artistIds')) return true;
    const artistIds = normalizeTrackIds(Array.isArray(update.artistIds) ? update.artistIds : [], true);
    if (artistIds.length === 0) return true;
    const artists = await getDb()!.collection('artists').find({
        _id: { $in: artistIds.map((id) => ObjectId.createFromHexString(id)) },
        // Reuse the canonical predicate through a readiness touch-style query.
        $or: [
            { lifecycleStatus: 'ready' },
            { lifecycleStatus: { $exists: false } }
        ]
    }, { projection: { _id: 1 } }).limit(artistIds.length + 1).toArray();
    return artists.length === artistIds.length;
};

/** Confirms metadata plus the exact visible/staged Album relationship. */
export const confirmReadyAudioTrackAlbumUpdate = async (
    audioTrackId: string,
    albumId: string,
    trackUpdate: Record<string, unknown>,
    publicationMode: AlbumPublicationMode
) => {
    const normalizedAudioTrackId = normalizeTrackIds([audioTrackId])[0];
    const normalizedAlbumId = normalizeAlbumId(albumId);
    const track = await getDb()!.collection('audioTracks').findOne({
        _id: ObjectId.createFromHexString(normalizedAudioTrackId),
        ...readyAudioObjectFilter
    });
    if (!track
        || typeof track.albumId !== 'string'
        || track.albumId !== normalizedAlbumId
        || !requestedFieldsMatch(track, trackUpdate)
        || !await confirmArtistReferences(trackUpdate)) {
        return false;
    }

    const hasPublicationStatus = Object.prototype.hasOwnProperty.call(track, 'publicationStatus');
    const isPublished = !hasPublicationStatus || track.publicationStatus === 'ready';
    if ((publicationMode === 'published') !== isPublished) return false;

    if (normalizedAlbumId) {
        const targetAlbum = await getDb()!.collection('albums').findOne({
            _id: ObjectId.createFromHexString(normalizedAlbumId),
            ...readyAlbumLifecycleFilter
        }, { projection: { _id: 1 } });
        if (!targetAlbum) return false;
    }

    const albumReferences = await loadAlbumReferencesForTracks([normalizedAudioTrackId]);
    if (publicationMode === 'staged' || !normalizedAlbumId) {
        return albumReferences.length === 0;
    }
    if (albumReferences.length !== 1
        || String(albumReferences[0]._id) !== normalizedAlbumId
        || !isReadyAlbumLifecycle(albumReferences[0])) {
        return false;
    }
    const occurrences = (Array.isArray(albumReferences[0].audioTrackIds)
        ? albumReferences[0].audioTrackIds
        : []).filter((value: unknown) =>
        /^[0-9a-f]{24}$/i.test(String(value ?? ''))
        && String(value).toLowerCase() === normalizedAudioTrackId
    );
    return occurrences.length === 1
        && typeof occurrences[0] === 'string'
        && occurrences[0] === normalizedAudioTrackId;
};

/**
 * Updates Track metadata/cover CAS and Album placement in one transaction.
 * Explicitly unpublished upload-ready rows only stage albumId and remain absent
 * from every Album until publication retry commits both sides.
 */
export const updateReadyAudioTrackAndAlbum = async (
    audioTrackId: string,
    albumId: string,
    trackUpdate: Record<string, unknown> = {},
    options: AudioTrackAlbumUpdateOptions = {}
) => {
    const normalizedAudioTrackId = normalizeTrackIds([audioTrackId])[0];
    const normalizedAlbumId = normalizeAlbumId(albumId);
    const normalizedTrackUpdate = { ...trackUpdate };
    if (Object.prototype.hasOwnProperty.call(normalizedTrackUpdate, 'albumId')) {
        delete normalizedTrackUpdate.albumId;
    }

    const session = getDatabaseClient().startSession();
    let publicationMode: AlbumPublicationMode | undefined;
    try {
        await session.withTransaction(async () => {
            if (normalizedAlbumId) {
                await touchReadyAlbumReferences([normalizedAlbumId], session);
            }
            const existingTrack = await getDb()!.collection('audioTracks').findOne(
                {
                    _id: ObjectId.createFromHexString(normalizedAudioTrackId),
                    ...readyAudioObjectFilter
                },
                { session, projection: { publicationStatus: 1 } }
            );
            if (!existingTrack) {
                throw new Error('The Soundtrack is not an upload-ready object.');
            }
            const hasPublicationStatus = Object.prototype.hasOwnProperty.call(
                existingTrack,
                'publicationStatus'
            );
            publicationMode = !hasPublicationStatus || existingTrack.publicationStatus === 'ready'
                ? 'published'
                : 'staged';

            if (Object.prototype.hasOwnProperty.call(normalizedTrackUpdate, 'artistIds')) {
                if (!Array.isArray(normalizedTrackUpdate.artistIds)) {
                    throw new Error('artistIds must be an array.');
                }
                normalizedTrackUpdate.artistIds = await touchReadyArtistReferences(
                    normalizedTrackUpdate.artistIds,
                    session
                );
            }

            if (publicationMode === 'published') {
                await replaceCanonicalAlbumMembership(
                    session,
                    [normalizedAudioTrackId],
                    normalizedAlbumId,
                    { updateTrackAlbumId: false }
                );
            } else {
                // Repair any accidental pre-publication exposure before staging
                // the requested target for the later publication transaction.
                await replaceCanonicalAlbumMembership(
                    session,
                    [normalizedAudioTrackId],
                    '',
                    { updateTrackAlbumId: false }
                );
            }

            const conditions: Record<string, unknown>[] = [readyAudioObjectFilter];
            if (options.requireExpectedCoverArtMatch) {
                conditions.push(expectedCoverArtReference(options.expectedCoverArtId));
            }
            const updated = await getDb()!.collection('audioTracks').updateOne(
                {
                    _id: ObjectId.createFromHexString(normalizedAudioTrackId),
                    $and: conditions
                },
                {
                    $set: {
                        ...normalizedTrackUpdate,
                        albumId: normalizedAlbumId
                    },
                    $inc: { contentReferenceRevision: 1 }
                },
                { session }
            );
            if (updated.matchedCount !== 1) {
                throw new Error('The Soundtrack changed while updating its Album relationship.');
            }
        });
        return {
            matchedCount: 1,
            modifiedCount: 1,
            publicationMode: publicationMode!
        };
    } catch (error) {
        if (!relationshipWriteMayHaveCommitted(error) || !publicationMode) throw error;
        let confirmed = false;
        let confirmationError: unknown;
        try {
            confirmed = await confirmReadyAudioTrackAlbumUpdate(
                normalizedAudioTrackId,
                normalizedAlbumId,
                normalizedTrackUpdate,
                publicationMode
            );
        } catch (errorDuringConfirmation) {
            confirmationError = errorDuringConfirmation;
        }
        if (confirmed) {
            return { matchedCount: 1, modifiedCount: 1, publicationMode };
        }
        throw new CatalogRelationshipUpdateOutcomeUnknownError(
            `Soundtrack ${normalizedAudioTrackId} update outcome could not be confirmed.`,
            { writeError: error, confirmationError }
        );
    } finally {
        await session.endSession();
    }
};

/**
 * Publishes uploaded Soundtracks only in the transaction that establishes the
 * Album's canonical relationship. Legacy published rows use the link helper.
 */
export const publishUploadedAudioTracks = async (
    albumId: string,
    audioTrackIds: readonly string[]
) => {
    const normalizedTrackIds = normalizeTrackIds(audioTrackIds);
    const trackObjectIds = normalizedTrackIds.map((id) => ObjectId.createFromHexString(id));
    const normalizedAlbumId = normalizeAlbumId(albumId);

    const publishTracks = async (session: ClientSession, readyAlbumId: string) => {
        const published = await getDb()!.collection('audioTracks').updateMany(
            {
                _id: { $in: trackObjectIds },
                ...readyAudioObjectFilter,
                publicationStatus: { $in: ['pending', 'failed', 'ready'] }
            },
            {
                $set: {
                    albumId: readyAlbumId,
                    publicationStatus: 'ready',
                    publicationUpdatedAt: new Date(),
                    publicationError: null
                },
                $inc: { contentReferenceRevision: 1 }
            },
            { session }
        );
        if (published.matchedCount !== trackObjectIds.length) {
            throw new Error('One or more uploaded Soundtracks are unavailable for publication.');
        }

        await replaceCanonicalAlbumMembership(
            session,
            normalizedTrackIds,
            readyAlbumId,
            { updateTrackAlbumId: false }
        );
    };

    try {
        if (normalizedAlbumId) {
            return await withReadyAlbumReferences(
                [normalizedAlbumId],
                async (session, [readyAlbumId]) => {
                    await publishTracks(session, readyAlbumId);
                    return { albumId: readyAlbumId, audioTrackIds: normalizedTrackIds };
                }
            );
        }

        const session = getDatabaseClient().startSession();
        try {
            await session.withTransaction(() => publishTracks(session, ''));
        } finally {
            await session.endSession();
        }
        return { albumId: '', audioTrackIds: normalizedTrackIds };
    } catch (error) {
        await getDb()!.collection('audioTracks').updateMany(
            {
                _id: { $in: trackObjectIds },
                publicationStatus: { $in: ['pending', 'failed'] }
            },
            {
                $set: {
                    publicationStatus: 'failed',
                    publicationUpdatedAt: new Date(),
                    publicationError: publicationFailureMessage(error)
                }
            }
        ).catch(() => undefined);
        throw error;
    }
};

/** Links both sides only after Album and ready-Soundtrack fences commit in one transaction. */
export const relinkReadyAudioTracksToAlbum = async (
    albumId: string,
    audioTrackIds: readonly string[]
) => {
    const normalizedAlbumId = normalizeAlbumId(albumId);

    const mutate = async (session: ClientSession, readyAlbumId: string) => {
        const normalizedAudioTrackIds = await touchReadyAudioTrackReferences(
            audioTrackIds,
            session
        );
        if (normalizedAudioTrackIds.length === 0) {
            return { albumId: readyAlbumId, audioTrackIds: [] };
        }
        await replaceCanonicalAlbumMembership(
            session,
            normalizedAudioTrackIds,
            readyAlbumId
        );
        return { albumId: readyAlbumId, audioTrackIds: normalizedAudioTrackIds };
    };

    if (normalizedAlbumId) {
        return withReadyAlbumReferences(
            [normalizedAlbumId],
            (session, [readyAlbumId]) => mutate(session, readyAlbumId)
        );
    }

    const session = getDatabaseClient().startSession();
    let result: { albumId: string; audioTrackIds: string[] } | undefined;
    try {
        await session.withTransaction(async () => {
            result = await mutate(session, '');
        });
    } finally {
        await session.endSession();
    }
    return result!;
};

/** Backward-compatible name for assigning ready Soundtracks to an Album. */
export const linkReadyAudioTracksToAlbum = (
    albumId: string,
    audioTrackIds: readonly string[]
) => relinkReadyAudioTracksToAlbum(albumId, audioTrackIds);

/** Clears both Track.albumId and every canonical Album membership atomically. */
export const clearReadyAudioTrackAlbumLinks = (audioTrackIds: readonly string[]) =>
    relinkReadyAudioTracksToAlbum('', audioTrackIds);
