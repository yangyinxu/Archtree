import { getDb } from '../infrastructure/database';
import { ObjectId } from 'mongodb';
import { SimpleDate } from './simpleDate';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { withDerivedCoverArtUrl } from '../utils/coverArt';
import { escapeRegex } from '../utils/search';
import { withReadyArtistReferences } from '../services/artistReferenceFenceService';
import { touchReadyAlbumReferences } from '../services/albumReferenceFenceService';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { touchActiveAccount } from '../services/accountReferenceFenceService';
import { updateReadyAudioTrackAndAlbum } from '../services/albumTrackLinkService';

const collectionId = 'audioTracks';
export type AudioUploadStatus = 'pending' | 'ready' | 'failed' | 'deleting' | 'deleteFailed';
export type AudioPublicationStatus = 'pending' | 'ready' | 'failed';
export type AudioReferenceCleanupStatus = 'pending' | 'complete' | 'failed';

/** Signals that a Soundtrack has crossed its deletion fence and can no longer be edited. */
export class AudioTrackMutationUnavailableError extends Error {
    readonly statusCode = 409;
    readonly code = 'audio_track_mutation_unavailable';

    constructor() {
        super('The Soundtrack is being deleted or requires deletion reconciliation.');
    }
}

/** Prevents callers from bypassing the canonical two-sided Album relink transaction. */
export class AudioTrackAlbumRelinkRequiredError extends Error {
    readonly statusCode = 409;
    readonly code = 'audio_track_album_relink_required';

    constructor() {
        super('Soundtrack Album changes must use the canonical relink service.');
    }
}

export const normalizeAudioTrackText = (track: any) => {
    if (!track) return track;
    if (typeof track.title === 'string') track.title = normalizeUtf8Text(track.title);
    if (typeof track.originalFileName === 'string') track.originalFileName = normalizeUtf8Text(track.originalFileName);
    return withDerivedCoverArtUrl(track);
};

/** Normalizes mutable text before either a single-record or relationship transaction. */
const normalizedAudioTrackUpdate = (update: Record<string, unknown>) => {
    const normalizedUpdate = { ...update };
    if (typeof normalizedUpdate.title === 'string') {
        normalizedUpdate.title = normalizeUtf8Text(normalizedUpdate.title);
    }
    if (typeof normalizedUpdate.originalFileName === 'string') {
        normalizedUpdate.originalFileName = normalizeUtf8Text(normalizedUpdate.originalFileName);
    }
    return normalizedUpdate;
};

export class AudioTrack {
    _id?: ObjectId;
    title: string;
    artistIds: [string];
    genres: [string];
    albumId: string;
    releaseDate: SimpleDate;
    duration: string;
    format: AudioFormat;
    coverArtUrl: string;
    coverArtId?: string;
    createdBy: string;
    originalFileName?: string;
    contentType?: string;
    s3Key?: string;
    uploadStatus: AudioUploadStatus;
    uploadUpdatedAt: Date;
    uploadError?: string | null;
    publicationStatus: AudioPublicationStatus;
    publicationUpdatedAt: Date;
    publicationError?: string | null;
    pendingS3Key?: string | null;
    pendingUploadStatus?: 'pending' | 'failed' | null;
    pendingUploadUpdatedAt?: Date;
    pendingUploadError?: string | null;
    storageCleanupS3Key?: string | null;
    storageCleanupStatus?: 'pending' | 'deleteFailed' | null;
    storageCleanupUpdatedAt?: Date;
    storageCleanupError?: string | null;
    playlistReferenceRevision: number;
    contentReferenceRevision: number;
    referenceCleanupStatus?: AudioReferenceCleanupStatus;
    referenceCleanupUpdatedAt?: Date;
    referenceCleanupError?: string | null;

    constructor(
        title: string,
        artistIds: [string],
        genres: [string],
        albumId: string,
        releaseDate: SimpleDate,
        duration: string,
        format: AudioFormat,
        coverArtUrl: string,
        createdBy: string,
        originalFileName?: string,
        contentType?: string,
        id?: ObjectId
    ) {
        if (id) this._id = id;
        this.title = normalizeUtf8Text(title);
        this.artistIds = artistIds;
        this.genres = genres;
        this.albumId = albumId;
        this.releaseDate = releaseDate;
        this.duration = duration;
        this.format = format;
        this.coverArtUrl = coverArtUrl;
        this.createdBy = createdBy;
        this.originalFileName = originalFileName ? normalizeUtf8Text(originalFileName) : originalFileName;
        this.contentType = contentType;
        this.s3Key = id?.toHexString();
        this.uploadStatus = 'pending';
        this.uploadUpdatedAt = new Date();
        this.uploadError = null;
        this.publicationStatus = 'pending';
        this.publicationUpdatedAt = new Date();
        this.publicationError = null;
        this.playlistReferenceRevision = 0;
        this.contentReferenceRevision = 0;
    }

    // save an audio track to the mongodb database
    save() {
        const db = getDb();
        return withReadyArtistReferences(this.artistIds, async (session, artistIds) => {
            this.artistIds = artistIds as [string];
            const albumIds = await touchReadyAlbumReferences(
                this.albumId ? [this.albumId] : [],
                session
            );
            this.albumId = albumIds[0] ?? '';
            await touchActiveAccount(this.createdBy, session);
            return db!
                .collection(collectionId)
                .insertOne(this, { session });
        });
    }

    // fetch an audio track by its id
    static findById(audioTrackId: string) {
        const db = getDb();

        // convert the audio track id to an ObjectId
        const audioTrackObjectId = ObjectId.createFromHexString(audioTrackId);

        // fetch the audio track from the database
        return db!
            .collection(collectionId)
            .find({ _id: audioTrackObjectId })
            .next()
            .then(normalizeAudioTrackText);
    }

    /** Resolves only a published, identity-bound ready Soundtrack for public media delivery. */
    static findReadyPublicById(audioTrackId: string) {
        const normalizedAudioTrackId = String(audioTrackId ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{24}$/.test(normalizedAudioTrackId)) return Promise.resolve(null);
        const audioTrackObjectId = ObjectId.createFromHexString(normalizedAudioTrackId);
        return getDb()!
            .collection(collectionId)
            .find({ _id: audioTrackObjectId, ...readyAudioStorageFilter })
            .next()
            .then(normalizeAudioTrackText);
    }

    /** Returns a stable global Soundtrack page, including admin-visible lifecycle states. */
    static fetchAll(limit: number = 50, offset: number = 0) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find()
            .sort({ _id: 1 })
            .skip(offset)
            .limit(limit)
            .toArray()
            .then((audioTracks: any) => {
                return audioTracks.map(normalizeAudioTrackText);
            });
    }

    // Delete an audio track by id
    static deleteById(audioTrackId: string) {
        const db = getDb();

        // convert the audio track id to an ObjectId
        const audioTrackObjectId = ObjectId.createFromHexString(audioTrackId);

        // delete the audio track from the database
        return db!
            .collection(collectionId)
            .deleteOne({ _id: audioTrackObjectId });
    }

    static updateById(audioTrackId: string, update: Record<string, unknown>) {
        const db = getDb();
        const audioTrackObjectId = ObjectId.createFromHexString(audioTrackId);
        const normalizedUpdate = normalizedAudioTrackUpdate(update);
        if (Object.prototype.hasOwnProperty.call(normalizedUpdate, 'albumId')) {
            throw new AudioTrackAlbumRelinkRequiredError();
        }

        const updateReadyTrack = async (session?: import('mongodb').ClientSession) => {
            const result = await db!
                .collection(collectionId)
                .updateOne(
                    {
                        _id: audioTrackObjectId,
                        uploadStatus: { $nin: ['deleting', 'deleteFailed'] }
                    },
                    { $set: normalizedUpdate },
                    session ? { session } : {}
                );
            if (result.matchedCount !== 1) {
                throw new AudioTrackMutationUnavailableError();
            }
            return result;
        };

        const updatesArtistReferences = Object.prototype.hasOwnProperty.call(
            normalizedUpdate,
            'artistIds'
        );
        if (updatesArtistReferences) {
            const artistIds = Array.isArray(normalizedUpdate.artistIds)
                ? normalizedUpdate.artistIds
                : [];
            return withReadyArtistReferences(artistIds, async (session, normalizedArtistIds) => {
                normalizedUpdate.artistIds = normalizedArtistIds;
                return updateReadyTrack(session);
            });
        }

        return updateReadyTrack();
    }

    /** Commits metadata and a published or staged Album move as one relationship mutation. */
    static updateWithAlbumById(
        audioTrackId: string,
        albumId: string,
        update: Record<string, unknown>
    ) {
        return updateReadyAudioTrackAndAlbum(
            audioTrackId,
            albumId,
            normalizedAudioTrackUpdate(update)
        );
    }

    /** Adds an observed-cover CAS to the atomic metadata and Album relationship update. */
    static updateWithAlbumAndCoverArtById(
        audioTrackId: string,
        albumId: string,
        expectedImageId: string | undefined | null,
        update: Record<string, unknown>
    ) {
        return updateReadyAudioTrackAndAlbum(
            audioTrackId,
            albumId,
            normalizedAudioTrackUpdate(update),
            {
                expectedCoverArtId: expectedImageId,
                requireExpectedCoverArtMatch: true
            }
        );
    }

    /** Attaches/removes artwork only before deletion and against the observed reference. */
    static updateCoverArtById(
        audioTrackId: string,
        expectedImageId: string | undefined | null,
        update: Record<string, unknown>
    ) {
        const normalizedUpdate = normalizedAudioTrackUpdate(update);
        const expectedReference = expectedImageId
            ? { coverArtId: expectedImageId }
            : { $or: [{ coverArtId: null }, { coverArtId: { $exists: false } }] };
        const updateTrack = (session?: import('mongodb').ClientSession) => getDb()!
            .collection(collectionId)
            .updateOne(
                {
                    _id: ObjectId.createFromHexString(audioTrackId),
                    uploadStatus: { $nin: ['deleting', 'deleteFailed'] },
                    ...expectedReference
                },
                { $set: normalizedUpdate },
                session ? { session } : {}
            );
        if (Object.prototype.hasOwnProperty.call(normalizedUpdate, 'artistIds')) {
            if (!Array.isArray(normalizedUpdate.artistIds)) {
                throw new Error('artistIds must be an array.');
            }
            return withReadyArtistReferences(
                normalizedUpdate.artistIds,
                async (session, normalizedArtistIds) => {
                    normalizedUpdate.artistIds = normalizedArtistIds;
                    const result = await updateTrack(session);
                    if (result.matchedCount !== 1) {
                        throw new AudioTrackMutationUnavailableError();
                    }
                    return result;
                }
            );
        }
        return updateTrack();
    }

    static searchByTitle(query: string, limit: number = 10) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find({ title: { $regex: escapeRegex(query), $options: 'i' } })
            .maxTimeMS(3_000)
            .limit(limit)
            .toArray()
            .then((audioTracks) => audioTracks.map(normalizeAudioTrackText));
    }

    static fetchByCreator(createdBy: string, limit: number = 50) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find({ createdBy })
            .limit(limit)
            .toArray()
            .then((audioTracks) => audioTracks.map(normalizeAudioTrackText));
    }
}

export class AudioFormat {
    type: string; // e.g., "MP3", "WAV", "FLAC"
    bitrate?: number; // in kbps for audio formats that support bitrates

    constructor(type: string, bitrate?: number) {
        this.type = type;
        if (bitrate !== undefined) {
            this.bitrate = bitrate;
        }
    }

    // convert the format json to a Format object
    static fromJson(json: any) {
        return new AudioFormat(json.type, json.bitrate);
    }

    toString(): string {
        return this.bitrate ? `${this.type} (${this.bitrate} kbps)` : this.type;
    }
}
