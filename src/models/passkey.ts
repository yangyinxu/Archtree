import crypto from 'crypto';
import { getDb } from '../infrastructure/database';

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
    static listForUser(userId: string) {
        return getDb()!.collection<PasskeyDocument>('passkeys').find({ userId }).toArray();
    }

    static findByCredentialId(credentialId: string) {
        return getDb()!.collection<PasskeyDocument>('passkeys').findOne({ credentialId });
    }

    static create(document: Omit<PasskeyDocument, 'createdAt' | 'updatedAt'>) {
        const now = new Date();
        return getDb()!.collection<PasskeyDocument>('passkeys').insertOne({
            ...document,
            createdAt: now,
            updatedAt: now
        });
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
        userId?: string
    ) {
        const flowId = crypto.randomBytes(32).toString('base64url');
        await getDb()!.collection('passkeyChallenges').insertOne({
            flowId,
            purpose,
            challenge,
            userId,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 5 * 60_000)
        });
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
