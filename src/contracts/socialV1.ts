/** Additive social-v1 contract; no private User or listener-v1 DTO is reused. */
export const SOCIAL_LIMITS = Object.freeze({ friends: 500, pending: 50, blocks: 1_000,
    edges: 2_048, receipts: 1_000, safetyReceipts: 128, scopesPerDay: 24, commandsPerMinute: 30, readsPerMinute: 120,
    incomingPerDay: 100, page: 20, maximumPage: 50, scopeMs: 86_400_000,
    receiptGraceMs: 3_600_000, handleReservationMs: 30 * 86_400_000 });

export interface SocialActor { userId: string; sessionId: string }
export interface SocialCard { socialId: string; handle: string; alias: string; iconSeed: string }
export interface SocialOwnProfile extends SocialCard { active: boolean; discoverable: boolean; revision: number }
export type SocialListKind = 'friends' | 'incoming' | 'outgoing' | 'blocks';
export interface SocialListRow { socialId: string; profile: SocialCard | null; revision: number }
export interface SocialPage { items: SocialListRow[]; nextCursor: string | null }
export interface SocialRelationshipView { socialId: string; state: 'none' | 'incoming' | 'outgoing' | 'friends' | 'blocked'; revision: number }
export interface SocialScope { scopeToken: string; expiresAt: string }
export interface SocialMutationIdentity { scopeToken: string; commandId: string }
export type SocialCommand = SocialMutationIdentity & (
    | { action: 'profile'; expectedRevision: number; handle: string; alias: string; discoverable: boolean }
    | { action: 'deactivate' }
    | { action: 'request' | 'accept' | 'decline' | 'cancel' | 'remove' | 'unblock'; targetSocialId: string; expectedRevision: number }
    | { action: 'block'; targetSocialId: string }
);
export interface SocialOutcome { commandId: string; outcome: 'applied' | 'noop' | 'rejected'; code?: string; replayed: boolean }

/** Allowlisted domain errors contain no actor, recipient, handle or stored payload. */
export class SocialError extends Error {
    constructor(readonly statusCode: number, readonly code: string) {
        super('The social request could not be completed.');
    }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null
    && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export const exactSocialKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    record(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
export const isSocialId = (value: unknown): value is string => typeof value === 'string' && /^s_[a-f0-9]{32}$/.test(value);
export const isSocialRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const normalizeSocialHandle = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length > 24) return null;
    const handle = value.toLowerCase();
    return /^[a-z][a-z0-9_]{2,23}$/.test(handle) ? handle : null;
};
const aliasValue = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length > 200) return null;
    const alias = value.trim().normalize('NFC');
    return [...alias].length >= 1 && [...alias].length <= 50 && !/[\p{Cc}\p{Cf}]/u.test(alias) ? alias : null;
};

/** Parsing captures immutable intent before any database callback can be retried. */
export const parseSocialCommand = (input: unknown): SocialCommand | null => {
    if (!record(input) || typeof input.scopeToken !== 'string' || input.scopeToken.length > 1_024
        || input.scopeToken.length < 20 || typeof input.commandId !== 'string'
        || !/^[A-Za-z0-9_-]{16,80}$/.test(input.commandId)) return null;
    const base = ['scopeToken', 'commandId', 'action'];
    if (input.action === 'profile') {
        const handle = normalizeSocialHandle(input.handle);
        const alias = aliasValue(input.alias);
        if (!exactSocialKeys(input, [...base, 'handle', 'alias', 'discoverable', 'expectedRevision'])
            || !handle || !alias || typeof input.discoverable !== 'boolean' || !isSocialRevision(input.expectedRevision)) return null;
        return Object.freeze({ ...input, handle, alias }) as SocialCommand;
    }
    if (input.action === 'deactivate') return exactSocialKeys(input, base) ? Object.freeze({ ...input }) as unknown as SocialCommand : null;
    if (!isSocialId(input.targetSocialId)) return null;
    if (input.action === 'block') return exactSocialKeys(input, [...base, 'targetSocialId']) ? Object.freeze({ ...input }) as unknown as SocialCommand : null;
    if (!['request', 'accept', 'decline', 'cancel', 'remove', 'unblock'].includes(String(input.action))
        || typeof input.action !== 'string' || !isSocialRevision(input.expectedRevision)
        || !exactSocialKeys(input, [...base, 'targetSocialId', 'expectedRevision'])) return null;
    return Object.freeze({ ...input }) as unknown as SocialCommand;
};

/** Router dependency seam also supports isolated HTTP authorization tests. */
export interface SocialApi {
    admissionEnabled(): boolean;
    issueScope(actor: SocialActor): Promise<SocialScope>;
    ownProfile(actor: SocialActor): Promise<SocialOwnProfile | null>;
    lookup(actor: SocialActor, handle: string): Promise<SocialCard | null>;
    relationship(actor: SocialActor, targetSocialId: string): Promise<SocialRelationshipView | null>;
    list(actor: SocialActor, kind: SocialListKind, limit: number, cursor?: string): Promise<SocialPage>;
    mutate(actor: SocialActor, command: SocialCommand): Promise<SocialOutcome>;
    outcome(actor: SocialActor, identity: SocialMutationIdentity): Promise<SocialOutcome | null>;
}
