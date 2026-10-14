import { ObjectId } from 'mongodb';

/** Private relationship; names and release feeds are never copied into account state. */
export interface ArtistFollowDocument {
    _id: ObjectId;
    userId: string;
    artistId: string;
    followedAt: Date;
    updatedAt: Date;
}

export interface ArtistFollowStatus {
    artistId: string;
    following: boolean;
    followedAt: string | null;
}
