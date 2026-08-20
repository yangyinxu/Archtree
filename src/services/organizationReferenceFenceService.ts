import { ClientSession, ObjectId } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';

export type OrganizationLifecycleStatus = 'ready' | 'deleting' | 'deleteFailed';

export const readyOrganizationLifecycleFilter = {
    $or: [
        { lifecycleStatus: 'ready' },
        { lifecycleStatus: { $exists: false } }
    ]
};

export class OrganizationReferenceUnavailableError extends Error {
    readonly statusCode = 409;
    readonly code = 'organization_reference_unavailable';

    constructor() {
        super('One or more Organizations are unavailable for new references.');
    }
}

const canonicalOrganizationIds = (values: readonly unknown[]) => {
    const ids = [...new Set(values.map((value) => String(value ?? '').trim().toLowerCase()))];
    if (ids.some((id) => !/^[0-9a-f]{24}$/.test(id))) {
        throw new OrganizationReferenceUnavailableError();
    }
    return ids;
};

/** Fences ready Organizations inside the caller's transaction before storing Credits. */
export const touchReadyOrganizationReferences = async (
    organizationIds: readonly unknown[],
    session: ClientSession
) => {
    const ids = canonicalOrganizationIds(organizationIds);
    if (ids.length === 0) return ids;
    const touched = await getDb()!.collection('organizations').updateMany(
        {
            _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) },
            ...readyOrganizationLifecycleFilter
        },
        {
            $set: {
                lifecycleStatus: 'ready',
                lifecycleUpdatedAt: new Date(),
                lifecycleError: null
            },
            $inc: { referenceRevision: 1 }
        },
        { session }
    );
    if (touched.matchedCount !== ids.length) throw new OrganizationReferenceUnavailableError();
    return ids;
};

/** Commits Organization fences and the resulting mutation atomically. */
export const withReadyOrganizationReferences = async <T>(
    organizationIds: readonly unknown[],
    mutation: (session: ClientSession, normalizedOrganizationIds: string[]) => Promise<T>
): Promise<T> => {
    const session = getDatabaseClient().startSession();
    let result: T | undefined;
    try {
        await session.withTransaction(async () => {
            const ids = await touchReadyOrganizationReferences(organizationIds, session);
            result = await mutation(session, ids);
        });
    } finally {
        await session.endSession();
    }
    return result as T;
};
