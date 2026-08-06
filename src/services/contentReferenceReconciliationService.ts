import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';

const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** Normalizes a stored relationship ID only when it can address a Mongo ObjectId. */
const canonicalObjectId = (value: unknown) => {
    const id = String(value ?? '');
    if (!/^[0-9a-fA-F]{24}$/.test(id)) return undefined;
    return ObjectId.createFromHexString(id).toHexString();
};

const supportedReceiptOperations = new Set([
    'create',
    'playlist.create',
    'playlist.rename',
    'playlist.delete',
    'playlist.item.add',
    'playlist.item.remove',
    'playlist.item.reorder'
]);

export const reconcileContentReferences = async () => {
    const db = getDb()!;
    const limit = positiveInteger(process.env.MAX_RECONCILIATION_OBJECTS, 50_000);
    const referenceLimit = positiveInteger(
        process.env.MAX_RECONCILIATION_REFERENCES,
        50_000
    );
    const [
        albums,
        tracks,
        artists,
        carousels,
        contentCollections,
        pages,
        saves,
        activities,
        users,
        playlists,
        accountMutations
    ] = await Promise.all([
        db.collection('albums').find().project({ _id: 1, lifecycleStatus: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('audioTracks').find().project({
            albumId: 1,
            uploadStatus: 1,
            publicationStatus: 1,
            referenceCleanupStatus: 1,
            referenceCleanupUpdatedAt: 1
        }).sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('artists').find().project({ _id: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('carousels').find().project({ mode: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('contentCollections').find().project({ mode: 1, presentation: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('pages').find().project({ slug: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('userSaves').find().project({ userId: 1, contentType: 1, contentId: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('userActivity').find().project({ userId: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('users').find().project({ _id: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('playlists').find().project({ ownerUserId: 1 })
            .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray(),
        db.collection('accountMutations').find().project({
            ownerUserId: 1,
            operation: 1,
            targetId: 1,
            status: 1,
            'response.playlistId': 1,
            'response.kind': 1,
            'response.statusCode': 1
        }).sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10_000).toArray()
    ]);
    const sourceCollectionsTruncated = [
        albums,
        tracks,
        artists,
        carousels,
        contentCollections,
        pages,
        saves,
        activities,
        users,
        playlists,
        accountMutations
    ].some((items) => items.length > limit);
    const scannedTracks = tracks.slice(0, limit);
    const scannedAlbums = albums.slice(0, limit);
    const scannedArtists = artists.slice(0, limit);
    const scannedCarousels = carousels.slice(0, limit);
    const scannedContentCollections = contentCollections.slice(0, limit);
    const scannedPages = pages.slice(0, limit);
    const scannedSaves = saves.slice(0, limit);
    const scannedActivities = activities.slice(0, limit);
    const scannedPlaylists = playlists.slice(0, limit);
    const scannedAccountMutations = accountMutations.slice(0, limit);
    const albumSet = new Set(scannedAlbums.map((item) => String(item._id)));
    const trackSet = new Set(scannedTracks.map((item) => String(item._id)));
    const artistSet = new Set(scannedArtists.map((item) => String(item._id)));
    const carouselSet = new Set(scannedCarousels.map((item) => String(item._id)));
    const contentCollectionsById = new Map(scannedContentCollections.map((item) => [
        String(item._id),
        item
    ] as const));
    const userSet = new Set(users.slice(0, limit).map((item) => String(item._id)));
    const playlistsById = new Map(scannedPlaylists.map((playlist) => [
        String(playlist._id),
        playlist
    ]));
    let embeddedReferencesRemaining = referenceLimit;
    let embeddedReferencesTruncated = false;
    const loadEmbeddedReferences = async (collectionName: string, field: string) => {
        const requested = embeddedReferencesRemaining > 0
            ? embeddedReferencesRemaining + 1
            : 1;
        const rows = await db.collection(collectionName).aggregate([
            { $sort: { _id: 1 } },
            { $limit: limit },
            {
                $project: {
                    reference: {
                        $cond: [
                            { $isArray: `$${field}` },
                            `$${field}`,
                            []
                        ]
                    }
                }
            },
            { $unwind: '$reference' },
            { $limit: requested }
        ], { maxTimeMS: 10_000 }).toArray();
        if (embeddedReferencesRemaining <= 0) {
            if (rows.length > 0) embeddedReferencesTruncated = true;
            return new Map<string, any[]>();
        }
        if (rows.length > embeddedReferencesRemaining) {
            embeddedReferencesTruncated = true;
        }
        const accepted = rows.slice(0, embeddedReferencesRemaining);
        embeddedReferencesRemaining -= accepted.length;
        const referencesBySource = new Map<string, any[]>();
        for (const row of accepted) {
            const sourceId = String(row._id);
            const references = referencesBySource.get(sourceId) ?? [];
            references.push(row.reference);
            referencesBySource.set(sourceId, references);
        }
        return referencesBySource;
    };
    const albumTrackReferences = await loadEmbeddedReferences('albums', 'audioTrackIds');
    const albumTrackReferencesComplete = !embeddedReferencesTruncated;
    const trackArtistReferences = await loadEmbeddedReferences('audioTracks', 'artistIds');
    const artistAlbumReferences = await loadEmbeddedReferences('artists', 'albumIds');
    const carouselItemReferences = await loadEmbeddedReferences('carousels', 'items');
    const collectionItemReferences = await loadEmbeddedReferences('contentCollections', 'items');
    const pageItemReferences = await loadEmbeddedReferences('pages', 'items');
    const recentlySavedReferences = await loadEmbeddedReferences('userActivity', 'recentlySaved');
    const recentlyPlayedReferences = await loadEmbeddedReferences('userActivity', 'recentlyPlayed');
    const playlistItemReferences = await loadEmbeddedReferences('playlists', 'items');
    const referencesFor = (references: Map<string, any[]>, sourceId: unknown) =>
        references.get(String(sourceId)) ?? [];
    const playlistOwnerLookupIds = new Set<string>();
    const playlistTrackLookupIds = new Set<string>();
    const playlistTargetLookupIds = new Set<string>();
    const ownerReferenceLookupLimit = limit + 1;
    const playlistReferenceLookupLimit = limit + 1;
    const catalogReferenceLookupLimit = limit + 1;
    const pageTargetLookupLimit = limit + 1;
    let ownerReferenceLookupTruncated = false;
    let playlistReferenceLookupTruncated = false;
    let playlistTargetLookupTruncated = false;
    let catalogReferenceFindingsTruncated = false;
    let pageTargetLookupTruncated = false;
    const trackArtistLookupIds = new Set<string>();
    const albumReferenceLookupIds = new Set<string>();
    const trackReferenceLookupIds = new Set<string>();
    const pageCarouselLookupIds = new Set<string>();
    const pageCollectionLookupIds = new Set<string>();
    const queueCatalogReferenceLookup = (
        value: unknown,
        knownIds: Set<string>,
        lookupIds: Set<string>
    ) => {
        const id = canonicalObjectId(value);
        if (!id || knownIds.has(id) || lookupIds.has(id)) return;
        if (lookupIds.size >= catalogReferenceLookupLimit) {
            catalogReferenceFindingsTruncated = true;
            return;
        }
        lookupIds.add(id);
    };
    for (const track of scannedTracks) {
        for (const artistId of referencesFor(trackArtistReferences, track._id)) {
            queueCatalogReferenceLookup(artistId, artistSet, trackArtistLookupIds);
        }
        if (track.albumId) {
            queueCatalogReferenceLookup(track.albumId, albumSet, albumReferenceLookupIds);
        }
    }
    for (const album of scannedAlbums) {
        for (const audioTrackId of referencesFor(albumTrackReferences, album._id)) {
            queueCatalogReferenceLookup(audioTrackId, trackSet, trackReferenceLookupIds);
        }
    }
    for (const artist of scannedArtists) {
        for (const albumId of referencesFor(artistAlbumReferences, artist._id)) {
            queueCatalogReferenceLookup(albumId, albumSet, albumReferenceLookupIds);
        }
    }
    const queueTypedContentReference = (contentType: unknown, contentId: unknown) => {
        if (contentType === 'album') {
            queueCatalogReferenceLookup(contentId, albumSet, albumReferenceLookupIds);
        } else if (contentType === 'audioTrack') {
            queueCatalogReferenceLookup(contentId, trackSet, trackReferenceLookupIds);
        }
    };
    for (const save of scannedSaves) {
        queueTypedContentReference(save.contentType, save.contentId);
    }
    for (const activity of scannedActivities) {
        for (const source of ['recentlySaved', 'recentlyPlayed']) {
            const references = source === 'recentlySaved'
                ? recentlySavedReferences
                : recentlyPlayedReferences;
            for (const entry of referencesFor(references, activity._id)) {
                queueTypedContentReference(entry?.contentType, entry?.contentId);
            }
        }
    }
    for (const carousel of scannedCarousels.filter(item => item.mode === 'manual' || !item.mode)) {
        for (const item of referencesFor(carouselItemReferences, carousel._id)) {
            queueTypedContentReference(item?.contentType, item?.contentId);
        }
    }
    for (const collection of scannedContentCollections.filter(item => item.mode === 'manual')) {
        for (const item of referencesFor(collectionItemReferences, collection._id)) {
            queueTypedContentReference(item?.contentType, item?.contentId);
        }
    }
    const queuePageTargetLookup = (
        value: unknown,
        knownIds: Set<string>,
        lookupIds: Set<string>
    ) => {
        const id = canonicalObjectId(value);
        if (!id || knownIds.has(id) || lookupIds.has(id)) return;
        if (lookupIds.size >= pageTargetLookupLimit) {
            pageTargetLookupTruncated = true;
            return;
        }
        lookupIds.add(id);
    };
    const knownCollectionIds = new Set(contentCollectionsById.keys());
    for (const page of scannedPages) {
        for (const item of referencesFor(pageItemReferences, page._id)) {
            if (item?.itemType === 'carousel') {
                queuePageTargetLookup(item.carouselId, carouselSet, pageCarouselLookupIds);
            } else if (item?.itemType === 'grid' || item?.itemType === 'list') {
                queuePageTargetLookup(
                    item.collectionId,
                    knownCollectionIds,
                    pageCollectionLookupIds
                );
            }
        }
    }
    const queueOwnerLookup = (value: unknown) => {
        const ownerUserId = canonicalObjectId(value);
        if (!ownerUserId || userSet.has(ownerUserId) || playlistOwnerLookupIds.has(ownerUserId)) {
            return;
        }
        if (playlistOwnerLookupIds.size >= ownerReferenceLookupLimit) {
            ownerReferenceLookupTruncated = true;
            return;
        }
        playlistOwnerLookupIds.add(ownerUserId);
    };
    for (const playlist of scannedPlaylists) {
        queueOwnerLookup(playlist.ownerUserId);
        for (const item of referencesFor(playlistItemReferences, playlist._id)) {
            const audioTrackId = canonicalObjectId(item?.audioTrackId);
            if (!audioTrackId
                || trackSet.has(audioTrackId)
                || playlistTrackLookupIds.has(audioTrackId)) {
                continue;
            }
            if (playlistTrackLookupIds.size >= playlistReferenceLookupLimit) {
                playlistReferenceLookupTruncated = true;
                continue;
            }
            playlistTrackLookupIds.add(audioTrackId);
        }
    }
    for (const mutation of scannedAccountMutations) {
        queueOwnerLookup(mutation.ownerUserId);
        const targetIds = [mutation.targetId, mutation.response?.playlistId];
        for (const targetValue of targetIds) {
            const targetId = canonicalObjectId(targetValue);
            if (!targetId || playlistsById.has(targetId) || playlistTargetLookupIds.has(targetId)) {
                continue;
            }
            if (playlistTargetLookupIds.size >= playlistReferenceLookupLimit) {
                playlistTargetLookupTruncated = true;
                continue;
            }
            playlistTargetLookupIds.add(targetId);
        }
    }
    const ownerLookupObjectIds = [...playlistOwnerLookupIds].map(id => new ObjectId(id));
    const trackLookupObjectIds = [...playlistTrackLookupIds].map(id => new ObjectId(id));
    const artistLookupObjectIds = [...trackArtistLookupIds].map(id => new ObjectId(id));
    const albumReferenceLookupObjectIds = [...albumReferenceLookupIds].map(id => new ObjectId(id));
    const trackReferenceLookupObjectIds = [...trackReferenceLookupIds].map(id => new ObjectId(id));
    const playlistTargetLookupObjectIds = [...playlistTargetLookupIds].map(id => new ObjectId(id));
    const pageCarouselLookupObjectIds = [...pageCarouselLookupIds].map(id => new ObjectId(id));
    const pageCollectionLookupObjectIds = [...pageCollectionLookupIds].map(id => new ObjectId(id));
    const [
        additionalOwners,
        additionalTracks,
        additionalArtists,
        additionalAlbums,
        additionalCatalogTracks,
        additionalTargetPlaylists,
        additionalPageCarousels,
        additionalPageCollections
    ] = await Promise.all([
        ownerLookupObjectIds.length === 0
            ? []
            : db.collection('users')
                .find({ _id: { $in: ownerLookupObjectIds } })
                .project({ _id: 1 })
                .limit(ownerLookupObjectIds.length)
                .maxTimeMS(10_000)
                .toArray(),
        trackLookupObjectIds.length === 0
            ? []
            : db.collection('audioTracks')
                .find({ _id: { $in: trackLookupObjectIds } })
                .project({ _id: 1 })
                .limit(trackLookupObjectIds.length)
                .maxTimeMS(10_000)
                .toArray(),
        artistLookupObjectIds.length === 0
            ? []
            : db.collection('artists')
                .find({ _id: { $in: artistLookupObjectIds } })
                .project({ _id: 1 })
                .limit(artistLookupObjectIds.length)
                .maxTimeMS(10_000)
                .toArray(),
        albumReferenceLookupObjectIds.length === 0
            ? []
            : db.collection('albums')
                .find({ _id: { $in: albumReferenceLookupObjectIds } })
                .project({ _id: 1 })
                .limit(albumReferenceLookupObjectIds.length)
                .maxTimeMS(10_000)
                .toArray(),
        trackReferenceLookupObjectIds.length === 0
            ? []
            : db.collection('audioTracks')
                .find({ _id: { $in: trackReferenceLookupObjectIds } })
                .project({
                    _id: 1,
                    albumId: 1,
                    uploadStatus: 1,
                    publicationStatus: 1
                })
                .limit(trackReferenceLookupObjectIds.length)
                .maxTimeMS(10_000)
                .toArray(),
        playlistTargetLookupObjectIds.length === 0
            ? []
            : db.collection('playlists')
                .find({ _id: { $in: playlistTargetLookupObjectIds } })
                .project({ _id: 1, ownerUserId: 1 })
                .limit(playlistTargetLookupObjectIds.length)
                .maxTimeMS(10_000)
                .toArray(),
        pageCarouselLookupObjectIds.length === 0
            ? []
            : db.collection('carousels')
                .find({ _id: { $in: pageCarouselLookupObjectIds } })
                .project({ _id: 1 })
                .limit(pageCarouselLookupObjectIds.length)
                .maxTimeMS(10_000)
                .toArray(),
        pageCollectionLookupObjectIds.length === 0
            ? []
            : db.collection('contentCollections')
                .find({ _id: { $in: pageCollectionLookupObjectIds } })
                .project({ _id: 1, presentation: 1 })
                .limit(pageCollectionLookupObjectIds.length)
                .maxTimeMS(10_000)
                .toArray()
    ]);
    const additionalOwnerSet = new Set(additionalOwners.map(item => String(item._id)));
    const additionalTrackSet = new Set(additionalTracks.map(item => String(item._id)));
    const additionalArtistSet = new Set(additionalArtists.map(item => String(item._id)));
    const additionalAlbumSet = new Set(
        additionalAlbums.map(item => String(item._id))
    );
    const additionalCatalogTrackSet = new Set(
        additionalCatalogTracks.map(item => String(item._id))
    );
    const additionalPageCarouselSet = new Set(
        additionalPageCarousels.map(item => String(item._id))
    );
    for (const collection of additionalPageCollections) {
        contentCollectionsById.set(String(collection._id), collection);
    }
    const catalogTracksById = new Map(
        [...scannedTracks, ...additionalCatalogTracks]
            .map((track) => [String(track._id), track] as const)
    );
    const albumsById = new Map(
        scannedAlbums.map((album) => [String(album._id), album] as const)
    );
    for (const playlist of additionalTargetPlaylists) {
        playlistsById.set(String(playlist._id), playlist);
    }
    const playlistOwnerExists = (value: unknown): boolean | undefined => {
        const id = canonicalObjectId(value);
        if (!id) return false;
        if (userSet.has(id) || additionalOwnerSet.has(id)) return true;
        return playlistOwnerLookupIds.has(id) ? false : undefined;
    };
    const playlistTrackExists = (value: unknown): boolean | undefined => {
        const id = canonicalObjectId(value);
        if (!id) return false;
        if (trackSet.has(id) || additionalTrackSet.has(id)) return true;
        return playlistTrackLookupIds.has(id) ? false : undefined;
    };
    const trackArtistExists = (value: unknown): boolean | undefined => {
        const id = canonicalObjectId(value);
        if (!id) return false;
        if (artistSet.has(id) || additionalArtistSet.has(id)) return true;
        return trackArtistLookupIds.has(id) ? false : undefined;
    };
    const catalogContentExists = (type: string, value: unknown): boolean | undefined => {
        const id = canonicalObjectId(value);
        if (!id) return false;
        if (type === 'album') {
            if (albumSet.has(id) || additionalAlbumSet.has(id)) return true;
            return albumReferenceLookupIds.has(id) ? false : undefined;
        }
        if (type === 'audioTrack') {
            if (trackSet.has(id) || additionalCatalogTrackSet.has(id)) return true;
            return trackReferenceLookupIds.has(id) ? false : undefined;
        }
        return false;
    };
    const pageCarouselExists = (value: unknown): boolean | undefined => {
        const id = canonicalObjectId(value);
        if (!id) return false;
        if (carouselSet.has(id) || additionalPageCarouselSet.has(id)) return true;
        return pageCarouselLookupIds.has(id) ? false : undefined;
    };
    const pageCollectionState = (value: unknown): {
        exists: boolean;
        presentation?: unknown;
    } | undefined => {
        const id = canonicalObjectId(value);
        if (!id) return { exists: false };
        const collection = contentCollectionsById.get(id);
        if (collection) return { exists: true, presentation: collection.presentation };
        return pageCollectionLookupIds.has(id) ? { exists: false } : undefined;
    };
    let findingsRemaining = referenceLimit;
    const appendFinding = <T>(items: T[], finding: T) => {
        if (findingsRemaining <= 0) {
            catalogReferenceFindingsTruncated = true;
            return false;
        }
        items.push(finding);
        findingsRemaining -= 1;
        return true;
    };
    const markUnknownCatalogReference = () => {
        catalogReferenceFindingsTruncated = true;
    };

    const danglingSaves: any[] = [];
    for (const item of scannedSaves) {
        const contentExists = catalogContentExists(String(item.contentType), item.contentId);
        if (contentExists) continue;
        if (contentExists === undefined) {
            markUnknownCatalogReference();
            continue;
        }
        appendFinding(danglingSaves, item);
    }
    const danglingActivity: any[] = [];
    for (const activity of scannedActivities) {
        for (const source of ['recentlySaved', 'recentlyPlayed']) {
            const references = source === 'recentlySaved'
                ? recentlySavedReferences
                : recentlyPlayedReferences;
            for (const entry of referencesFor(references, activity._id)) {
                const contentExists = catalogContentExists(String(entry?.contentType), entry?.contentId);
                if (contentExists) continue;
                if (contentExists === undefined) {
                    markUnknownCatalogReference();
                    continue;
                }
                appendFinding(danglingActivity, {
                    userId: activity.userId,
                    source,
                    contentType: entry?.contentType,
                    contentId: entry?.contentId
                });
            }
        }
    }
    const danglingCarouselItems: any[] = [];
    for (const carousel of scannedCarousels.filter((item) => item.mode === 'manual' || !item.mode)) {
        for (const item of referencesFor(carouselItemReferences, carousel._id)) {
            const contentExists = catalogContentExists(String(item?.contentType), item?.contentId);
            if (contentExists) continue;
            if (contentExists === undefined) {
                markUnknownCatalogReference();
                continue;
            }
            appendFinding(danglingCarouselItems, {
                carouselId: String(carousel._id),
                contentType: item?.contentType,
                contentId: item?.contentId
            });
        }
    }
    const danglingArtistAlbums: Array<{ artistId: string; albumId: string }> = [];
    for (const artist of scannedArtists) {
        for (const albumId of referencesFor(artistAlbumReferences, artist._id)) {
            const albumExists = catalogContentExists('album', albumId);
            if (albumExists) continue;
            if (albumExists === undefined) {
                markUnknownCatalogReference();
                continue;
            }
            appendFinding(danglingArtistAlbums, {
                artistId: String(artist._id),
                albumId: String(albumId)
            });
        }
    }
    const danglingAlbumTracks: Array<{ albumId: string; audioTrackId: string }> = [];
    const staleAlbumTrackMemberships: Array<{
        albumId: string;
        audioTrackId: string;
        trackAlbumId: string;
    }> = [];
    for (const album of scannedAlbums) {
        for (const audioTrackId of referencesFor(albumTrackReferences, album._id)) {
            const trackExists = catalogContentExists('audioTrack', audioTrackId);
            if (trackExists) {
                const canonicalTrackId = canonicalObjectId(audioTrackId);
                const track = canonicalTrackId
                    ? catalogTracksById.get(canonicalTrackId)
                    : undefined;
                if (!track) {
                    markUnknownCatalogReference();
                    continue;
                }
                const trackAlbumId = canonicalObjectId(track.albumId) ?? '';
                if (trackAlbumId !== String(album._id)) {
                    appendFinding(staleAlbumTrackMemberships, {
                        albumId: String(album._id),
                        audioTrackId: canonicalTrackId!,
                        trackAlbumId
                    });
                }
                continue;
            }
            if (trackExists === undefined) {
                markUnknownCatalogReference();
                continue;
            }
            appendFinding(danglingAlbumTracks, {
                albumId: String(album._id),
                audioTrackId: String(audioTrackId)
            });
        }
    }
    const danglingTrackAlbums: Array<{ audioTrackId: string; albumId: string }> = [];
    for (const track of scannedTracks) {
        if (!track.albumId) continue;
        const albumExists = catalogContentExists('album', track.albumId);
        if (albumExists) continue;
        if (albumExists === undefined) {
            markUnknownCatalogReference();
            continue;
        }
        appendFinding(danglingTrackAlbums, {
            audioTrackId: String(track._id),
            albumId: String(track.albumId)
        });
    }
    const missingAlbumTrackMemberships: Array<{
        audioTrackId: string;
        albumId: string;
    }> = [];
    if (albumTrackReferencesComplete) {
        for (const track of scannedTracks) {
            const audioTrackId = canonicalObjectId(track._id);
            const albumId = canonicalObjectId(track.albumId);
            const hasPublicationStatus = Object.prototype.hasOwnProperty.call(
                track,
                'publicationStatus'
            );
            const isPublished = !hasPublicationStatus || track.publicationStatus === 'ready';
            if (!audioTrackId || !albumId || track.uploadStatus !== 'ready' || !isPublished
                || !albumSet.has(albumId)) {
                continue;
            }
            const canonicalMembers = referencesFor(albumTrackReferences, albumId)
                .map(canonicalObjectId)
                .filter((id): id is string => Boolean(id));
            const album = albumsById.get(albumId);
            const isTrueLegacyFallback = album?.lifecycleStatus === undefined
                && canonicalMembers.length === 0;
            if (isTrueLegacyFallback || canonicalMembers.includes(audioTrackId)) continue;
            appendFinding(missingAlbumTrackMemberships, { audioTrackId, albumId });
        }
    }
    const danglingTrackArtists: Array<{ audioTrackId: string; artistId: string }> = [];
    for (const track of scannedTracks) {
        const artistIds = [...new Set(
            referencesFor(trackArtistReferences, track._id).map(String)
        )];
        for (const artistId of artistIds) {
            const artistExists = trackArtistExists(artistId);
            if (artistExists) continue;
            if (artistExists === undefined) {
                catalogReferenceFindingsTruncated = true;
                continue;
            }
            appendFinding(danglingTrackArtists, {
                audioTrackId: String(track._id),
                artistId
            });
        }
    }
    const danglingContentCollectionItems: Array<{
        contentCollectionId: string;
        contentType: string;
        contentId: string;
        order: number | null;
    }> = [];
    for (const collection of scannedContentCollections.filter(item => item.mode === 'manual')) {
        for (const item of referencesFor(collectionItemReferences, collection._id)) {
            const contentExists = catalogContentExists(item?.contentType, item?.contentId);
            if (contentExists) continue;
            if (contentExists === undefined) {
                catalogReferenceFindingsTruncated = true;
                continue;
            }
            appendFinding(danglingContentCollectionItems, {
                contentCollectionId: String(collection._id),
                contentType: String(item?.contentType ?? ''),
                contentId: String(item?.contentId ?? ''),
                order: Number.isInteger(item?.order) ? item.order : null
            });
        }
    }
    const danglingPageCarouselReferences: Array<{
        pageId: string;
        slug: string;
        carouselId: string;
        order: number | null;
        reason: 'missing' | 'malformed';
    }> = [];
    const danglingPageContentCollectionReferences: Array<{
        pageId: string;
        slug: string;
        itemType: 'grid' | 'list';
        contentCollectionId: string;
        order: number | null;
        reason: 'missing' | 'malformed' | 'presentationMismatch';
    }> = [];
    for (const page of scannedPages) {
        for (const item of referencesFor(pageItemReferences, page._id)) {
            if (item?.itemType === 'carousel') {
                const exists = pageCarouselExists(item.carouselId);
                if (exists) continue;
                if (exists === undefined) {
                    pageTargetLookupTruncated = true;
                    continue;
                }
                appendFinding(danglingPageCarouselReferences, {
                    pageId: String(page._id),
                    slug: String(page.slug ?? ''),
                    carouselId: String(item.carouselId ?? ''),
                    order: Number.isInteger(item.order) ? item.order : null,
                    reason: canonicalObjectId(item.carouselId) ? 'missing' : 'malformed'
                });
                continue;
            }
            if (item?.itemType !== 'grid' && item?.itemType !== 'list') continue;
            const state = pageCollectionState(item.collectionId);
            if (state === undefined) {
                pageTargetLookupTruncated = true;
                continue;
            }
            const reason = !canonicalObjectId(item.collectionId)
                ? 'malformed'
                : !state.exists
                    ? 'missing'
                    : state.presentation !== item.itemType
                        ? 'presentationMismatch'
                        : undefined;
            if (!reason) continue;
            appendFinding(danglingPageContentCollectionReferences, {
                pageId: String(page._id),
                slug: String(page.slug ?? ''),
                itemType: item.itemType,
                contentCollectionId: String(item.collectionId ?? ''),
                order: Number.isInteger(item.order) ? item.order : null,
                reason
            });
        }
    }
    const missingPlaylistOwners: Array<{ playlistId: string; ownerUserId: string }> = [];
    let playlistFindingsTruncated = playlistReferenceLookupTruncated
        || ownerReferenceLookupTruncated
        || playlistTargetLookupTruncated;
    for (const playlist of scannedPlaylists) {
        const ownerExists = playlistOwnerExists(playlist.ownerUserId);
        if (ownerExists) continue;
        if (ownerExists === undefined) {
            playlistFindingsTruncated = true;
            continue;
        }
        appendFinding(missingPlaylistOwners, {
            playlistId: String(playlist._id),
            ownerUserId: String(playlist.ownerUserId ?? '')
        });
    }
    const danglingPlaylistItems: Array<{
        playlistId: string;
        itemId: string;
        audioTrackId: string;
    }> = [];
    for (const playlist of scannedPlaylists) {
        for (const item of referencesFor(playlistItemReferences, playlist._id)) {
            const audioTrackId = String(item?.audioTrackId ?? '');
            const trackExists = playlistTrackExists(audioTrackId);
            if (trackExists) continue;
            if (trackExists === undefined) {
                playlistFindingsTruncated = true;
                continue;
            }
            appendFinding(danglingPlaylistItems, {
                playlistId: String(playlist._id),
                itemId: String(item?.itemId ?? ''),
                audioTrackId
            });
        }
    }
    const stalledAudioTrackReferenceCleanup: Array<{
        audioTrackId: string;
        uploadStatus: string;
        referenceCleanupStatus: string;
        referenceCleanupUpdatedAt: unknown;
    }> = [];
    for (const track of scannedTracks) {
        if ((track.uploadStatus !== 'deleting' && track.uploadStatus !== 'deleteFailed')
            || track.referenceCleanupStatus === 'complete') continue;
        appendFinding(stalledAudioTrackReferenceCleanup, {
            audioTrackId: String(track._id),
            uploadStatus: String(track.uploadStatus),
            referenceCleanupStatus: String(track.referenceCleanupStatus ?? 'pending'),
            referenceCleanupUpdatedAt: track.referenceCleanupUpdatedAt ?? null
        });
    }
    const invalidAccountMutationOwners: Array<{ mutationId: string; ownerUserId: string }> = [];
    for (const mutation of scannedAccountMutations) {
        const ownerExists = playlistOwnerExists(mutation.ownerUserId);
        if (ownerExists) continue;
        if (ownerExists === undefined) {
            playlistFindingsTruncated = true;
            continue;
        }
        appendFinding(invalidAccountMutationOwners, {
            mutationId: String(mutation._id),
            ownerUserId: String(mutation.ownerUserId ?? '')
        });
    }
    const invalidAccountMutationTargets: Array<{
        mutationId: string;
        targetId: string;
        reason: 'missing' | 'malformed' | 'ownerMismatch' | 'responseMismatch' | 'statusMismatch' | 'operationMismatch';
    }> = [];
    for (const mutation of scannedAccountMutations) {
        const operation = String(mutation.operation ?? '');
        const status = String(mutation.status ?? '');
        const responseKind = String(mutation.response?.kind ?? '');
        const responseStatusCode = Number(mutation.response?.statusCode);
        const ownerUserId = canonicalObjectId(mutation.ownerUserId);
        const explicitTargetValue = String(mutation.targetId ?? '');
        const responsePlaylistValue = String(mutation.response?.playlistId ?? '');
        const explicitTargetId = explicitTargetValue
            ? canonicalObjectId(explicitTargetValue)
            : undefined;
        const responsePlaylistId = responsePlaylistValue
            ? canonicalObjectId(responsePlaylistValue)
            : undefined;
        const isCreate = operation === 'create' || operation === 'playlist.create';
        if (!supportedReceiptOperations.has(operation)) {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId: explicitTargetId || responsePlaylistId || '',
                reason: 'operationMismatch'
            });
            continue;
        }
        if (status !== 'pending' && status !== 'completed') {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId: explicitTargetId || responsePlaylistId || '',
                reason: 'statusMismatch'
            });
            continue;
        }
        const responsePresent = Boolean(responseKind || responsePlaylistValue)
            || Number.isFinite(responseStatusCode);
        if (status === 'pending' && responsePresent) {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId: explicitTargetId || responsePlaylistId || '',
                reason: 'responseMismatch'
            });
            continue;
        }
        if (status === 'completed'
            && (!responseKind || !responsePlaylistValue || !Number.isFinite(responseStatusCode))) {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId: explicitTargetId || responsePlaylistId || '',
                reason: 'missing'
            });
            continue;
        }
        if (!isCreate && !explicitTargetValue) {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId: responsePlaylistId || '',
                reason: 'missing'
            });
            continue;
        }
        if (!explicitTargetValue && !responsePlaylistValue) {
            if (!isCreate) {
                appendFinding(invalidAccountMutationTargets, {
                    mutationId: String(mutation._id),
                    targetId: '',
                    reason: 'missing'
                });
            }
            continue;
        }
        if ((explicitTargetValue && !explicitTargetId)
            || (responsePlaylistValue && !responsePlaylistId)) {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId: explicitTargetValue || responsePlaylistValue,
                reason: 'malformed'
            });
            continue;
        }
        if (explicitTargetId && responsePlaylistId && explicitTargetId !== responsePlaylistId) {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId: explicitTargetId,
                reason: 'responseMismatch'
            });
            continue;
        }
        const expectedResponseKind = operation === 'playlist.delete' ? 'deleted' : 'playlist';
        const expectedStatusCode = isCreate
            ? 201
            : operation === 'playlist.delete' ? 204 : 200;
        if (status === 'completed'
            && (responseKind !== expectedResponseKind || responseStatusCode !== expectedStatusCode)) {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId: explicitTargetId || responsePlaylistId || '',
                reason: 'responseMismatch'
            });
            continue;
        }
        const targetId = explicitTargetId || responsePlaylistId;
        if (!targetId) continue;
        const playlist = playlistsById.get(targetId);
        if (!playlist && !playlistTargetLookupIds.has(targetId)) {
            playlistTargetLookupTruncated = true;
            continue;
        }
        const playlistOwnerUserId = canonicalObjectId(playlist?.ownerUserId);
        if (playlist && ownerUserId && playlistOwnerUserId !== ownerUserId) {
            appendFinding(invalidAccountMutationTargets, {
                mutationId: String(mutation._id),
                targetId,
                reason: 'ownerMismatch'
            });
        }
    }

    return {
        generatedAt: new Date(),
        readOnly: true,
        truncated: sourceCollectionsTruncated
            || embeddedReferencesTruncated
            || playlistFindingsTruncated
            || playlistTargetLookupTruncated
            || pageTargetLookupTruncated
            || catalogReferenceFindingsTruncated,
        limit,
        referenceLimit,
        danglingSaves,
        danglingActivity,
        danglingCarouselItems,
        danglingArtistAlbums,
        danglingAlbumTracks,
        staleAlbumTrackMemberships,
        danglingTrackAlbums,
        missingAlbumTrackMemberships,
        danglingTrackArtists,
        danglingContentCollectionItems,
        danglingPageCarouselReferences,
        danglingPageContentCollectionReferences,
        danglingPlaylistItems,
        missingPlaylistOwners,
        stalledAudioTrackReferenceCleanup,
        invalidAccountMutationOwners,
        invalidAccountMutationTargets
    };
};
