import { ClientSession } from 'mongodb';

import { getDatabaseClient } from '../infrastructure/database';
import { touchReadyAlbumReferences } from './albumReferenceFenceService';
import { touchReadyAudioTrackReferences } from './audioTrackReferenceFenceService';

type CatalogItemReference = {
    contentType?: unknown;
    contentId?: unknown;
};

/** Normalizes and fences mixed Album/Soundtrack item arrays inside an existing transaction. */
export const touchReadyCatalogItemReferences = async (
    items: readonly CatalogItemReference[],
    session: ClientSession
) => {
    const albumIds = await touchReadyAlbumReferences(
        items.filter((item) => item?.contentType === 'album').map((item) => item.contentId),
        session
    );
    const audioTrackIds = await touchReadyAudioTrackReferences(
        items.filter((item) => item?.contentType === 'audioTrack').map((item) => item.contentId),
        session
    );
    const normalizedAlbums = new Set(albumIds);
    const normalizedTracks = new Set(audioTrackIds);
    return items.map((item) => {
        const contentId = String(item?.contentId ?? '').trim().toLowerCase();
        if (item?.contentType === 'album' && normalizedAlbums.has(contentId)) {
            return { ...item, contentId };
        }
        if (item?.contentType === 'audioTrack' && normalizedTracks.has(contentId)) {
            return { ...item, contentId };
        }
        return { ...item };
    });
};

/** Commits mixed catalog reference touches and their owning document mutation atomically. */
export const withReadyCatalogItemReferences = async <T>(
    items: readonly CatalogItemReference[],
    mutation: (
        session: ClientSession,
        normalizedItems: Array<Record<string, unknown>>
    ) => Promise<T>
): Promise<T> => {
    const session = getDatabaseClient().startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            const normalizedItems = await touchReadyCatalogItemReferences(items, session);
            result = await mutation(session, normalizedItems);
        });
    } finally {
        await session.endSession();
    }
    return result as T;
};
