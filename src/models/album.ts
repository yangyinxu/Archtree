import { getDb } from '../app';
import { ObjectId } from 'mongodb';
import { SimpleDate } from '../models/simpleDate';

export class Album {
    title: string;
    coverArtUrl: string;
    songIds: [string];
    releaseDate: SimpleDate;

    constructor(title: string, coverArtUrl: string, songIds: [string], releaseDate: SimpleDate) {
        this.title = title;
        this.coverArtUrl = coverArtUrl;
        this.songIds = songIds;
        this.releaseDate = releaseDate;
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

    // Add delete album method
    // Note: Albums cannot be deleted if there are songs associated with them
    //  - This is because songs are associated with albums via the albumId field
    // Note 2: When an album is deleted, this albumid should be deleted from the artist's albumsId array
}