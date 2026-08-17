import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { AlbumReferenceUnavailableError } from './albumReferenceFenceService';
import {
    ensureAlbumPrimaryArtistCredit,
    removeAlbumPrimaryArtistCredit,
    replaceArtistPrimaryAlbumCredits
} from './catalogCreditService';

export type ArtistAlbumLinkOutcome = 'added' | 'alreadyLinked' | 'removed' | 'notLinked';

/** Adds one canonical Album membership while fencing both ready records atomically. */
export const addAlbumToArtist = async (
    artistId: string,
    albumId: string
): Promise<ArtistAlbumLinkOutcome> => {
    const existed = Boolean(await getDb()!.collection('albums').findOne({
        _id: ObjectId.createFromHexString(albumId),
        credits: { $elemMatch: { subjectType: 'artist', subjectId: artistId, role: 'primary' } }
    }, { projection: { _id: 1 } })) || Boolean(await getDb()!.collection('artists').findOne({
        _id: ObjectId.createFromHexString(artistId),
        albumIds: { $in: [albumId, ObjectId.createFromHexString(albumId)] }
    }, { projection: { _id: 1 } }));
    try {
        await ensureAlbumPrimaryArtistCredit(albumId, artistId);
    } catch (error) {
        if ((error as any)?.code === 'catalog_credit_conflict') {
            throw new AlbumReferenceUnavailableError();
        }
        throw error;
    }
    return existed ? 'alreadyLinked' : 'added';
};

/** Removes only one ready Album membership and leaves both catalog records intact. */
export const removeAlbumFromArtist = async (
    artistId: string,
    albumId: string
): Promise<ArtistAlbumLinkOutcome> => {
    const existed = Boolean(await getDb()!.collection('albums').findOne({
        _id: ObjectId.createFromHexString(albumId),
        credits: { $elemMatch: { subjectType: 'artist', subjectId: artistId, role: 'primary' } }
    }, { projection: { _id: 1 } })) || Boolean(await getDb()!.collection('artists').findOne({
        _id: ObjectId.createFromHexString(artistId),
        albumIds: { $in: [albumId, ObjectId.createFromHexString(albumId)] }
    }, { projection: { _id: 1 } }));
    try {
        await removeAlbumPrimaryArtistCredit(albumId, artistId);
    } catch (error) {
        if ((error as any)?.code === 'catalog_credit_conflict') {
            throw new AlbumReferenceUnavailableError();
        }
        throw error;
    }
    return existed ? 'removed' : 'notLinked';
};

/** Replaces the complete canonical membership, including an explicit empty list. */
export const replaceArtistAlbums = async (
    artistId: string,
    albumIds: readonly string[]
) => replaceArtistPrimaryAlbumCredits(artistId, albumIds);
