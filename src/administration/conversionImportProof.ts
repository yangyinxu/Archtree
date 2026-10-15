import { ObjectId, type ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { activeMediaObjectKeyForTrack, activeMediaTypeForTrack } from '../utils/mediaStorageKey';
import { isAudioObjectKeyForTrack, readyAudioStorageFilter } from '../utils/audioStorageKey';
import { readAdminCatalogRecord, withCurrentAdministrator } from './adminCatalogService';
import { CONVERSION_MAX_BYTES, CONVERSION_MAX_FILES, conversionDigest, conversionEtag, conversionFail, conversionId, conversionOperationId } from './conversionContract';
import { defaultConversionStorage, type ConversionObjectStorage } from './conversionStorage';

export interface ConversionImportReady {
    schemaVersion: 1; projectId: string; publicationOperationId: string | null;
    ready: Array<{ slotId: string; trackId: string; sha256: string; byteLength: number }>;
}
async function capture(actor: string, projectId: string, session: ClientSession) {
    const project = await getDb()!.collection('adminAlbumImports').findOne({ _id: new ObjectId(projectId), purpose: 'import', actorId: actor }, { session, maxTimeMS: 1000 });
    // Legacy imports have no purpose field; absence still means an import, never an existing-catalog review.
    const doc = project ?? await getDb()!.collection('adminAlbumImports').findOne({ _id: new ObjectId(projectId), purpose: { $exists: false }, actorId: actor }, { session, maxTimeMS: 1000 });
    if (!doc) return conversionFail(404, 'ADMIN_CONVERSION_IMPORT_NOT_FOUND');
    const publication = doc.media?.publication;
    if (!publication || publication.state !== 'complete') return { publicationOperationId: null, proofs: [] };
    if (!Array.isArray(publication.tracks) || publication.tracks.length > CONVERSION_MAX_FILES || !conversionId(publication.albumId)
        || !conversionOperationId(publication.operationId)) return conversionFail(409, 'ADMIN_CONVERSION_IMPORT_UNAVAILABLE');
    const album = await readAdminCatalogRecord('album', publication.albumId, session);
    if (!album || !Array.isArray(album.audioTrackIds)) return { publicationOperationId: publication.operationId as string, proofs: [] };
    const ids = publication.tracks.map((track: any) => track.id).filter(conversionId) as string[];
    const records = ids.length ? await getDb()!.collection('audioTracks').find({ _id: { $in: ids.map(id => new ObjectId(id)) },
        albumId: publication.albumId, ...readyAudioStorageFilter }, { session, maxTimeMS: 3000,
        projection: { _id: 1, albumId: 1, mediaType: 1, s3Key: 1, contentType: 1, uploadStatus: 1, publicationStatus: 1, mediaByteHash: 1, mediaRepresentation: 1 }
    }).limit(CONVERSION_MAX_FILES).toArray() : [];
    const byId = new Map(records.map(track => [String(track._id), track]));
    const proofs: Array<{ slotId: string; trackId: string; sha256: string; byteLength: number; key: string; etag: string; versionId: string | null; fingerprint: string }> = [];
    for (const member of publication.tracks) {
        if (!conversionId(member.id) || !conversionOperationId(member.slotId) || !album.audioTrackIds.includes(member.id)) continue;
        // Confirmed stage cleanup retains the approved hash; it does not invalidate the installed canonical bytes.
        const asset = doc.media?.assets?.find((asset: any) => asset.slotId === member.slotId && ['ready', 'deleted'].includes(asset.state));
        const track = byId.get(member.id);
        const hash = track?.mediaByteHash, representation = track?.mediaRepresentation;
        const key = track && activeMediaObjectKeyForTrack(track);
        if (!asset || !track || activeMediaTypeForTrack(track) !== 'audio' || !key || !isAudioObjectKeyForTrack(key, member.id)
            || track.contentType !== 'audio/mpeg' || hash?.algorithm !== 'sha256' || hash.value !== asset.sha256
            || !/^[a-f0-9]{64}$/.test(hash.value) || hash.byteLength !== asset.byteLength || hash.objectKey !== key
            || !Number.isSafeInteger(hash.byteLength) || hash.byteLength <= 0 || hash.byteLength > CONVERSION_MAX_BYTES || !conversionEtag(hash.etag)
            || hash.versionId !== null && (typeof hash.versionId !== 'string' || !hash.versionId || hash.versionId.length > 1024 || /[\r\n]/.test(hash.versionId))
            || hash.etag !== representation?.etag || hash.versionId !== representation?.versionId
            || representation?.objectKey !== key || representation.byteLength !== asset.byteLength) continue;
        proofs.push({ slotId: member.slotId, trackId: member.id, sha256: hash.value, byteLength: hash.byteLength, key,
            etag: hash.etag, versionId: hash.versionId, fingerprint: conversionDigest([key, representation, hash, track.albumId, track.uploadStatus, track.publicationStatus]) });
    }
    return { publicationOperationId: publication.operationId as string, proofs };
}

/** A staged object alone is not disposal proof: the same bytes must be the currently published canonical MP3. */
export async function getConversionImportReady(actor: string, projectId: string, storage: ConversionObjectStorage = defaultConversionStorage,
    selectedSlots?: readonly string[]): Promise<ConversionImportReady> {
    if (!conversionId(projectId)) return conversionFail(400, 'ADMIN_CONVERSION_INVALID_INPUT');
    if (selectedSlots && (selectedSlots.length > CONVERSION_MAX_FILES || selectedSlots.some(slot => !conversionOperationId(slot))
        || new Set(selectedSlots).size !== selectedSlots.length)) return conversionFail(400, 'ADMIN_CONVERSION_INVALID_INPUT');
    const snapshot = await withCurrentAdministrator(actor, session => capture(actor, projectId, session));
    const bucket = String(process.env.S3_BUCKET_NAME ?? '').trim(), verified = new Set<string>();
    if (!bucket && snapshot.proofs.length) return conversionFail(503, 'ADMIN_CONVERSION_STORAGE_UNAVAILABLE');
    // Bounded sequential HEADs avoid buffering an Album or overwhelming S3/concurrency on one proof read.
    const deadline = Date.now() + 10_000;
    for (const proof of snapshot.proofs.filter(proof => !selectedSlots || selectedSlots.includes(proof.slotId))) {
        if (Date.now() >= deadline) break;
        try {
            const identity = await storage.head({ bucket, key: proof.key });
            if (identity?.etag === proof.etag && identity.versionId === proof.versionId && identity.byteLength === proof.byteLength
                && identity.contentType === 'audio/mpeg' && identity.sha256 === proof.sha256) verified.add(proof.fingerprint);
        } catch { /* Unknown storage never grants permission to remove a local result. */ }
    }
    return withCurrentAdministrator(actor, async session => {
        const current = await capture(actor, projectId, session);
        return { schemaVersion: 1, projectId, publicationOperationId: current.publicationOperationId,
            ready: current.publicationOperationId !== snapshot.publicationOperationId ? [] : current.proofs.filter(proof => verified.has(proof.fingerprint))
                .map(({ slotId, trackId, sha256, byteLength }) => ({ slotId, trackId, sha256, byteLength })) };
    });
}
