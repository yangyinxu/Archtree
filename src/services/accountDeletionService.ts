import { ClientSession, ObjectId } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';
import {
    AccountReferenceUnavailableError,
    touchActiveAccount
} from './accountReferenceFenceService';

export type AccountDeletionResult =
    | { status: 'deleted' }
    | { status: 'missing' }
    | { status: 'avatarAttached' }
    | { status: 'avatarCleanupPending' }
    | { status: 'sharedProvenance' };

export interface AccountDeletionDependencies {
    /** Test-only coordination point immediately before this transaction takes the account fence. */
    beforeAccountFence?: (session: ClientSession) => Promise<void>;
    /** Test-only coordination point after this transaction owns the account fence. */
    afterAccountFence?: (session: ClientSession) => Promise<void>;
}

class AccountDeletionBlockedError extends Error {
    constructor(readonly reason: 'avatarAttached' | 'avatarCleanupPending' | 'sharedProvenance') {
        super('Account deletion is blocked by retained account references.');
    }
}

const sharedProvenanceCollections = [
    'artists',
    'albums',
    'audioTracks',
    'carousels',
    'contentCollections',
    'pages',
    'imageAssets'
] as const;

const personalCollections = [
    ['userSaves', 'userId'],
    ['userActivity', 'userId'],
    ['authActionTokens', 'userId'],
    ['authIdentities', 'userId'],
    ['passkeys', 'userId'],
    ['passkeyChallenges', 'userId'],
    ['avatarMutations', 'userId'],
    ['playlists', 'ownerUserId'],
    ['accountMutations', 'ownerUserId'],
    ['authSessions', 'userId']
] as const;

/**
 * Serializes account removal with private-data writers and refuses deletion
 * until every avatar operation and lifecycle record has reached cleanup.
 */
export const deleteListenerAccountData = async (
    userId: string,
    dependencies: AccountDeletionDependencies = {}
): Promise<AccountDeletionResult> => {
    if (!/^[0-9a-f]{24}$/i.test(userId)) return { status: 'missing' };
    const canonicalUserId = ObjectId.createFromHexString(userId).toHexString();
    const userObjectId = ObjectId.createFromHexString(canonicalUserId);
    const ownedByUser = { $in: [canonicalUserId, userObjectId] };
    const db = getDb()!;
    const session = getDatabaseClient().startSession();

    try {
        try {
            await session.withTransaction(async () => {
                await dependencies.beforeAccountFence?.(session);
                await touchActiveAccount(canonicalUserId, session);
                await dependencies.afterAccountFence?.(session);

                for (const collectionName of sharedProvenanceCollections) {
                    const provenanceQuery = collectionName === 'imageAssets'
                        ? { createdBy: canonicalUserId, ownerType: { $ne: 'user' } }
                        : { createdBy: canonicalUserId };
                    const provenance = await db.collection(collectionName).findOne(
                        provenanceQuery,
                        { session, projection: { _id: 1 } }
                    );
                    if (provenance) {
                        throw new AccountDeletionBlockedError('sharedProvenance');
                    }
                }

                const user = await db.collection('users').findOne(
                    { _id: userObjectId },
                    { session, projection: { avatarAssetId: 1 } }
                );
                if (String(user?.avatarAssetId ?? '')) {
                    throw new AccountDeletionBlockedError('avatarAttached');
                }

                const pendingAvatarMutation = await db.collection('avatarMutations').findOne(
                    { userId: ownedByUser, status: 'pending' },
                    { session, projection: { _id: 1 } }
                );
                if (pendingAvatarMutation) {
                    throw new AccountDeletionBlockedError('avatarCleanupPending');
                }

                const privateImageAsset = await db.collection('imageAssets').findOne(
                    { ownerType: 'user', ownerId: ownedByUser },
                    { session, projection: { _id: 1 } }
                );
                if (privateImageAsset) {
                    throw new AccountDeletionBlockedError('avatarCleanupPending');
                }

                for (const [collectionName, ownerField] of personalCollections) {
                    await db.collection(collectionName).deleteMany(
                        { [ownerField]: ownedByUser },
                        { session }
                    );
                }
                const deleted = await db.collection('users').deleteOne(
                    {
                        _id: userObjectId,
                        $or: [
                            { avatarAssetId: null },
                            { avatarAssetId: '' },
                            { avatarAssetId: { $exists: false } }
                        ]
                    },
                    { session }
                );
                if (deleted.deletedCount !== 1) {
                    throw new AccountDeletionBlockedError('avatarAttached');
                }
            });
            return { status: 'deleted' };
        } catch (error) {
            if (error instanceof AccountDeletionBlockedError) {
                return { status: error.reason };
            }
            if (error instanceof AccountReferenceUnavailableError) {
                return { status: 'missing' };
            }
            throw error;
        }
    } finally {
        await session.endSession();
    }
};
