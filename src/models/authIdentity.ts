import { ObjectId } from 'mongodb';
import { getDb } from '../infrastructure/database';

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

    static listForUser(userId: string) {
        return getDb()!
            .collection<AuthIdentityDocument>('authIdentities')
            .find({ userId })
            .project<{ provider: AuthProvider }>({ provider: 1 })
            .toArray();
    }

    static async create(
        userId: string,
        provider: AuthProvider,
        providerSubject: string,
        email?: string
    ) {
        const now = new Date();
        await getDb()!.collection<AuthIdentityDocument>('authIdentities').insertOne({
            userId,
            provider,
            providerSubject,
            email,
            createdAt: now,
            updatedAt: now
        });
    }

    static deleteForUser(userId: string) {
        return getDb()!.collection<AuthIdentityDocument>('authIdentities').deleteMany({ userId });
    }
}

export default AuthIdentity;
