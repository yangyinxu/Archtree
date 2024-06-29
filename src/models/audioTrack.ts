import { getDb } from '../app';
import { ObjectId } from 'mongodb';
import { SimpleDate } from './simpleDate';

const collectionId = 'audioTracks';

export class AudioTrack {
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

    // save an audio track to the mongodb database
    save() {
        const db = getDb();

        // insert the audio track into the database
        return db!
            .collection(collectionId)
            .insertOne(this)
    }

    // fetch an audio track by its id
    static findById(audioTrackId: string) {
        const db = getDb();

        // convert the audio track id to an ObjectId
        const audioTrackObjectId = ObjectId.createFromHexString(audioTrackId);

        // fetch the audio track from the database
        return db!
            .collection(collectionId)
            .find({ _id: audioTrackObjectId })
            .next();
    }

    // fetch all audio tracks from the database
    static fetchAll() {
        const db = getDb();

        // fetch all audio tracks from the database
        return db!
            .collection(collectionId)
            .find()
            .toArray()
            .then((audioTracks: any) => {
                return audioTracks;
            })
            .catch((error: any) => {
                console.log(error);
            });
    }

    // Delete an audio track by id
    static deleteById(audioTrackId: string) {
        const db = getDb();

        // convert the audio track id to an ObjectId
        const audioTrackObjectId = ObjectId.createFromHexString(audioTrackId);

        // delete the audio track from the database
        return db!
            .collection(collectionId)
            .deleteOne({ _id: audioTrackObjectId })
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