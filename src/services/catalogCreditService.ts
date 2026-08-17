import { ClientSession, ObjectId } from 'mongodb';

import { requireCatalogCreditWrites } from '../config/catalogCreditRollout';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import {
    AttributionStatus,
    CatalogCredit,
    CatalogCreditValidationError,
    legacyAlbumArtistIdsFromCredits,
    legacyTrackArtistIdsFromCredits,
    migratedCatalogCreditId,
    normalizeCatalogCredits,
    validateAttribution
} from '../models/catalogCredit';
import {
    readyArtistLifecycleFilter,
    touchReadyArtistReferences
} from './artistReferenceFenceService';
import { readyAlbumLifecycleFilter } from './albumReferenceFenceService';
import { touchReadyOrganizationReferences } from './organizationReferenceFenceService';

export type CatalogCreditOwnerType = 'album' | 'audioTrack';

export interface CatalogCreditMutationResult {
    ownerType: CatalogCreditOwnerType;
    ownerId: string;
    credits: CatalogCredit[];
    attributionStatus: AttributionStatus;
    creditRevision: number;
}

export class CatalogCreditConflictError extends Error {
    readonly statusCode = 409;
    readonly code = 'catalog_credit_conflict';

    constructor(message: string = 'Credits changed concurrently. Reload and try again.') {
        super(message);
    }
}

export class CatalogCreditOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'catalog_credit_outcome_unknown';
    readonly outcomeUnknown = true;

    constructor() {
        super('The Credit update outcome could not be confirmed. Run reconciliation before retrying.');
    }
}

const ownerConfig = {
    album: {
        collection: 'albums',
        readyFilter: readyAlbumLifecycleFilter
    },
    audioTrack: {
        collection: 'audioTracks',
        readyFilter: { uploadStatus: { $nin: ['deleting', 'deleteFailed'] } }
    }
} as const;

const canonicalOwnerId = (value: unknown) => {
    const id = String(value ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(id)) {
        throw new CatalogCreditValidationError('Credit owner ID is invalid.');
    }
    return id;
};

const albumReferenceValues = (albumId: string) => [
    albumId,
    albumId.toUpperCase(),
    ObjectId.createFromHexString(albumId)
];

const legacyCreditsForUnmigratedOwner = async (
    session: ClientSession,
    ownerType: CatalogCreditOwnerType,
    ownerId: string,
    owner: any
) => {
    if (Array.isArray(owner.credits)) return normalizeCatalogCredits(owner.credits);
    if (ownerType === 'audioTrack') {
        const artistIds = [...new Set<string>((Array.isArray(owner.artistIds) ? owner.artistIds : [])
            .map((value: unknown) => String(value ?? '').trim().toLowerCase())
            .filter((id: string) => /^[0-9a-f]{24}$/.test(id)))];
        return normalizeCatalogCredits(artistIds.map((subjectId, index) => ({
            creditId: migratedCatalogCreditId('audioTrack', ownerId, 'artist', subjectId, 'legacyUnspecified'),
            subjectType: 'artist',
            subjectId,
            role: 'legacyUnspecified',
            order: index
        })));
    }
    const artists = await getDb()!.collection('artists').find(
        {
            albumIds: { $in: albumReferenceValues(ownerId) },
            ...readyArtistLifecycleFilter
        },
        { session, projection: { _id: 1 } }
    ).sort({ _id: 1 }).toArray();
    return normalizeCatalogCredits(artists.map((artist, index) => {
        const subjectId = String(artist._id);
        return {
            creditId: migratedCatalogCreditId('album', ownerId, 'artist', subjectId, 'primary'),
            subjectType: 'artist',
            subjectId,
            role: 'primary',
            order: index
        };
    }));
};

const synchronizeAlbumArtistProjection = async (
    session: ClientSession,
    albumId: string,
    credits: readonly CatalogCredit[]
) => {
    const primaryArtistIds = legacyAlbumArtistIdsFromCredits(credits);
    const referenceValues = albumReferenceValues(albumId);
    await getDb()!.collection('artists').updateMany(
        { albumIds: { $in: referenceValues } },
        { $pull: { albumIds: { $in: referenceValues } } } as any,
        { session }
    );
    if (primaryArtistIds.length === 0) return;
    const added = await getDb()!.collection('artists').updateMany(
        {
            _id: { $in: primaryArtistIds.map((id) => ObjectId.createFromHexString(id)) },
            ...readyArtistLifecycleFilter
        },
        { $addToSet: { albumIds: albumId } } as any,
        { session }
    );
    if (added.matchedCount !== primaryArtistIds.length) {
        throw new CatalogCreditConflictError('One or more primary Artists became unavailable.');
    }
};

const writeMayHaveCommitted = (error: any) => error?.hasErrorLabel?.('UnknownTransactionCommitResult') === true
    || [
        'MongoNetworkError',
        'MongoNetworkTimeoutError',
        'MongoPoolClearedError',
        'MongoServerSelectionError',
        'MongoTimeoutError'
    ].includes(String(error?.name ?? ''));

const confirmCatalogCreditMutation = async (result: CatalogCreditMutationResult) => {
    const config = ownerConfig[result.ownerType];
    const owner: any = await getDb()!.collection(config.collection).findOne(
        { _id: ObjectId.createFromHexString(result.ownerId) },
        { projection: { credits: 1, attributionStatus: 1, creditRevision: 1, artistIds: 1 } }
    );
    if (!owner || owner.creditRevision !== result.creditRevision
        || owner.attributionStatus !== result.attributionStatus) return false;
    let storedCredits: CatalogCredit[];
    try {
        storedCredits = normalizeCatalogCredits(owner.credits);
    } catch {
        return false;
    }
    if (JSON.stringify(storedCredits) !== JSON.stringify(result.credits)) return false;
    if (result.ownerType === 'audioTrack') {
        return JSON.stringify(owner.artistIds ?? [])
            === JSON.stringify(legacyTrackArtistIdsFromCredits(result.credits));
    }
    const expected = [...legacyAlbumArtistIdsFromCredits(result.credits)].sort();
    const artists = await getDb()!.collection('artists').find({
        albumIds: { $in: albumReferenceValues(result.ownerId) }
    }).project({ _id: 1 }).toArray();
    const actual = artists.map((artist) => String(artist._id)).sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
};

const executeCatalogCreditTransaction = async (
    mutation: (session: ClientSession) => Promise<CatalogCreditMutationResult>
) => {
    requireCatalogCreditWrites();
    const session = getDatabaseClient().startSession();
    let result: CatalogCreditMutationResult | undefined;
    try {
        await session.withTransaction(async () => {
            result = await mutation(session);
        });
    } catch (error) {
        if (!result || !writeMayHaveCommitted(error)) throw error;
        const confirmed = await confirmCatalogCreditMutation(result).catch(() => false);
        if (!confirmed) throw new CatalogCreditOutcomeUnknownError();
    } finally {
        await session.endSession();
    }
    return result!;
};

const replaceWithinTransaction = async (
    session: ClientSession,
    ownerType: CatalogCreditOwnerType,
    ownerId: string,
    proposedCredits: unknown,
    proposedStatus: unknown,
    expectedCreditRevision?: number
): Promise<CatalogCreditMutationResult> => {
    const config = ownerConfig[ownerType];
    const ownerObjectId = ObjectId.createFromHexString(ownerId);
    const owner: any = await getDb()!.collection(config.collection).findOne(
        { _id: ownerObjectId, ...config.readyFilter },
        { session, projection: { credits: 1, attributionStatus: 1, creditRevision: 1 } }
    );
    if (!owner) throw new CatalogCreditConflictError('The Credit owner is unavailable.');
    const observedRevision = Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0;
    if (expectedCreditRevision !== undefined && expectedCreditRevision !== observedRevision) {
        throw new CatalogCreditConflictError();
    }

    const credits = normalizeCatalogCredits(proposedCredits);
    const attributionStatus = validateAttribution(proposedStatus, credits);
    const artistIds = credits
        .filter((credit) => credit.subjectType === 'artist')
        .map((credit) => credit.subjectId);
    const organizationIds = credits
        .filter((credit) => credit.subjectType === 'organization')
        .map((credit) => credit.subjectId);
    await touchReadyArtistReferences(artistIds, session);
    await touchReadyOrganizationReferences(organizationIds, session);

    const nextRevision = observedRevision + 1;
    const compatibilityUpdate = ownerType === 'audioTrack'
        ? { artistIds: legacyTrackArtistIdsFromCredits(credits) }
        : {};
    const updated = await getDb()!.collection(config.collection).updateOne(
        {
            _id: ownerObjectId,
            $and: [
                config.readyFilter,
                {
                    $or: [
                        { creditRevision: observedRevision },
                        ...(observedRevision === 0 ? [{ creditRevision: { $exists: false } }] : [])
                    ]
                }
            ]
        },
        {
            $set: {
                credits,
                attributionStatus,
                creditRevision: nextRevision,
                ...compatibilityUpdate
            }
        },
        { session }
    );
    if (updated.matchedCount !== 1) throw new CatalogCreditConflictError();
    if (ownerType === 'album') {
        await synchronizeAlbumArtistProjection(session, ownerId, credits);
    }
    return {
        ownerType,
        ownerId,
        credits,
        attributionStatus,
        creditRevision: nextRevision
    };
};

/** Atomically replaces Credits, subject fences, attribution state, and legacy projections. */
export const replaceCatalogCredits = async (
    ownerType: CatalogCreditOwnerType,
    rawOwnerId: string,
    credits: unknown,
    attributionStatus: unknown,
    expectedCreditRevision?: number
) => {
    const ownerId = canonicalOwnerId(rawOwnerId);
    return executeCatalogCreditTransaction((session) => replaceWithinTransaction(
        session,
        ownerType,
        ownerId,
        credits,
        attributionStatus,
        expectedCreditRevision
    ));
};

/** Adds one Credit idempotently; the same relationship does not reorder existing Credits. */
export const addCatalogCredit = async (
    ownerType: CatalogCreditOwnerType,
    rawOwnerId: string,
    credit: unknown,
    expectedCreditRevision?: number
) => {
    const ownerId = canonicalOwnerId(rawOwnerId);
    const candidate = normalizeCatalogCredits([credit])[0];
    return executeCatalogCreditTransaction(async (session) => {
            const owner: any = await getDb()!.collection(ownerConfig[ownerType].collection).findOne(
                { _id: ObjectId.createFromHexString(ownerId), ...ownerConfig[ownerType].readyFilter },
                { session, projection: { credits: 1, attributionStatus: 1, creditRevision: 1, artistIds: 1 } }
            );
            if (!owner) throw new CatalogCreditConflictError('The Credit owner is unavailable.');
            let existing = await legacyCreditsForUnmigratedOwner(
                session,
                ownerType,
                ownerId,
                owner
            );
            if (candidate.role !== 'legacyUnspecified') {
                existing = existing.filter((item) => !(item.subjectType === candidate.subjectType
                    && item.subjectId === candidate.subjectId
                    && item.role === 'legacyUnspecified'));
            }
            const duplicate = existing.some((item) => item.subjectType === candidate.subjectType
                && item.subjectId === candidate.subjectId && item.role === candidate.role);
            const observedRevision = Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0;
            if (expectedCreditRevision !== undefined && expectedCreditRevision !== observedRevision) {
                throw new CatalogCreditConflictError();
            }
            if (duplicate) {
                return {
                    ownerType,
                    ownerId,
                    credits: existing,
                    attributionStatus: owner.attributionStatus === 'unknown' ? 'unknown' : 'documented',
                    creditRevision: observedRevision
                };
            }
            return replaceWithinTransaction(
                session,
                ownerType,
                ownerId,
                [...existing, candidate],
                'documented',
                expectedCreditRevision
            );
    });
};

/** Adds a Soundtrack Credit and optionally promotes the same primary Artist to its Album atomically. */
export const addSoundtrackCredit = async (
    rawAudioTrackId: string,
    credit: unknown,
    promoteToAlbumPrimary: boolean,
    expectedCreditRevision?: number
) => {
    const audioTrackId = canonicalOwnerId(rawAudioTrackId);
    const candidate = normalizeCatalogCredits([credit])[0];
    if (promoteToAlbumPrimary && (candidate.subjectType !== 'artist' || candidate.role !== 'primary')) {
        throw new CatalogCreditValidationError(
            'Only a primary Artist Soundtrack Credit can be promoted to Album primary.'
        );
    }
    return executeCatalogCreditTransaction(async (session) => {
        const owner: any = await getDb()!.collection('audioTracks').findOne(
            { _id: ObjectId.createFromHexString(audioTrackId), ...ownerConfig.audioTrack.readyFilter },
            {
                session,
                projection: {
                    credits: 1,
                    attributionStatus: 1,
                    creditRevision: 1,
                    artistIds: 1,
                    albumId: 1
                }
            }
        );
        if (!owner) throw new CatalogCreditConflictError('The Soundtrack is unavailable.');
        let existing = await legacyCreditsForUnmigratedOwner(
            session,
            'audioTrack',
            audioTrackId,
            owner
        );
        if (candidate.role !== 'legacyUnspecified') {
            existing = existing.filter((item) => !(item.subjectType === candidate.subjectType
                && item.subjectId === candidate.subjectId && item.role === 'legacyUnspecified'));
        }
        const duplicate = existing.some((item) => item.subjectType === candidate.subjectType
            && item.subjectId === candidate.subjectId && item.role === candidate.role);
        const observedRevision = Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0;
        if (expectedCreditRevision !== undefined && expectedCreditRevision !== observedRevision) {
            throw new CatalogCreditConflictError();
        }
        if (duplicate && !promoteToAlbumPrimary) {
            return {
                ownerType: 'audioTrack' as const,
                ownerId: audioTrackId,
                credits: existing,
                attributionStatus: owner.attributionStatus === 'unknown' ? 'unknown' as const : 'documented' as const,
                creditRevision: observedRevision
            };
        }
        const nextTrackCredits = duplicate ? existing : [...existing, candidate];
        const trackResult = await replaceWithinTransaction(
            session,
            'audioTrack',
            audioTrackId,
            nextTrackCredits,
            'documented',
            observedRevision
        );
        if (!promoteToAlbumPrimary) return trackResult;

        const albumId = canonicalOwnerId(owner.albumId);
        const album: any = await getDb()!.collection('albums').findOne(
            { _id: ObjectId.createFromHexString(albumId), ...readyAlbumLifecycleFilter },
            { session, projection: { credits: 1, creditRevision: 1 } }
        );
        if (!album) throw new CatalogCreditConflictError('The linked Album is unavailable.');
        const albumCredits = await legacyCreditsForUnmigratedOwner(
            session,
            'album',
            albumId,
            album
        );
        const alreadyPrimary = albumCredits.some((item) => item.subjectType === 'artist'
            && item.subjectId === candidate.subjectId && item.role === 'primary');
        if (!alreadyPrimary) {
            await replaceWithinTransaction(
                session,
                'album',
                albumId,
                [...albumCredits, {
                    creditId: migratedCatalogCreditId(
                        'album', albumId, 'artist', candidate.subjectId, 'primary'
                    ),
                    subjectType: 'artist',
                    subjectId: candidate.subjectId,
                    role: 'primary',
                    order: albumCredits.length
                }],
                'documented',
                Number.isInteger(album.creditRevision) ? album.creditRevision : 0
            );
        }
        return trackResult;
    });
};

/** Adds the explicit Album primary-Artist intent while preserving unmigrated memberships. */
export const ensureAlbumPrimaryArtistCredit = (
    albumId: string,
    artistId: string,
    expectedCreditRevision?: number
) => addCatalogCredit('album', albumId, {
    creditId: migratedCatalogCreditId('album', albumId, 'artist', artistId, 'primary'),
    subjectType: 'artist',
    subjectId: artistId,
    role: 'primary',
    order: 0
}, expectedCreditRevision);

/** Removes one Album primary-Artist Credit while preserving every other attribution. */
export const removeAlbumPrimaryArtistCredit = async (
    rawAlbumId: string,
    rawArtistId: string,
    expectedCreditRevision?: number
) => {
    const albumId = canonicalOwnerId(rawAlbumId);
    const artistId = String(rawArtistId ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(artistId)) {
        throw new CatalogCreditValidationError('Artist ID is invalid.');
    }
    return executeCatalogCreditTransaction(async (session) => {
            const owner: any = await getDb()!.collection('albums').findOne(
                { _id: ObjectId.createFromHexString(albumId), ...readyAlbumLifecycleFilter },
                { session, projection: { credits: 1, creditRevision: 1 } }
            );
            if (!owner) throw new CatalogCreditConflictError('The Album is unavailable.');
            const existing = await legacyCreditsForUnmigratedOwner(
                session,
                'album',
                albumId,
                owner
            );
            const retained = existing.filter((credit) => !(credit.subjectType === 'artist'
                && credit.subjectId === artistId && credit.role === 'primary'));
            const observedRevision = Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0;
            if (expectedCreditRevision !== undefined && expectedCreditRevision !== observedRevision) {
                throw new CatalogCreditConflictError();
            }
            if (retained.length === existing.length && Array.isArray(owner.credits)) {
                return {
                    ownerType: 'album',
                    ownerId: albumId,
                    credits: existing,
                    attributionStatus: existing.length > 0 ? 'documented' : 'unknown',
                    creditRevision: observedRevision
                };
            }
            return replaceWithinTransaction(
                session,
                'album',
                albumId,
                retained,
                retained.length > 0 ? 'documented' : 'unknown',
                expectedCreditRevision
            );
    });
};

/** Replaces one Artist's complete primary Album set without touching other Credits. */
export const replaceArtistPrimaryAlbumCredits = async (
    rawArtistId: string,
    rawAlbumIds: readonly string[]
) => {
    requireCatalogCreditWrites();
    const artistId = canonicalOwnerId(rawArtistId);
    const albumIds = [...new Set(rawAlbumIds.map(canonicalOwnerId))];
    const session = getDatabaseClient().startSession();
    try {
        await session.withTransaction(async () => {
            await touchReadyArtistReferences([artistId], session);
            const requestedObjectIds = albumIds.map((id) => ObjectId.createFromHexString(id));
            const requestedAlbums = requestedObjectIds.length > 0
                ? await getDb()!.collection('albums').find({
                    _id: { $in: requestedObjectIds },
                    ...readyAlbumLifecycleFilter
                }, { session, projection: { _id: 1 } }).toArray()
                : [];
            if (requestedAlbums.length !== albumIds.length) {
                throw new CatalogCreditConflictError('One or more Albums became unavailable.');
            }
            const currentArtist: any = await getDb()!.collection('artists').findOne(
                { _id: ObjectId.createFromHexString(artistId), ...readyArtistLifecycleFilter },
                { session, projection: { albumIds: 1 } }
            );
            if (!currentArtist) throw new CatalogCreditConflictError('The Artist is unavailable.');
            const legacyAlbumIds = (Array.isArray(currentArtist.albumIds)
                ? currentArtist.albumIds : [])
                .map((value: unknown) => String(value ?? '').trim().toLowerCase())
                .filter((id: string) => /^[0-9a-f]{24}$/.test(id));
            const creditedAlbums = await getDb()!.collection('albums').find({
                credits: { $elemMatch: {
                    subjectType: 'artist',
                    subjectId: artistId,
                    role: 'primary'
                } },
                ...readyAlbumLifecycleFilter
            }, { session, projection: { _id: 1 } }).toArray();
            const affectedIds = [...new Set([
                ...albumIds,
                ...legacyAlbumIds,
                ...creditedAlbums.map((album) => String(album._id))
            ])].sort();
            for (const albumId of affectedIds) {
                const owner: any = await getDb()!.collection('albums').findOne(
                    { _id: ObjectId.createFromHexString(albumId), ...readyAlbumLifecycleFilter },
                    { session, projection: { credits: 1, creditRevision: 1 } }
                );
                if (!owner) throw new CatalogCreditConflictError('An affected Album became unavailable.');
                const existing = await legacyCreditsForUnmigratedOwner(
                    session,
                    'album',
                    albumId,
                    owner
                );
                const existingPrimary = existing.find((credit) => credit.subjectType === 'artist'
                    && credit.subjectId === artistId && credit.role === 'primary');
                const retained = existing.filter((credit) => !(credit.subjectType === 'artist'
                    && credit.subjectId === artistId && credit.role === 'primary'));
                const desired = albumIds.includes(albumId)
                    ? existingPrimary
                        ? existing
                        : normalizeCatalogCredits([...retained, {
                            creditId: migratedCatalogCreditId(
                                'album', albumId, 'artist', artistId, 'primary'
                            ),
                            subjectType: 'artist',
                            subjectId: artistId,
                            role: 'primary',
                            order: retained.length
                        }])
                    : retained;
                if (JSON.stringify(desired) === JSON.stringify(existing)
                    && Array.isArray(owner.credits)) continue;
                await replaceWithinTransaction(
                    session,
                    'album',
                    albumId,
                    desired,
                    desired.length > 0 ? 'documented' : 'unknown',
                    Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0
                );
            }
            await getDb()!.collection('artists').updateOne(
                { _id: ObjectId.createFromHexString(artistId), ...readyArtistLifecycleFilter },
                { $set: { albumIds } },
                { session }
            );
        });
        return albumIds;
    } catch (error) {
        if (writeMayHaveCommitted(error)) throw new CatalogCreditOutcomeUnknownError();
        throw error;
    } finally {
        await session.endSession();
    }
};

/** Removes one Credit without deleting the subject or owning catalog record. */
export const removeCatalogCredit = async (
    ownerType: CatalogCreditOwnerType,
    rawOwnerId: string,
    creditId: string,
    emptyAttributionStatus: AttributionStatus,
    expectedCreditRevision?: number
) => {
    const ownerId = canonicalOwnerId(rawOwnerId);
    return executeCatalogCreditTransaction(async (session) => {
            const owner: any = await getDb()!.collection(ownerConfig[ownerType].collection).findOne(
                { _id: ObjectId.createFromHexString(ownerId), ...ownerConfig[ownerType].readyFilter },
                { session, projection: { credits: 1 } }
            );
            if (!owner) throw new CatalogCreditConflictError('The Credit owner is unavailable.');
            const existing = Array.isArray(owner.credits) ? normalizeCatalogCredits(owner.credits) : [];
            const retained = existing.filter((credit) => credit.creditId !== creditId);
            return replaceWithinTransaction(
                session,
                ownerType,
                ownerId,
                retained,
                retained.length > 0 ? 'documented' : emptyAttributionStatus,
                expectedCreditRevision
            );
    });
};

/** Reorders the exact current Credit set without accepting additions or omissions. */
export const reorderCatalogCredits = async (
    ownerType: CatalogCreditOwnerType,
    rawOwnerId: string,
    orderedCreditIds: readonly string[],
    expectedCreditRevision?: number
) => {
    const ownerId = canonicalOwnerId(rawOwnerId);
    return executeCatalogCreditTransaction(async (session) => {
            const owner: any = await getDb()!.collection(ownerConfig[ownerType].collection).findOne(
                { _id: ObjectId.createFromHexString(ownerId), ...ownerConfig[ownerType].readyFilter },
                { session, projection: { credits: 1 } }
            );
            if (!owner) throw new CatalogCreditConflictError('The Credit owner is unavailable.');
            const existing = Array.isArray(owner.credits) ? normalizeCatalogCredits(owner.credits) : [];
            const byId = new Map(existing.map((credit) => [credit.creditId, credit]));
            if (orderedCreditIds.length !== existing.length
                || new Set(orderedCreditIds).size !== existing.length
                || orderedCreditIds.some((id) => !byId.has(id))) {
                throw new CatalogCreditValidationError('Reorder must contain every current Credit exactly once.');
            }
            return replaceWithinTransaction(
                session,
                ownerType,
                ownerId,
                orderedCreditIds.map((id) => byId.get(id)!),
                existing.length > 0 ? 'documented' : 'unknown',
                expectedCreditRevision
            );
    });
};
