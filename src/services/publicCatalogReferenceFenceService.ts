import type { ClientSession } from 'mongodb';
import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { ArtistReferenceUnavailableError, touchReadyArtistReferences } from './artistReferenceFenceService';
import { AlbumReferenceUnavailableError, touchReadyAlbumReferences } from './albumReferenceFenceService';
import { AudioTrackReferenceUnavailableError, touchReadyAudioTrackReferences } from './audioTrackReferenceFenceService';
import { findPublicAudioTracks, readyPublicAlbumFilter, readyPublicArtistFilter } from './catalogVisibilityService';

/** Listener mutations write the same lifecycle fences as admin visibility changes. */
export const touchPublicArtistReferences = async (values: readonly unknown[], session: ClientSession) => {
    const ids = await touchReadyArtistReferences(values, session);
    if (!ids.length) return ids;
    const count = await getDb()!.collection('artists').countDocuments({
        $and: [readyPublicArtistFilter, { _id: { $in: ids.map(id => new ObjectId(id)) } }]
    }, { session });
    if (count !== ids.length) throw new ArtistReferenceUnavailableError();
    return ids;
};

/** Public Album references also fence inherited access for their MediaTracks. */
export const touchPublicAlbumReferences = async (values: readonly unknown[], session: ClientSession) => {
    const ids = await touchReadyAlbumReferences(values, session);
    if (!ids.length) return ids;
    const count = await getDb()!.collection('albums').countDocuments({
        $and: [readyPublicAlbumFilter, { _id: { $in: ids.map(id => new ObjectId(id)) } }]
    }, { session });
    if (count !== ids.length) throw new AlbumReferenceUnavailableError();
    return ids;
};

/** Validate effective access after track and parent writes, inside the caller's transaction. */
export const touchPublicAudioTrackReferences = async (values: readonly unknown[], session: ClientSession) => {
    const ids = await touchReadyAudioTrackReferences(values, session);
    if (!ids.length) return ids;
    const tracks = await findPublicAudioTracks({ _id: { $in: ids.map(id => new ObjectId(id)) } }, session)
        .project({ _id: 1, albumId: 1 }).toArray();
    if (tracks.length !== ids.length) throw new AudioTrackReferenceUnavailableError();
    try {
        await touchPublicAlbumReferences(tracks.map(track => track.albumId).filter(Boolean), session);
    } catch (error) {
        if (error instanceof AlbumReferenceUnavailableError) throw new AudioTrackReferenceUnavailableError();
        throw error;
    }
    return ids;
};
