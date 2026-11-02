import { ObjectId, type ClientSession } from 'mongodb';
import { adminCatalogMutation, AdminCatalogError, withCurrentAdministrator } from '../../administration/catalog/adminCatalogService';
import { getDb } from '../../infrastructure/database';
import { touchReadyCatalogItemReferences } from '../catalog/catalogItemReferenceFenceService';
import { touchReadyAlbumReferences } from '../catalog/albumReferenceFenceService';
import { summarizeListenerVideos } from '../listener/listenerContentService';
import { maximumAdminVideoGridItems, readVideoGridState, type VideoGridView } from './videoPageService';

/** Resolves names and artwork through the same allowlisted projection as listener Video cards. */
const gridSnapshot = async (session: ClientSession) => {
    const state = await readVideoGridState(session, true);
    const summaries = await summarizeListenerVideos(state.tracks);
    const grid = { revision: adminCatalogMutation.fingerprint([state.revision, summaries]), defaultView: state.defaultView, items: summaries.map(track => ({
        id: track.id, title: track.title, coverUrl: track.artworkUrl || null,
        creator: track.displayByline || track.artistNames.join(', ') || null
    })) };
    return { state, grid };
};

/** Page reads expose the complete editable order and do not initialize content records. */
export const getAdminVideoGrid = (actor: string) => withCurrentAdministrator(actor, async session => {
    const { grid } = await gridSnapshot(session);
    return { grid };
});

/** Saves one complete approved order and presentation atomically, including first-use initialization. */
export const editAdminVideoGrid = (actor: string, raw: unknown) => {
    const parsed = adminCatalogMutation.parse(raw, ['defaultView', 'videoIds']);
    if ((parsed.defaultView !== 'grid' && parsed.defaultView !== 'immersive') || !Array.isArray(parsed.videoIds)
        || parsed.videoIds.length > maximumAdminVideoGridItems
        || parsed.videoIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))
        || new Set(parsed.videoIds).size !== parsed.videoIds.length) throw new AdminCatalogError(400, 'ADMIN_CATALOG_INVALID_INPUT');
    const intent = { operationId: parsed.operationId, expectedRevision: parsed.expectedRevision,
        defaultView: parsed.defaultView as VideoGridView, videoIds: [...parsed.videoIds] as string[] };
    const fingerprint = adminCatalogMutation.fingerprint(['video.grid', intent]);
    return withCurrentAdministrator(actor, async session => {
        const previous = await adminCatalogMutation.replay(actor, intent, fingerprint, session);
        if (previous) return previous;
        const { state, grid: reviewed } = await gridSnapshot(session);
        if (reviewed.revision !== intent.expectedRevision) throw new AdminCatalogError(409, 'ADMIN_CATALOG_REVISION_CONFLICT');
        const eligible = new Set(state.tracks.map(track => String(track._id)));
        if (eligible.size !== intent.videoIds.length || intent.videoIds.some(id => !eligible.has(id))) {
            throw new AdminCatalogError(400, 'ADMIN_CATALOG_INVALID_INPUT');
        }
        const items = intent.videoIds.map((contentId, order) => ({ contentType: 'audioTrack', contentId, order }));
        // Touch references before storing them so concurrent deletion cannot leave an orphaned saved order.
        await touchReadyCatalogItemReferences(items, session);
        await touchReadyAlbumReferences([...new Set(state.tracks.flatMap(track =>
            track.albumId && /^[a-f0-9]{24}$/i.test(String(track.albumId)) ? [String(track.albumId).toLowerCase()] : []))], session);
        const now = new Date();
        if (state.collection) {
            const updated = await getDb()!.collection('contentCollections').updateOne({ _id: state.collection._id },
                { $set: { items, videoView: intent.defaultView, updatedAt: now, updatedBy: actor }, $inc: { referenceRevision: 1 } }, { session });
            if (updated.matchedCount !== 1) throw new AdminCatalogError(409, 'ADMIN_CATALOG_REVISION_CONFLICT');
        } else {
            // Insert both records in this receipt transaction; reserved-ID collisions fail rather than overwrite.
            await getDb()!.collection('contentCollections').insertOne({ _id: new ObjectId(state.collectionId),
                name: 'Videos', presentation: 'grid', mode: 'dynamic', contentType: 'audioTrack', dynamicSource: 'publicVideos',
                videoView: intent.defaultView, items, createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now }, { session });
            await getDb()!.collection('pages').insertOne({ slug: 'videos', title: 'Videos', items: [
                { itemId: state.itemId, itemType: 'grid', collectionId: state.collectionId, order: 0, visibility: 'public' }
            ], createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now }, { session });
        }
        const { grid } = await gridSnapshot(session);
        const result = { grid, receipt: { operationId: intent.operationId } };
        await adminCatalogMutation.receipt(actor, intent, fingerprint, result, session);
        return result;
    });
};
