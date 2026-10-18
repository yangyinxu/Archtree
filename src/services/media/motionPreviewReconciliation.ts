import { activeMediaObjectKeyForTrack, activeMediaTypeForTrack } from '../../utils/mediaStorageKey';
import {
    isMotionPreviewObjectKeyForTrack,
    isMotionPreviewStorageObjectKey
} from '../../utils/motionPreviewStorageKey';

type ListedObject = { key: string; size: number; lastModified?: Date };
type Phase = 'active' | 'pending' | 'cleanup';

const phases: readonly Phase[] = ['active', 'pending', 'cleanup'];

const referencesFor = (track: any) => phases.flatMap((phase) => {
    const entry = track?.motionPreview?.[phase];
    return entry?.s3Key ? [{
        audioTrackId: String(track._id),
        phase,
        s3Key: String(entry.s3Key),
        status: String(entry.status ?? ''),
        updatedAt: entry.updatedAt ?? null,
        error: String(entry.error ?? '').slice(0, 500)
    }] : [];
});

/**
 * Report-only audit of the motion-preview namespace. Preview objects sit outside every audio and
 * video classifier, so this section is the only place they are matched against their records.
 */
export const reconcileMotionPreviewStorage = (tracks: any[], objects: ListedObject[]) => {
    const references = tracks.flatMap(referencesFor);
    const validReferences = references.filter((reference) => (
        isMotionPreviewObjectKeyForTrack(reference.s3Key, reference.audioTrackId)
    ));
    const invalidStorageKeys = references.filter((reference) => !validReferences.includes(reference));
    const referenceCounts = new Map<string, number>();
    for (const reference of validReferences) {
        referenceCounts.set(reference.s3Key, (referenceCounts.get(reference.s3Key) ?? 0) + 1);
    }
    const duplicateStorageKeys = validReferences.filter((reference) => (referenceCounts.get(reference.s3Key) ?? 0) > 1);
    const objectKeys = new Set(objects.map((object) => object.key));
    const orphanedObjects = objects.filter((object) => !referenceCounts.has(object.key));
    // A pending upload with an unknown outcome may legitimately have no object yet.
    const missingObjects = validReferences.filter((reference) => (
        reference.phase !== 'pending' && !objectKeys.has(reference.s3Key)
    ));
    const incompleteTracks = tracks
        .filter((track) => track?.motionPreview?.pending || track?.motionPreview?.cleanup)
        .map((track) => ({
            audioTrackId: String(track._id),
            pending: track.motionPreview.pending ? {
                status: String(track.motionPreview.pending.status ?? ''),
                outcomeUnknown: track.motionPreview.pending.outcomeUnknown === true,
                leaseUntil: track.motionPreview.pending.leaseUntil ?? null
            } : null,
            cleanup: track.motionPreview.cleanup ? {
                status: String(track.motionPreview.cleanup.status ?? ''),
                reason: String(track.motionPreview.cleanup.reason ?? '')
            } : null
        }));
    // An active preview whose source no longer matches is already hidden; it awaits retirement.
    const staleTracks = tracks
        .filter((track) => track?.motionPreview?.active?.s3Key)
        .filter((track) => track.uploadStatus !== 'ready'
            || activeMediaTypeForTrack(track) !== 'video'
            || track.motionPreview.active.source?.s3Key !== activeMediaObjectKeyForTrack(track))
        .map((track) => ({ audioTrackId: String(track._id), uploadStatus: String(track.uploadStatus ?? '') }));
    const invalidStorageObjects = objects.filter((object) => !isMotionPreviewStorageObjectKey(object.key));

    return {
        summary: {
            databasePreviewTrackCount: tracks.filter((track) => track?.motionPreview?.active).length,
            s3ObjectCount: objects.length,
            orphanedObjectCount: orphanedObjects.length,
            missingObjectCount: missingObjects.length,
            incompleteTrackCount: incompleteTracks.length,
            staleTrackCount: staleTracks.length,
            invalidStorageKeyCount: invalidStorageKeys.length,
            duplicateStorageKeyCount: duplicateStorageKeys.length,
            invalidStorageObjectCount: invalidStorageObjects.length
        },
        orphanedObjects,
        missingObjects,
        incompleteTracks,
        staleTracks,
        invalidStorageKeys,
        duplicateStorageKeys,
        invalidStorageObjects
    };
};
