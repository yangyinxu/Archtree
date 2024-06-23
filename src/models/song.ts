import { getDb } from '../app';
import { ObjectId } from 'mongodb';
import { SimpleDate } from '../models/simpleDate';

export class Song {
    title: string;
    artistIds: [string];
    genres: [string];
    albumId: string;
    releaseDate: SimpleDate;
    duration: string;
    format: AudioFormat;
    coverArtUrl: string;

    constructor(
        title: string,
        artistIds: [string],
        genres: [string],
        albumId: string,
        releaseDate: SimpleDate,
        duration: string,
        format: AudioFormat,
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

export class AudioFormat {
    type: string; // e.g., "MP3", "WAV", "FLAC"
    bitrate?: number; // in kbps for audio formats that support bitrates

    constructor(type: string, bitrate?: number) {
        this.type = type;
        if (bitrate !== undefined) {
            this.bitrate = bitrate;
        }
    }

    // convert the format json to a Format object
    static fromJson(json: any) {
        return new AudioFormat(json.type, json.bitrate);
    }

    toString(): string {
        return this.bitrate ? `${this.type} (${this.bitrate} kbps)` : this.type;
    }
}