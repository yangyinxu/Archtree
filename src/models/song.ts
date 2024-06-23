import { getDb } from '../app';
import { ObjectId } from 'mongodb';

export class Song {
    title: string;
    artistIds: [string];
    genres: [string];
    albumId: string;
    releaseDate: Date;
    duration: string;
    format: string;
    coverArtUrl: string;

    constructor(
        title: string, 
        artistIds: [string], 
        genres: [string], 
        albumId: string, 
        releaseDate: Date,
        duration: string,
        format: string,
        coverArtUrl: string
    ) {
        this.title = title;
        this.artistIds = artistIds;
        this.genres = genres;
        this.albumId = albumId;
        this.releaseDate = releaseDate;
        this.duration = duration;
        this.format = format;
        this.coverArtUrl = coverArtUrl;
    }

    // save a song to the mongodb database
    save() {
        const db = getDb();

        // insert the song into the database
        return db!
            .collection('songs')
            .insertOne(this)
            .then((result: any) => {
                console.log(result);
            })
            .catch((error: any) => {
                console.log(error);
            });
    }

    // fetch a song by its id
    static findById(songId: string) {
        const db = getDb();

        // convert the song id to an ObjectId
        const songObjectId = ObjectId.createFromHexString(songId);

        // fetch the song from the database
        return db!
            .collection('songs')
            .find({ _id: songObjectId })
            .next();
    }

    // fetch all songs from the database
    static fetchAll() {
        const db = getDb();

        // fetch all songs from the database
        return db!
            .collection('songs')
            .find()
            .toArray()
            .then((songs: any) => {
                return songs;
            })
            .catch((error: any) => {
                console.log(error);
            });
    }

    // Delete a song by id
    static deleteById(songId: string) {
        const db = getDb();

        // convert the song id to an ObjectId
        const songObjectId = ObjectId.createFromHexString(songId);

        // delete the song from the database
        return db!
            .collection('songs')
            .deleteOne({ _id: songObjectId })
            .then((result: any) => {
                console.log(result);
            })
            .catch((error: any) => {
                console.log(error);
            });
    }
}