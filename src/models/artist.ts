import { getDb } from '../app';
import { ObjectId } from 'mongodb';
import { SimpleDate } from '../models/simpleDate';

// define the Artist class
export class Artist {
    name: string;
    birthDate: SimpleDate;
    bio: string;
    coverArtUrl: string;
    albumIds: [string];
    audioTrackIds: [string];

    constructor(
        name: string,  
        birthDate: SimpleDate,
        bio: string,
        coverArtUrl: string,
        albumIds: [string], 
        audioTrackIds: [string]
    ) {
        this.name = name;
        this.birthDate = birthDate;
        this.bio = bio;
        this.coverArtUrl = coverArtUrl;
        this.albumIds = albumIds;
        this.audioTrackIds = audioTrackIds;
    }

    // save an artist to the mongodb database
    save() {
        const db = getDb();

        // insert the artist into the database
        return db!
            .collection('artists')
            .insertOne(this)
    }

    // fetch an artist by its id
    static findById(artistId: string) {
        const db = getDb();

        // convert the artist id to an ObjectId
        const artistObjectId = ObjectId.createFromHexString(artistId);

        // fetch the artist from the database
        return db!
            .collection('artists')
            .find({ _id: artistObjectId })
            .next();
    }

    // fetch all artists from the database
    static fetchAll() {
        const db = getDb();

        // fetch all artists from the database
        return db!
            .collection('artists')
            .find()
            .toArray()
            .then((artists: any) => {
                return artists;
            });
    }
}