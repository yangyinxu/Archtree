import { getDb } from '../infrastructure/database';
import { ClientSession, ObjectId } from 'mongodb';
import { SimpleDate } from '../models/simpleDate';
import { withDerivedCoverArtUrl } from '../utils/coverArt';
import { escapeRegex } from '../utils/search';
import {
    ArtistLifecycleStatus,
    ArtistReferenceUnavailableError,
    readyArtistLifecycleFilter,
    withReadyArtistReferences
} from '../services/artistReferenceFenceService';
import { deleteArtistAndReferences } from '../services/artistLifecycleService';
import {
    touchReadyAlbumReferences,
    withReadyAlbumReferences
} from '../services/albumReferenceFenceService';
import { touchActiveAccount } from '../services/accountReferenceFenceService';

const withoutLegacyTrackIds = (artist: any) => {
    if (artist) {
        delete artist.audioTrackIds;
    }
    return withDerivedCoverArtUrl(artist);
};

const artistCreationWriteMayHaveCommitted = (error: any) =>
    error?.hasErrorLabel?.('UnknownTransactionCommitResult') === true
    || [
        'MongoNetworkError',
        'MongoNetworkTimeoutError',
        'MongoPoolClearedError',
        'MongoServerSelectionError',
        'MongoTimeoutError'
    ].includes(String(error?.name ?? ''));

// define the Artist class
export class Artist {
    _id?: ObjectId;
    name: string;
    birthDate: SimpleDate;
    bio: string;
    coverArtUrl: string;
    coverArtId?: string;
    albumIds: [string];
    createdBy: string;
    lifecycleStatus: ArtistLifecycleStatus;
    lifecycleUpdatedAt: Date;
    lifecycleError: string | null;
    referenceRevision: number;

    constructor(
        name: string,  
        birthDate: SimpleDate,
        bio: string,
        coverArtUrl: string,
        albumIds: [string], 
        createdBy: string,
        id?: ObjectId
    ) {
        if (id) this._id = id;
        this.name = name;
        this.birthDate = birthDate;
        this.bio = bio;
        this.coverArtUrl = coverArtUrl;
        this.albumIds = albumIds;
        this.createdBy = createdBy;
        this.lifecycleStatus = 'ready';
        this.lifecycleUpdatedAt = new Date();
        this.lifecycleError = null;
        this.referenceRevision = 0;
    }

    // save an artist to the mongodb database
    async save() {
        const db = getDb();
        try {
            return await withReadyAlbumReferences(
                Array.isArray(this.albumIds) ? this.albumIds : [],
                async (session, albumIds) => {
                    this.albumIds = albumIds as [string];
                    await touchActiveAccount(this.createdBy, session);
                    return db!.collection('artists').insertOne(this, { session });
                }
            );
        } catch (error) {
            return confirmArtistCreationAfterWriteError(this, error);
        }
    }

    // fetch an artist by its id
    static findById(artistId: string) {
        const db = getDb();

        // convert the artist id to an ObjectId
        const artistObjectId = ObjectId.createFromHexString(artistId);

        // fetch the artist from the database
        return db!
            .collection('artists')
            .find({ _id: artistObjectId })
            .next()
            .then(withoutLegacyTrackIds);
    }

    /** Resolves only an Artist that can still accept new references. */
    static findReadyById(artistId: string) {
        const artistObjectId = ObjectId.createFromHexString(artistId);
        return getDb()!
            .collection('artists')
            .find({ _id: artistObjectId, ...readyArtistLifecycleFilter })
            .next()
            .then(withoutLegacyTrackIds);
    }

    /** Returns a stable global Artist page for public reads and admin inventory. */
    static fetchAll(limit: number = 50, offset: number = 0) {
        const db = getDb();

        return db!
            .collection('artists')
            .find()
            .sort({ _id: 1 })
            .skip(offset)
            .limit(limit)
            .toArray()
            .then((artists: any) => {
                return artists.map(withoutLegacyTrackIds);
            });
    }

    static searchByName(query: string, limit: number = 10) {
        const db = getDb();

        return db!
            .collection('artists')
            .find({ name: { $regex: escapeRegex(query), $options: 'i' } })
            .maxTimeMS(3_000)
            .limit(limit)
            .toArray()
            .then((artists) => artists.map(withoutLegacyTrackIds));
    }

    static fetchByCreator(createdBy: string, limit: number = 50) {
        const db = getDb();

        return db!
            .collection('artists')
            .find({ createdBy })
            .limit(limit)
            .toArray()
            .then((artists) => artists.map(withoutLegacyTrackIds));
    }

    static async updateById(artistId: string, update: Record<string, unknown>) {
        const db = getDb();
        const artistObjectId = ObjectId.createFromHexString(artistId);
        const normalizedUpdate = { ...update };
        const mutate = async (session?: ClientSession) => {
            const result = await db!
                .collection('artists')
                .updateOne(
                    { _id: artistObjectId, ...readyArtistLifecycleFilter },
                    { $set: normalizedUpdate },
                    session ? { session } : {}
                );
            if (result.matchedCount !== 1) throw new ArtistReferenceUnavailableError();
            return result;
        };
        if (Object.prototype.hasOwnProperty.call(normalizedUpdate, 'albumIds')) {
            const albumIds = Array.isArray(normalizedUpdate.albumIds)
                ? normalizedUpdate.albumIds
                : [];
            return withReadyArtistReferences([artistId], async (session) => {
                normalizedUpdate.albumIds = await touchReadyAlbumReferences(albumIds, session);
                return mutate(session);
            });
        }
        return mutate();
    }

    /** Attaches/removes artwork only while the caller still owns the observed reference. */
    static updateCoverArtById(
        artistId: string,
        expectedImageId: string | undefined | null,
        update: Record<string, unknown>
    ) {
        const expectedReference = expectedImageId
            ? { coverArtId: expectedImageId }
            : { $or: [{ coverArtId: null }, { coverArtId: { $exists: false } }] };
        return getDb()!.collection('artists').updateOne(
            {
                _id: ObjectId.createFromHexString(artistId),
                $and: [readyArtistLifecycleFilter, expectedReference]
            },
            { $set: update }
        );
    }

    /** Runs the fenced, retryable Artist deletion lifecycle. */
    static async deleteById(artistId: string) {
        const result = await deleteArtistAndReferences(artistId);
        return { ...result, deletedCount: result.deleted ? 1 : 0 };
    }
}

export class ArtistCreationOutcomeUnknownError extends Error {
    readonly statusCode = 503;
    readonly code = 'artist_creation_outcome_unknown';
    readonly cleanupPending = true;
    readonly outcomeUnknown = true;
    readonly cause: unknown;

    constructor(artistId: string, cause: unknown) {
        super(`Artist ${artistId} creation outcome could not be confirmed.`);
        this.cause = cause;
    }
}

/** Recovers a committed insert whose response was lost without publishing a mismatched owner. */
export const confirmArtistCreationAfterWriteError = async (
    artist: Pick<Artist, '_id' | 'name' | 'coverArtId' | 'createdBy'>,
    writeError: unknown,
    findOwner: (artistId: string) => Promise<any | null> = async (artistId) => getDb()!
        .collection('artists')
        .findOne({ _id: ObjectId.createFromHexString(artistId) })
) => {
    const artistId = artist._id?.toHexString();
    if (!artistId) throw writeError;

    let owner: any | null;
    try {
        owner = await findOwner(artistId);
    } catch (confirmationError) {
        throw new ArtistCreationOutcomeUnknownError(artistId, {
            writeError,
            confirmationError
        });
    }
    if (!owner) {
        if (artistCreationWriteMayHaveCommitted(writeError)) {
            throw new ArtistCreationOutcomeUnknownError(artistId, { writeError });
        }
        throw writeError;
    }

    const expectedCoverArtId = String(artist.coverArtId ?? '');
    const actualCoverArtId = String(owner.coverArtId ?? '');
    if (owner.lifecycleStatus === 'ready'
        && String(owner.name ?? '') === artist.name
        && String(owner.createdBy ?? '') === artist.createdBy
        && actualCoverArtId === expectedCoverArtId) {
        return { acknowledged: true, insertedId: artist._id };
    }
    throw new ArtistCreationOutcomeUnknownError(artistId, { writeError });
};
