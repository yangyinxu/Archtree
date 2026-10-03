import { ClientSession, ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import Post from './post';
import { escapeRegex } from '../utils/search';

class User {
    constructor(
        public email: string,
        public password: string,
        public username: string,
        public posts: Post[],
        public role: string = 'user',
        public displayName: string = '',
        public emailVerified: boolean = true
    ) {
        this.email = email;
        this.password = password;
        this.username = username;
        this.posts = posts;
        this.role = role;
        this.displayName = displayName;
        this.emailVerified = emailVerified;
    }

    save() {
        // save user to database
        const db = getDb();

        return db!
            .collection('users')
            .insertOne(this)
    }

    static findById(userId: string, session?: ClientSession) {
        if (!ObjectId.isValid(userId)) {
            return null;
        }
        const db = getDb();

        return db!
            .collection('users')
            .find({ _id: new ObjectId(userId)}, { session })
            .next();
    }

    /** Finds an account by case-insensitive exact email; pass `session` to read inside a transaction. */
    static findByEmail(email: string, session?: ClientSession) {
        const db = getDb();
        const normalized = String(email ?? '').trim().toLowerCase();

        return db!
            .collection('users')
            .find({ email: { $regex: `^${escapeRegex(normalized)}$`, $options: 'i' } }, { session })
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

    /**
     * Inserts an account whose email was proven by a registration link before
     * any credential existed. The unique email index rejects a concurrent
     * completion for the same address.
     */
    static async insertVerified(
        account: { email: string; password: string; displayName: string; username: string },
        session: ClientSession
    ) {
        const now = new Date();
        const result = await getDb()!.collection('users').insertOne({
            email: account.email,
            password: account.password,
            username: account.username,
            posts: [],
            role: 'user',
            displayName: account.displayName,
            emailVerified: true,
            emailVerifiedAt: now,
            passwordUpdatedAt: now
        }, { session });
        return result.insertedId.toString();
    }

    /**
     * Replaces a record left by the earlier code-based sign-up with `document`
     * in one write. The filter matches only while the record is still
     * unverified. Resolves whether it was replaced.
     */
    static async replacePendingRecord(userId: string, document: Record<string, unknown>, session: ClientSession) {
        const result = await getDb()!.collection('users').replaceOne(
            { _id: new ObjectId(userId), emailVerified: false },
            document,
            { session }
        );
        return result.matchedCount === 1;
    }

    /** Records proven inbox control, e.g. after a completed password reset. */
    static markEmailVerified(userId: string, session: ClientSession) {
        return getDb()!.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { $set: { emailVerified: true, emailVerifiedAt: new Date() } },
            { session }
        );
    }

    /**
     * Verifies an account created before verification existed, without
     * touching its password. An account that is already verified is left
     * unchanged, and a record from the earlier code-based sign-up never
     * matches.
     */
    static confirmLegacyEmail(userId: string, session: ClientSession) {
        return getDb()!.collection('users').updateOne(
            { _id: new ObjectId(userId), emailVerified: { $exists: false } },
            { $set: { emailVerified: true, emailVerifiedAt: new Date() } },
            { session }
        );
    }

    /**
     * Replaces the password. `pendingRegistration` is a field the earlier
     * code-based sign-up stored on unverified records; clearing it here is
     * harmless and keeps no bound password hash around.
     */
    static updatePassword(userId: string, password: string, session: ClientSession) {
        const db = getDb();
        return db!.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { $set: { password, passwordUpdatedAt: new Date() }, $unset: { pendingRegistration: '' } },
            { session }
        );
    }

    /** Atomically attaches an avatar only when the caller still owns the expected revision. */
    static replaceAvatar(userId: string, expectedRevision: number, avatarAssetId: string) {
        const revisionFilter = expectedRevision === 0
            ? { $or: [{ avatarRevision: 0 }, { avatarRevision: { $exists: false } }] }
            : { avatarRevision: expectedRevision };
        return getDb()!.collection('users').findOneAndUpdate(
            { _id: new ObjectId(userId), ...revisionFilter },
            {
                $set: { avatarAssetId, avatarUpdatedAt: new Date() },
                $inc: { avatarRevision: 1 }
            },
            { returnDocument: 'before' }
        );
    }

    /** Clears the expected avatar reference after its owned storage object is removed. */
    static clearAvatar(userId: string, expectedRevision: number, avatarAssetId: string) {
        return getDb()!.collection('users').findOneAndUpdate(
            {
                _id: new ObjectId(userId),
                avatarAssetId,
                avatarRevision: expectedRevision
            },
            {
                $set: { avatarAssetId: null, avatarUpdatedAt: new Date() },
                $inc: { avatarRevision: 1 }
            },
            { returnDocument: 'before' }
        );
    }

    /** Removes a newly staged account when its identity link cannot be persisted. */
    static deleteById(userId: string) {
        if (!ObjectId.isValid(userId)) {
            return null;
        }
        return getDb()!.collection('users').deleteOne({ _id: new ObjectId(userId) });
    }
}

export default User;
