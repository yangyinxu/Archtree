import { getDb } from '../app';
import { ObjectId } from 'mongodb';
import { SimpleDate } from '../models/simpleDate';

export class Album {
    title: string;
    coverArtUrl: string;
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
            .next();
    }

    // fetch all albums from the database
    static fetchAll() {
        const db = getDb();

        // fetch all albums from the database
        return db!
            .collection('albums')
            .find()
            .toArray()
            .then((albums: any) => {
                return albums;
            });
    }

    static searchByTitle(query: string, limit: number = 10) {
        const db = getDb();

        return db!
            .collection('albums')
            .find({ title: { $regex: query, $options: 'i' } })
            .limit(limit)
            .toArray();
    }

    static fetchByCreator(createdBy: string, limit: number = 50) {
        const db = getDb();

        return db!
            .collection('albums')
            .find({ createdBy })
            .limit(limit)
            .toArray();
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