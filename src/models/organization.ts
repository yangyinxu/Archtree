import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { withActiveAccount } from '../services/accountReferenceFenceService';
import {
    OrganizationLifecycleStatus,
    OrganizationReferenceUnavailableError,
    readyOrganizationLifecycleFilter,
    withReadyOrganizationReferences
} from '../services/organizationReferenceFenceService';
import { escapeRegex } from '../utils/search';

export const organizationTypes = [
    'label',
    'publisher',
    'distributor',
    'archive',
    'broadcaster',
    'studio',
    'other'
] as const;
export type OrganizationType = typeof organizationTypes[number];

/** Represents a non-Artist institution that can receive release Credits. */
export class Organization {
    _id?: ObjectId;
    name: string;
    organizationType: OrganizationType;
    description: string;
    createdBy: string;
    lifecycleStatus: OrganizationLifecycleStatus;
    lifecycleUpdatedAt: Date;
    lifecycleError: string | null;
    referenceRevision: number;

    constructor(
        name: string,
        organizationType: OrganizationType,
        description: string,
        createdBy: string,
        id?: ObjectId
    ) {
        if (id) this._id = id;
        this.name = name.trim();
        this.organizationType = organizationType;
        this.description = description.trim();
        this.createdBy = createdBy;
        this.lifecycleStatus = 'ready';
        this.lifecycleUpdatedAt = new Date();
        this.lifecycleError = null;
        this.referenceRevision = 0;
    }

    async save() {
        if (!this.name || this.name.length > 200 || !organizationTypes.includes(this.organizationType)) {
            throw new Error('Organization name or type is invalid.');
        }
        return withActiveAccount(this.createdBy, (session) =>
            getDb()!.collection('organizations').insertOne(this, { session })
        );
    }

    static findById(organizationId: string) {
        return getDb()!.collection('organizations')
            .find({ _id: ObjectId.createFromHexString(organizationId) })
            .next();
    }

    static findReadyById(organizationId: string) {
        return getDb()!.collection('organizations')
            .find({
                _id: ObjectId.createFromHexString(organizationId),
                ...readyOrganizationLifecycleFilter
            })
            .next();
    }

    static fetchAll(limit: number = 50, offset: number = 0) {
        return getDb()!.collection('organizations')
            .find()
            .sort({ name: 1, _id: 1 })
            .skip(offset)
            .limit(limit)
            .toArray();
    }

    static searchByName(query: string, limit: number = 10) {
        return getDb()!.collection('organizations')
            .find({
                name: { $regex: escapeRegex(query), $options: 'i' },
                ...readyOrganizationLifecycleFilter
            })
            .sort({ name: 1, _id: 1 })
            .limit(limit)
            .toArray();
    }

    static updateById(organizationId: string, update: Record<string, unknown>) {
        const allowed: Record<string, unknown> = {};
        if (update.name !== undefined) allowed.name = String(update.name).trim();
        if (update.description !== undefined) allowed.description = String(update.description).trim();
        if (update.organizationType !== undefined) {
            if (!organizationTypes.includes(update.organizationType as OrganizationType)) {
                throw new Error('Organization type is invalid.');
            }
            allowed.organizationType = update.organizationType;
        }
        return withReadyOrganizationReferences([organizationId], async (session) => {
            const result = await getDb()!.collection('organizations').updateOne(
                {
                    _id: ObjectId.createFromHexString(organizationId),
                    ...readyOrganizationLifecycleFilter
                },
                { $set: allowed },
                { session }
            );
            if (result.matchedCount !== 1) throw new OrganizationReferenceUnavailableError();
            return result;
        });
    }
}
