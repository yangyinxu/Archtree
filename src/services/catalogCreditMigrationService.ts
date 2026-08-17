import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import {
    creditsForLegacyArtistIds,
    migratedCatalogCreditId,
    normalizeCatalogCredits
} from '../models/catalogCredit';
import { replaceCatalogCredits } from './catalogCreditService';
import { readyArtistLifecycleFilter } from './artistReferenceFenceService';
import { readyAlbumLifecycleFilter } from './albumReferenceFenceService';

export interface CatalogCreditMigrationOptions {
    apply?: boolean;
    limit?: number;
    afterAlbumId?: string;
    afterAudioTrackId?: string;
    markUnattributedUnknown?: boolean;
}

export interface CatalogCreditMigrationFinding {
    ownerType: 'album' | 'audioTrack';
    ownerId: string;
    reason: 'missingArtist' | 'unattributedRequiresDecision' | 'migrationFailed';
    subjectId?: string;
    error?: string;
}

const canonicalCheckpoint = (value: string | undefined) => {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return undefined;
    if (!/^[0-9a-f]{24}$/.test(normalized)) throw new Error('Migration checkpoint is invalid.');
    return ObjectId.createFromHexString(normalized);
};

const boundedLimit = (value: number | undefined) => Number.isFinite(value)
    ? Math.max(1, Math.min(Math.floor(value!), 1_000))
    : 100;

/** Performs a bounded, resumable, dry-run-first migration without guessing legacy roles. */
export const migrateCatalogCredits = async (
    options: CatalogCreditMigrationOptions = {}
) => {
    const db = getDb()!;
    const limit = boundedLimit(options.limit);
    const afterAlbumId = canonicalCheckpoint(options.afterAlbumId);
    const afterAudioTrackId = canonicalCheckpoint(options.afterAudioTrackId);
    const [albums, audioTracks] = await Promise.all([
        db.collection('albums').find({
            ...(afterAlbumId ? { _id: { $gt: afterAlbumId } } : {}),
            ...readyAlbumLifecycleFilter
        }).project({ _id: 1, credits: 1, attributionStatus: 1 })
            .sort({ _id: 1 }).limit(limit).toArray(),
        db.collection('audioTracks').find({
            ...(afterAudioTrackId ? { _id: { $gt: afterAudioTrackId } } : {}),
            uploadStatus: { $nin: ['deleting', 'deleteFailed'] }
        }).project({ _id: 1, credits: 1, attributionStatus: 1, artistIds: 1 })
            .sort({ _id: 1 }).limit(limit).toArray()
    ]);
    const albumIds = albums.map((album) => String(album._id));
    const legacyAlbumArtists = albumIds.length > 0
        ? await db.collection('artists').find({
            albumIds: { $in: [
                ...albumIds,
                ...albumIds.map((id) => id.toUpperCase()),
                ...albumIds.map((id) => ObjectId.createFromHexString(id))
            ] },
            ...readyArtistLifecycleFilter
        }).project({ _id: 1, albumIds: 1 }).sort({ _id: 1 }).toArray()
        : [];
    const artistsByAlbumId = new Map<string, string[]>();
    for (const artist of legacyAlbumArtists) {
        const artistId = String(artist._id);
        for (const value of Array.isArray(artist.albumIds) ? artist.albumIds : []) {
            const albumId = String(value ?? '').trim().toLowerCase();
            if (!albumIds.includes(albumId)) continue;
            const artistIds = artistsByAlbumId.get(albumId) ?? [];
            if (!artistIds.includes(artistId)) artistIds.push(artistId);
            artistsByAlbumId.set(albumId, artistIds);
        }
    }
    const referencedArtistIds = [...new Set([
        ...legacyAlbumArtists.map((artist) => String(artist._id)),
        ...audioTracks.flatMap((track) => Array.isArray(track.artistIds)
            ? track.artistIds.map((value: unknown) => String(value ?? '').trim().toLowerCase())
            : [])
    ].filter((id) => /^[0-9a-f]{24}$/.test(id)))];
    const readyArtists = referencedArtistIds.length > 0
        ? await db.collection('artists').find({
            _id: { $in: referencedArtistIds.map((id) => ObjectId.createFromHexString(id)) },
            ...readyArtistLifecycleFilter
        }).project({ _id: 1 }).toArray()
        : [];
    const readyArtistIds = new Set(readyArtists.map((artist) => String(artist._id)));
    const findings: CatalogCreditMigrationFinding[] = [];
    const outcomes: Array<{
        ownerType: 'album' | 'audioTrack';
        ownerId: string;
        action: 'alreadyMigrated' | 'wouldMigrate' | 'migrated' | 'skipped';
        creditCount: number;
    }> = [];

    const processOwner = async (
        ownerType: 'album' | 'audioTrack',
        owner: any,
        artistIds: string[]
    ) => {
        const ownerId = String(owner._id);
        if (Array.isArray(owner.credits) || owner.attributionStatus === 'unknown') {
            outcomes.push({
                ownerType,
                ownerId,
                action: 'alreadyMigrated',
                creditCount: Array.isArray(owner.credits) ? owner.credits.length : 0
            });
            return;
        }
        const invalidArtistId = artistIds.find((artistId) => !readyArtistIds.has(artistId));
        if (invalidArtistId) {
            findings.push({ ownerType, ownerId, reason: 'missingArtist', subjectId: invalidArtistId });
            outcomes.push({ ownerType, ownerId, action: 'skipped', creditCount: 0 });
            return;
        }
        const credits = ownerType === 'album'
            ? normalizeCatalogCredits(artistIds.map((subjectId, order) => ({
                creditId: migratedCatalogCreditId('album', ownerId, 'artist', subjectId, 'primary'),
                subjectType: 'artist',
                subjectId,
                role: 'primary',
                order
            })))
            : creditsForLegacyArtistIds(
                'audioTrack',
                ownerId,
                artistIds,
                'legacyUnspecified'
            );
        if (credits.length === 0 && !options.markUnattributedUnknown) {
            findings.push({ ownerType, ownerId, reason: 'unattributedRequiresDecision' });
            outcomes.push({ ownerType, ownerId, action: 'skipped', creditCount: 0 });
            return;
        }
        if (!options.apply) {
            outcomes.push({ ownerType, ownerId, action: 'wouldMigrate', creditCount: credits.length });
            return;
        }
        try {
            await replaceCatalogCredits(
                ownerType,
                ownerId,
                credits,
                credits.length > 0 ? 'documented' : 'unknown',
                0
            );
            outcomes.push({ ownerType, ownerId, action: 'migrated', creditCount: credits.length });
        } catch (error) {
            findings.push({
                ownerType,
                ownerId,
                reason: 'migrationFailed',
                error: String((error as Error)?.message ?? 'Migration failed.').slice(0, 300)
            });
            outcomes.push({ ownerType, ownerId, action: 'skipped', creditCount: credits.length });
        }
    };

    for (const album of albums) {
        await processOwner('album', album, artistsByAlbumId.get(String(album._id)) ?? []);
    }
    for (const track of audioTracks) {
        const artistIds = [...new Set((Array.isArray(track.artistIds) ? track.artistIds : [])
            .map((value: unknown) => String(value ?? '').trim().toLowerCase())
            .filter(Boolean))] as string[];
        await processOwner('audioTrack', track, artistIds);
    }

    return {
        dryRun: !options.apply,
        limit,
        outcomes,
        findings,
        next: {
            afterAlbumId: albums.length === limit ? String(albums[albums.length - 1]._id) : null,
            afterAudioTrackId: audioTracks.length === limit
                ? String(audioTracks[audioTracks.length - 1]._id)
                : null
        }
    };
};
