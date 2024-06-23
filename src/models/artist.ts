import { getDb } from '../app';
import { ObjectId } from 'mongodb';

// define the Artist class
export class Artist {
    name: string;
    birthDate: Date;
    bio: string;
    albumIds: [string];
    songIds: [string];

    constructor(
        name: string,  
        birthDate: Date,
        bio: string,
        albumIds: [string], 
        songIds: [string]
    ) {
        this.name = name;
        this.birthDate = birthDate;
        this.bio = bio;
        this.albumIds = albumIds;
        this.songIds = songIds;
    }

    // save an artist to the mongodb database
    save() {
        const db = getDb();

        // insert the artist into the database
        return db!
            .collection('artists')
            .insertOne(this)
            .then((result: any) => {
                console.log(result);
            })
            .catch((error: any) => {
                console.log(error);
            });
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