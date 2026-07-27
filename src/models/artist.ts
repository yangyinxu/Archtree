import { getDb } from '../infrastructure/database';
import { ObjectId } from 'mongodb';
import { SimpleDate } from '../models/simpleDate';

const withoutLegacyTrackIds = (artist: any) => {
    if (artist) {
        delete artist.audioTrackIds;
    }
    return artist;
};

// define the Artist class
export class Artist {
    name: string;
    birthDate: SimpleDate;
    bio: string;
    coverArtUrl: string;
    albumIds: [string];
    createdBy: string;

    constructor(
        name: string,  
        birthDate: SimpleDate,
        bio: string,
        coverArtUrl: string,
        albumIds: [string], 
        createdBy: string
    ) {
        this.name = name;
        this.birthDate = birthDate;
        this.bio = bio;
        this.coverArtUrl = coverArtUrl;
        this.albumIds = albumIds;
        this.createdBy = createdBy;
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
            .next()
            .then(withoutLegacyTrackIds);
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
                return artists.map(withoutLegacyTrackIds);
            });
    }

    static searchByName(query: string, limit: number = 10) {
        const db = getDb();

        return db!
            .collection('artists')
            .find({ name: { $regex: query, $options: 'i' } })
            .limit(limit)
            .toArray()
            .then((artists) => artists.map(withoutLegacyTrackIds));
    }

    static fetchByCreator(createdBy: string, limit: number = 50) {
        const db = getDb();

        return db!
            .collection('artists')
            .find({ createdBy })
            .limit(limit)
            .toArray()
            .then((artists) => artists.map(withoutLegacyTrackIds));
    }

    static updateById(artistId: string, update: Record<string, unknown>) {
        const db = getDb();
        const artistObjectId = ObjectId.createFromHexString(artistId);

        return db!
            .collection('artists')
            .updateOne({ _id: artistObjectId }, { $set: update });
    }

    static deleteById(artistId: string) {
        const db = getDb();
        const artistObjectId = ObjectId.createFromHexString(artistId);

        return db!
            .collection('artists')
            .deleteOne({ _id: artistObjectId });
    }
}
