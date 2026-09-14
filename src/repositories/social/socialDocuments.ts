import type { SocialOutcome } from '../../contracts/socialV1';

/** Private persisted social state; project only through social-v1 allowlists. */
export interface SocialProfileDocument {
    _id: string; accountId: string; handle: string; alias: string;
    active: boolean; discoverable: boolean; revision: number; updatedAt: Date;
}
/** Canonical unordered pair, with independent directional blocks and a request incarnation. */
export interface SocialRelationshipDocument {
    _id: string; accountIds: string[]; socialIds: string[];
    state: 'none' | 'pending' | 'accepted'; requestedBy?: string;
    blockedBy: string[]; revision: number; updatedAt: Date; expiresAt?: Date;
}
/** Status-only receipts retain no peer identity or replayable private projection. */
export interface SocialReceiptDocument {
    _id: string; accountId: string; scopeId: string; commandId: string; digest: string;
    result: Omit<SocialOutcome, 'replayed'>; scopeExpiresAt: Date; expiresAt: Date;
}
/** One coalesced invalidation per account bounds recovery storage without historical payloads. */
export interface SocialOutboxDocument { _id: string; accountId: string; revision: number; updatedAt: Date }
/** Durable admission budgets cannot be reset by profile deactivation or process restart. */
export interface SocialBudgetDocument {
    _id: string; accountId: string; scopeDay?: number; scopes?: number;
    commandMinute?: number; commands?: number; incomingDay?: number; incoming?: number;
    relationshipRevision?: number;
    readMinute?: number; reads?: number;
    musicIncomingDay?: number; musicIncoming?: number;
    roomReactionMinute?: number; roomReactions?: number;
    listeningReportMinute?: number; listeningReports?: number;
}
/** Active handles have an owner; deletion leaves only the handle and its reservation deadline. */
export interface SocialHandleDocument { _id: string; accountId?: string; expiresAt?: Date }
