import { randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { ROOM_AUDIO_ANALYSIS_VERSION, type MediaRepresentation, type RoomAudioRepresentation } from '../models/mediaRepresentation';
import { inspectRoomAudioFile, RoomAudioInspectionError } from './roomAudioInspection';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { activeMediaObjectKeyForTrack, activeMediaTypeForTrack } from '../utils/mediaStorageKey';
import { normalizeUtf8Text } from '../utils/textEncoding';

export const isMediaRepresentationRevision = (value: unknown): value is string => (
    typeof value === 'string' && /^mr_[0-9a-f]{32}$/.test(value)
);

/** Inspects bytes rather than extensions; operational failures are distinct from unsupported audio. */
export const inspectRoomAudioUpload = inspectRoomAudioFile;

/** Generates a fresh identity before upload; validators are attached only after S3 succeeds. */
export const prepareMediaRepresentation = async (
    file: Express.Multer.File,
    objectKey: string,
    mediaType: 'audio' | 'video',
    signal?: AbortSignal
): Promise<MediaRepresentation> => {
    let inspected: Awaited<ReturnType<typeof inspectRoomAudioUpload>> = null;
    let analysisFailure: MediaRepresentation['analysisFailure'];
    try { inspected = mediaType === 'audio' ? await inspectRoomAudioUpload(file, { signal }) : null; }
    catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof RoomAudioInspectionError)) throw error;
        // A missing or busy decoder must not prevent ordinary uploads; explicit analysis can recover later.
        analysisFailure = error.code;
    }
    return {
        revision: `mr_${randomBytes(16).toString('hex')}`,
        objectKey,
        byteLength: file.size,
        durationMs: inspected?.durationMs ?? null,
        seekable: inspected !== null,
        format: inspected?.format ?? 'unsupported',
        etag: null,
        versionId: null,
        analysisVersion: ROOM_AUDIO_ANALYSIS_VERSION,
        ...(analysisFailure ? { analysisFailure } : {})
    };
};

/** Validates private representation evidence before it can pin a storage request. */
export const storedMediaRepresentationForTrack = (track: any): MediaRepresentation | null => {
    const value = track?.mediaRepresentation as MediaRepresentation | undefined;
    if (!value || !isMediaRepresentationRevision(value.revision)
        || value.objectKey !== activeMediaObjectKeyForTrack(track)
        || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0
        || typeof value.etag !== 'string' || !/^"[^"\r\n]{1,200}"$/.test(value.etag)
        || (value.versionId !== null && (typeof value.versionId !== 'string' || !value.versionId
            || value.versionId.length > 1024 || /[\r\n]/.test(value.versionId)))) return null;
    return value;
};

/** Treat storage metadata as untrusted, including historical or manually edited database rows. */
export const roomAudioRepresentationForTrack = (track: any): RoomAudioRepresentation | null => {
    const id = String(track?._id ?? '');
    const value = storedMediaRepresentationForTrack(track);
    if (!/^[0-9a-f]{24}$/.test(id) || track.uploadStatus !== 'ready'
        || (track.publicationStatus != null && track.publicationStatus !== 'ready')
        || activeMediaTypeForTrack(track) !== 'audio' || !value
        || value.seekable !== true || !['wav-pcm', 'mp3', 'm4a-aac'].includes(value.format)
        || value.format !== 'wav-pcm' && value.analysisVersion !== ROOM_AUDIO_ANALYSIS_VERSION
        || !Number.isSafeInteger(value.durationMs) || value.durationMs! <= 0 || value.durationMs! > 86_400_000
        || value.byteLength < 44) return null;
    return {
        mediaTrackId: id,
        title: normalizeUtf8Text(typeof track.title === 'string' ? track.title : '').trim().slice(0, 300) || 'Audio',
        mediaRevision: value.revision,
        durationMs: value.durationMs!,
        streamUrl: `/content/mediaTrack/stream/${id}?revision=${value.revision}`,
        mediaType: 'Audio'
    };
};

/** Reads only the currently published exact representation, optionally in the room transaction. */
export const resolveRoomAudioRepresentation = async (
    mediaTrackId: string,
    session?: ClientSession
): Promise<RoomAudioRepresentation | null> => {
    if (!/^[0-9a-f]{24}$/.test(mediaTrackId)) return null;
    const track = await getDb()!.collection('audioTracks').findOne({
        _id: ObjectId.createFromHexString(mediaTrackId), ...readyAudioStorageFilter
    }, { session });
    return roomAudioRepresentationForTrack(track);
};

/** Writes the same track as replacement/deletion, making room admission serialize with its lifecycle. */
export const touchRoomAudioRepresentation = async (
    mediaTrackId: string,
    expectedRevision: string,
    session: ClientSession
): Promise<RoomAudioRepresentation | null> => {
    if (!/^[0-9a-f]{24}$/.test(mediaTrackId) || !isMediaRepresentationRevision(expectedRevision)) return null;
    const result = await getDb()!.collection('audioTracks').findOneAndUpdate({
        _id: ObjectId.createFromHexString(mediaTrackId),
        ...readyAudioStorageFilter,
        'mediaRepresentation.revision': expectedRevision
    }, { $inc: { contentReferenceRevision: 1 } }, { session, returnDocument: 'after' });
    return roomAudioRepresentationForTrack(result.value);
};
