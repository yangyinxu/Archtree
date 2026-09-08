import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { SimpleDate } from '../models/simpleDate';
import { insertPublishedAlbum } from '../repositories/catalog/albumPublicationRepository';
import { deleteAlbumAndReferences } from '../services/albumLifecycleService';
import {
    AlbumLifecycleStatus,
    AlbumReferenceUnavailableError,
    readyAlbumLifecycleFilter
} from '../services/albumReferenceFenceService';
import { replaceReadyAlbumAudioTracks } from '../services/albumTrackLinkService';
import { withDerivedCoverArtUrl } from '../utils/coverArt';
import { escapeRegex } from '../utils/search';
import type { AttributionStatus, CatalogCredit } from './catalogCredit';
export {
    AlbumCreationOutcomeUnknownError,
    confirmAlbumCreationAfterWriteError
} from '../repositories/catalog/albumPublicationRepository';

/** Catalog Album record with compatibility persistence entry points. */
export class Album {
    _id?: ObjectId;
    title: string;
    coverArtUrl: string;
    coverArtId?: string;
    audioTrackIds: [string];
    releaseDate: SimpleDate;
    createdBy: string;
    lifecycleStatus: AlbumLifecycleStatus;
    lifecycleUpdatedAt: Date;
    lifecycleError: string | null;
    referenceRevision: number;
    credits?: CatalogCredit[];
    attributionStatus?: AttributionStatus;
    creditRevision?: number;

    constructor(
        title: string,
        coverArtUrl: string,
        audioTrackIds: [string],
        releaseDate: SimpleDate,
        createdBy: string,
        id?: ObjectId
    ) {
        if (id) this._id = id;
        this.title = title;
        this.coverArtUrl = coverArtUrl;
        this.audioTrackIds = audioTrackIds;
        this.releaseDate = releaseDate;
        this.createdBy = createdBy;
        this.lifecycleStatus = 'ready';
        this.lifecycleUpdatedAt = new Date();
        this.lifecycleError = null;
        this.referenceRevision = 0;
    }

    /** Compatibility entry point; publication transactions belong to the Catalog repository. */
    async save() {
        return insertPublishedAlbum(this);
    }

    // fetch an album by its id
    static findById(albumId: string) {
        const db = getDb();

        // convert the album id to an ObjectId
        const albumObjectId = ObjectId.createFromHexString(albumId);

        // fetch the album from the database
        return db!
            .collection('albums')
            .find({ _id: albumObjectId })
            .next()
            .then(withDerivedCoverArtUrl);
    }

    /** Resolves only an Album that can still accept new references and mutations. */
    static findReadyById(albumId: string) {
        const albumObjectId = ObjectId.createFromHexString(albumId);
        return getDb()!
            .collection('albums')
            .find({ _id: albumObjectId, ...readyAlbumLifecycleFilter })
            .next()
            .then(withDerivedCoverArtUrl);
    }

    /** Returns a stable global Album page for public reads and admin inventory. */
    static fetchAll(limit: number = 50, offset: number = 0) {
        const db = getDb();

        return db!
            .collection('albums')
            .find()
            .sort({ _id: 1 })
            .skip(offset)
            .limit(limit)
            .toArray()
            .then((albums: any) => {
                return albums.map(withDerivedCoverArtUrl);
            });
    }

    static searchByTitle(query: string, limit: number = 10) {
        const db = getDb();

        return db!
            .collection('albums')
            .find({ title: { $regex: escapeRegex(query), $options: 'i' } })
            .maxTimeMS(3_000)
            .limit(limit)
            .toArray()
            .then((albums) => albums.map(withDerivedCoverArtUrl));
    }

    static fetchByCreator(createdBy: string, limit: number = 50) {
        const db = getDb();

        return db!
            .collection('albums')
            .find({ createdBy })
            .limit(limit)
            .toArray()
            .then((albums) => albums.map(withDerivedCoverArtUrl));
    }

    static updateById(albumId: string, update: Record<string, unknown>) {
        const db = getDb();
        const albumObjectId = ObjectId.createFromHexString(albumId);
        const normalizedUpdate = { ...update };
        const mutate = async (session?: import('mongodb').ClientSession) => {
            const result = await db!
                .collection('albums')
                .updateOne(
                    { _id: albumObjectId, ...readyAlbumLifecycleFilter },
                    { $set: normalizedUpdate },
                    session ? { session } : {}
                );
            if (result.matchedCount !== 1) throw new AlbumReferenceUnavailableError();
            return result;
        };
        if (Object.prototype.hasOwnProperty.call(normalizedUpdate, 'audioTrackIds')) {
            if (!Array.isArray(normalizedUpdate.audioTrackIds)) {
                throw new Error('audioTrackIds must be an array.');
            }
            const audioTrackIds = normalizedUpdate.audioTrackIds;
            delete normalizedUpdate.audioTrackIds;
            return replaceReadyAlbumAudioTracks(albumId, audioTrackIds, normalizedUpdate);
        }
        return mutate();
    }

    /** Attaches/removes artwork only while the caller still owns the observed reference. */
    static updateCoverArtById(
        albumId: string,
        expectedImageId: string | undefined | null,
        update: Record<string, unknown>
    ) {
        const normalizedUpdate = { ...update };
        if (Object.prototype.hasOwnProperty.call(normalizedUpdate, 'audioTrackIds')) {
            if (!Array.isArray(normalizedUpdate.audioTrackIds)) {
                throw new Error('audioTrackIds must be an array.');
            }
            const audioTrackIds = normalizedUpdate.audioTrackIds;
            delete normalizedUpdate.audioTrackIds;
            return replaceReadyAlbumAudioTracks(
                albumId,
                audioTrackIds,
                normalizedUpdate,
                {
                    expectedCoverArtId: expectedImageId,
                    requireExpectedCoverArtMatch: true
                }
            );
        }
        const expectedReference = expectedImageId
            ? { coverArtId: expectedImageId }
            : { $or: [{ coverArtId: null }, { coverArtId: { $exists: false } }] };
        return getDb()!.collection('albums').updateOne(
            {
                _id: ObjectId.createFromHexString(albumId),
                $and: [readyAlbumLifecycleFilter, expectedReference]
            },
            { $set: normalizedUpdate }
        );
    }

    /** Runs the fenced, retryable Album deletion lifecycle. */
    static async deleteById(albumId: string) {
        const result = await deleteAlbumAndReferences(albumId);
        return { ...result, deletedCount: result.deleted ? 1 : 0 };
    }
}
