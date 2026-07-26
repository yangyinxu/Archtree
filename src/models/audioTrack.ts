import { getDb } from '../infrastructure/database';
import { ObjectId } from 'mongodb';
import { SimpleDate } from './simpleDate';
import { normalizeUtf8Text } from '../utils/textEncoding';

const collectionId = 'audioTracks';
const normalizeAudioTrackText = (track: any) => {
    if (!track) return track;
    if (typeof track.title === 'string') track.title = normalizeUtf8Text(track.title);
    if (typeof track.originalFileName === 'string') track.originalFileName = normalizeUtf8Text(track.originalFileName);
    return track;
};

export class AudioTrack {
    _id?: ObjectId;
    title: string;
    artistIds: [string];
    genres: [string];
    albumId: string;
    releaseDate: SimpleDate;
    duration: string;
    format: AudioFormat;
    coverArtUrl: string;
    createdBy: string;
    originalFileName?: string;
    contentType?: string;

    constructor(
        title: string,
        artistIds: [string],
        genres: [string],
        albumId: string,
        releaseDate: SimpleDate,
        duration: string,
        format: AudioFormat,
        coverArtUrl: string,
        createdBy: string,
        originalFileName?: string,
        contentType?: string,
        id?: ObjectId
    ) {
        if (id) this._id = id;
        this.title = title;
        this.artistIds = artistIds;
        this.genres = genres;
        this.albumId = albumId;
        this.releaseDate = releaseDate;
        this.duration = duration;
        this.format = format;
        this.coverArtUrl = coverArtUrl;
        this.createdBy = createdBy;
        this.originalFileName = originalFileName;
        this.contentType = contentType;
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
            .next()
            .then(normalizeAudioTrackText);
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
                return audioTracks.map(normalizeAudioTrackText);
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

    static updateById(audioTrackId: string, update: Record<string, unknown>) {
        const db = getDb();
        const audioTrackObjectId = ObjectId.createFromHexString(audioTrackId);

        return db!
            .collection(collectionId)
            .updateOne({ _id: audioTrackObjectId }, { $set: update });
    }

    static searchByTitle(query: string, limit: number = 10) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find({ title: { $regex: query, $options: 'i' } })
            .limit(limit)
            .toArray()
            .then((audioTracks) => audioTracks.map(normalizeAudioTrackText));
    }

    static fetchByCreator(createdBy: string, limit: number = 50) {
        const db = getDb();

        return db!
            .collection(collectionId)
            .find({ createdBy })
            .limit(limit)
            .toArray()
            .then((audioTracks) => audioTracks.map(normalizeAudioTrackText));
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
