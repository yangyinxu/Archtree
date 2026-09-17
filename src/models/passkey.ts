import crypto from 'crypto';
import { ClientSession } from 'mongodb';
import { getDb } from '../infrastructure/database';
import { withActiveAccount } from '../services/accountReferenceFenceService';

export interface PasskeyDocument {
    credentialId: string;
    userId: string;
    publicKey: string;
    counter: number;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
    createdAt: Date;
    updatedAt: Date;
}

/** Stores only public WebAuthn credential material and signature counters. */
export class Passkey {
    static listForUser(userId: string, session?: ClientSession) {
        return getDb()!.collection<PasskeyDocument>('passkeys').find({ userId }, { session }).toArray();
    }

    static findByCredentialId(credentialId: string) {
        return getDb()!.collection<PasskeyDocument>('passkeys').findOne({ credentialId });
    }

    static create(document: Omit<PasskeyDocument, 'createdAt' | 'updatedAt'>, session?: ClientSession) {
        const now = new Date();
        return withActiveAccount(document.userId, transaction => getDb()!.collection<PasskeyDocument>('passkeys').insertOne({
            ...document,
            createdAt: now,
            updatedAt: now
        }, { session: transaction }), session);
    }

    static updateCounter(credentialId: string, counter: number) {
        return getDb()!.collection<PasskeyDocument>('passkeys').updateOne(
            { credentialId },
            { $set: { counter, updatedAt: new Date() } }
        );
    }
}

export type PasskeyChallengePurpose = 'register' | 'authenticate';

/** Persists one-time challenges so verification survives multiple service instances. */
export class PasskeyChallenge {
    static async issue(
        purpose: PasskeyChallengePurpose,
        challenge: string,
        userId?: string,
        session?: ClientSession
    ) {
        const flowId = crypto.randomBytes(32).toString('base64url');
        const insert = (transaction?: ClientSession) => getDb()!.collection('passkeyChallenges').insertOne({
            flowId,
            purpose,
            challenge,
            userId,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 5 * 60_000)
        }, { session: transaction });
        if (userId) await withActiveAccount(userId, insert, session);
        else await insert(session);
        return flowId;
    }

    static async consume(flowId: string, purpose: PasskeyChallengePurpose) {
        const result = await getDb()!.collection('passkeyChallenges').findOneAndDelete({
            flowId,
            purpose,
            expiresAt: { $gt: new Date() }
        });
        return result.value;
    }
}
