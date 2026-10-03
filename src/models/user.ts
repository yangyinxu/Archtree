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

    /**
     * Records the newest registration attempt on an account that has not
     * proven email ownership, for a later resend to bind. It deliberately
     * leaves `password` alone: replacing it would let the first registrant's
     * sign-in response change from "verify your email" to "invalid
     * credentials" and reveal that someone else just registered the address.
     * Resolves whether the account was still unverified.
     */
    static async recordPendingRegistration(
        userId: string,
        registration: { passwordHash: string; displayName: string; username: string },
        session: ClientSession
    ) {
        const result = await getDb()!.collection('users').updateOne(
            { _id: new ObjectId(userId), emailVerified: false },
            { $set: { pendingRegistration: registration } },
            { session }
        );
        return result.matchedCount === 1;
    }

    /**
     * Marks the email verified and applies exactly the credentials bound to the
     * redeemed code in one write, so no reader observes a verified account with
     * another attempt's password. Resolves whether the account was unverified.
     */
    static async applyVerifiedRegistration(
        userId: string,
        registration: { passwordHash: string; displayName: string; username: string },
        session: ClientSession
    ) {
        const now = new Date();
        const result = await getDb()!.collection('users').updateOne(
            { _id: new ObjectId(userId), emailVerified: false },
            { $set: {
                emailVerified: true,
                emailVerifiedAt: now,
                password: registration.passwordHash,
                passwordUpdatedAt: now,
                displayName: registration.displayName,
                username: registration.username
            }, $unset: { pendingRegistration: '' } },
            { session }
        );
        return result.matchedCount === 1;
    }

    /**
     * Replaces the password. On an unverified account a reset password also
     * supersedes any pending registration attempt, so the next verification
     * code binds the password set through the mailbox-owned reset.
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
