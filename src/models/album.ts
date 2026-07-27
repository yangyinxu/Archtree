import { getDb } from '../infrastructure/database';
import { ObjectId } from 'mongodb';
import { SimpleDate } from '../models/simpleDate';
import { withDerivedCoverArtUrl } from '../utils/coverArt';
import { escapeRegex } from '../utils/search';

export class Album {
    title: string;
    coverArtUrl: string;
    coverArtId?: string;
    audioTrackIds: [string];
    releaseDate: SimpleDate;
    createdBy: string;

    constructor(title: string, coverArtUrl: string, audioTrackIds: [string], releaseDate: SimpleDate, createdBy: string) {
        this.title = title;
        this.coverArtUrl = coverArtUrl;
        this.audioTrackIds = audioTrackIds;
        this.releaseDate = releaseDate;
        this.createdBy = createdBy;
    }

    // save an album to the mongodb database
    save() {
        const db = getDb();

        // insert the album into the database
        return db!
            .collection('albums')
            .insertOne(this)
    }

    // fetch an album by its id
    static findById(albumId: string) {
        const db = getDb();

        // convert the album id to an ObjectId
        const albumObjectId = ObjectId.createFromHexString(albumId);

        // fetch the album from the database
        return db!
            .collection('albums')
            .find({ _id: albumObjectId })
            .next()
            .then(withDerivedCoverArtUrl);
    }

    // fetch all albums from the database
    static fetchAll(limit: number = 50, offset: number = 0) {
        const db = getDb();

        // fetch all albums from the database
        return db!
            .collection('albums')
            .find()
            .skip(offset)
            .limit(limit)
            .toArray()
            .then((albums: any) => {
                return albums.map(withDerivedCoverArtUrl);
            });
    }

    static searchByTitle(query: string, limit: number = 10) {
        const db = getDb();

        return db!
            .collection('albums')
            .find({ title: { $regex: escapeRegex(query), $options: 'i' } })
            .maxTimeMS(3_000)
            .limit(limit)
            .toArray()
            .then((albums) => albums.map(withDerivedCoverArtUrl));
    }

    static fetchByCreator(createdBy: string, limit: number = 50) {
        const db = getDb();

        return db!
            .collection('albums')
            .find({ createdBy })
            .limit(limit)
            .toArray()
            .then((albums) => albums.map(withDerivedCoverArtUrl));
    }

    static updateById(albumId: string, update: Record<string, unknown>) {
        const db = getDb();
        const albumObjectId = ObjectId.createFromHexString(albumId);

        return db!
            .collection('albums')
            .updateOne({ _id: albumObjectId }, { $set: update });
    }

    static deleteById(albumId: string) {
        const db = getDb();
        const albumObjectId = ObjectId.createFromHexString(albumId);

        return db!
            .collection('albums')
            .deleteOne({ _id: albumObjectId });
    }

    // Add delete album method
    // Note: Albums cannot be deleted if there are audio tracks associated with them
    //  - This is because audio tracks are associated with albums via the albumId field
    // Note 2: When an album is deleted, this albumId should be deleted from the artist's albumsId array
}
