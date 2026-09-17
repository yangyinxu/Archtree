import { ClientSession, ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { withActiveAccount } from '../services/accountReferenceFenceService';

export type AuthProvider = 'apple' | 'google';

export interface AuthIdentityDocument {
    _id?: ObjectId;
    userId: string;
    provider: AuthProvider;
    providerSubject: string;
    email?: string;
    createdAt: Date;
    updatedAt: Date;
}

/** Persists verified provider subjects separately from mutable profile data. */
class AuthIdentity {
    static find(provider: AuthProvider, providerSubject: string) {
        return getDb()!.collection<AuthIdentityDocument>('authIdentities').findOne({
            provider,
            providerSubject
        });
    }

    static listForUser(userId: string, session?: ClientSession) {
        return getDb()!
            .collection<AuthIdentityDocument>('authIdentities')
            .find({ userId }, { session })
            .project<{ provider: AuthProvider }>({ provider: 1 })
            .toArray();
    }

    static async create(
        userId: string,
        provider: AuthProvider,
        providerSubject: string,
        email?: string,
        session?: ClientSession
    ) {
        const now = new Date();
        await withActiveAccount(userId, transaction => getDb()!.collection<AuthIdentityDocument>('authIdentities').insertOne({
            userId,
            provider,
            providerSubject,
            email,
            createdAt: now,
            updatedAt: now
        }, { session: transaction }), session);
    }

    static deleteForUser(userId: string) {
        return getDb()!.collection<AuthIdentityDocument>('authIdentities').deleteMany({ userId });
    }

    /** Removes one linked provider only after account recovery safeguards are checked. */
    static deleteForUserAndProvider(userId: string, provider: AuthProvider, session: ClientSession) {
        return getDb()!.collection<AuthIdentityDocument>('authIdentities').deleteOne({
            userId,
            provider
        }, { session });
    }
}

export default AuthIdentity;
