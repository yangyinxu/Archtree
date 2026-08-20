import { ObjectId } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';
import { readyOrganizationLifecycleFilter } from './organizationReferenceFenceService';

export class OrganizationReferencedError extends Error {
    readonly statusCode = 409;
    readonly code = 'organization_referenced';
    readonly references: { albums: number; audioTracks: number };

    constructor(references: { albums: number; audioTracks: number }) {
        super(`Organization is still credited by ${references.albums} Album(s) and ${references.audioTracks} MediaTrack(s). Remove or replace those Credits first.`);
        this.references = references;
    }
}

/** Deletes an unreferenced Organization while fencing concurrent Credit creation. */
export const deleteUnreferencedOrganization = async (organizationId: string) => {
    const canonicalId = ObjectId.createFromHexString(organizationId).toHexString();
    const _id = ObjectId.createFromHexString(canonicalId);
    const session = getDatabaseClient().startSession();
    try {
        await session.withTransaction(async () => {
            const transition = await getDb()!.collection('organizations').updateOne(
                { _id, ...readyOrganizationLifecycleFilter },
                {
                    $set: {
                        lifecycleStatus: 'deleting',
                        lifecycleUpdatedAt: new Date(),
                        lifecycleError: null
                    },
                    $inc: { referenceRevision: 1 }
                },
                { session }
            );
            if (transition.matchedCount !== 1) {
                throw Object.assign(new Error('Organization is unavailable.'), { statusCode: 409 });
            }
            const creditMatch = {
                credits: { $elemMatch: { subjectType: 'organization', subjectId: canonicalId } }
            };
            const [albums, audioTracks] = await Promise.all([
                getDb()!.collection('albums').countDocuments(creditMatch, { session, limit: 1_001 }),
                getDb()!.collection('audioTracks').countDocuments(creditMatch, { session, limit: 1_001 })
            ]);
            if (albums > 0 || audioTracks > 0) {
                throw new OrganizationReferencedError({ albums, audioTracks });
            }
            const deleted = await getDb()!.collection('organizations').deleteOne(
                { _id, lifecycleStatus: 'deleting' },
                { session }
            );
            if (deleted.deletedCount !== 1) {
                throw Object.assign(new Error('Organization deletion conflicted.'), { statusCode: 409 });
            }
        });
        return { deleted: true };
    } finally {
        await session.endSession();
    }
};
