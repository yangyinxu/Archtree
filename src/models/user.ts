import { ObjectId } from 'mongodb';
import { getDb } from '../app';
import Post from './post';

class User {
    constructor(
        public email: string,
        public password: string,
        public username: string,
        public posts: Post[]
    ) {
        this.email = email;
        this.password = password;
        this.username = username;
        this.posts = posts;
    }

    save() {
        // save user to database
        const db = getDb();

        return db!
            .collection('users')
            .insertOne(this)
    }

    static findById(userId: string) {
        const db = getDb();

        return db!
            .collection('users')
            .find({ _id: new ObjectId(userId)})
            .next();
    }

    static findByEmail(email: string) {
        const db = getDb();

        return db!
            .collection('users')
            .find({ email: email })
            .next();
    }
}

export default User;