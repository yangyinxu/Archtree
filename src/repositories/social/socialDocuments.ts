import type { SocialOutcome, SocialReportReason } from '../../contracts/socialV1';

/**
 * An administrator suspension hides the profile by holding `active` and `discoverable` false.
 * The listener's own choices are kept here so unsuspension restores them exactly.
 */
export interface SocialSuspension {
    suspendedAt: Date; suspendedBy: string; restoreActive: boolean; restoreDiscoverable: boolean;
}
/** Private persisted social state; project only through social-v1 allowlists. */
export interface SocialProfileDocument {
    _id: string; accountId: string; handle: string; alias: string;
    active: boolean; discoverable: boolean; revision: number; updatedAt: Date;
    suspension?: SocialSuspension;
}
/**
 * Canonical unordered pair, with independent directional blocks and a request incarnation.
 * `requestCounts` (aligned with `accountIds`) records how many requests each side sent on UTC day
 * `requestDay`. Cancel, decline and every other transition keep it, and a `none` tombstone outlives the
 * day, so cycling a request cannot reset the per-pair cap or re-charge the recipient's daily budget.
 */
export interface SocialRelationshipDocument {
    _id: string; accountIds: string[]; socialIds: string[];
    state: 'none' | 'pending' | 'accepted'; requestedBy?: string;
    blockedBy: string[]; revision: number; updatedAt: Date; expiresAt?: Date;
    requestDay?: number; requestCounts?: number[];
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
    outgoingDay?: number; outgoing?: number;
    relationshipRevision?: number;
    readMinute?: number; reads?: number;
    musicIncomingDay?: number; musicIncoming?: number;
    roomReactionMinute?: number; roomReactions?: number;
    listeningReportMinute?: number; listeningReports?: number;
    reportDay?: number; reports?: number;
}
/** Active handles have an owner; deletion leaves only the handle and its reservation deadline. */
export interface SocialHandleDocument { _id: string; accountId?: string; expiresAt?: Date }
/**
 * Moderation evidence for one reporter, target and UTC day. The target is never told.
 * The handle and nickname are snapshots of what was reported. Deleting the reporter's
 * account removes the reporter fields and note; deleting the target removes the report.
 * Resolved reports expire after their retention period; open reports wait for an admin.
 */
export interface SocialReportDocument {
    _id: string; dedupeKey: string;
    reporterAccountId?: string; reporterSocialId?: string;
    targetAccountId: string; targetSocialId: string; targetHandle: string; targetAlias: string;
    reason: SocialReportReason; note?: string;
    state: 'open' | 'resolved'; createdAt: Date;
    resolution?: 'dismissed' | 'actioned' | 'suspended'; resolvedAt?: Date; resolvedBy?: string;
    anonymizedAt?: Date; expiresAt?: Date;
}
