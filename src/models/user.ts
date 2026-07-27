import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import Post from './post';
import { escapeRegex } from '../utils/search';

class User {
    constructor(
        public email: string,
        public password: string,
        public username: string,
        public posts: Post[],
        public role: string = 'user'
    ) {
        this.email = email;
        this.password = password;
        this.username = username;
        this.posts = posts;
        this.role = role;
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
        const normalized = String(email ?? '').trim().toLowerCase();

        return db!
            .collection('users')
            .find({ email: { $regex: `^${escapeRegex(normalized)}$`, $options: 'i' } })
            .maxTimeMS(3_000)
            .next();
    }

    static findByUsername(username: string) {
        const db = getDb();
        const normalized = String(username ?? '').trim();

        return db!
            .collection('users')
            .find({ username: { $regex: `^${escapeRegex(normalized)}$`, $options: 'i' } })
            .maxTimeMS(3_000)
            .next();
    }

    static async findByIdentifier(identifier: string) {
        const normalized = String(identifier ?? '').trim();
        if (!normalized) {
            return null;
        }

        if (normalized.includes('@')) {
            const byEmail = await this.findByEmail(normalized);
            if (byEmail) {
                return byEmail;
            }

            return this.findByUsername(normalized);
        }

        const byUsername = await this.findByUsername(normalized);
        if (byUsername) {
            return byUsername;
        }

        return this.findByEmail(normalized);
    }
}

export default User;
