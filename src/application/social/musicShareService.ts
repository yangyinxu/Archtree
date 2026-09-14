import { randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import { MUSIC_SHARE_LIMITS, isMusicShareId, type MusicShareAction, type MusicShareDirection, type MusicSharePage,
    type SharedMusicContent, type SharedMusicType } from '../../contracts/socialMusicV1';
import { SocialError, exactSocialKeys, type SocialActor } from '../../contracts/socialV1';
import { getDb } from '../../infrastructure/database';
import type { MusicShareDocument } from '../../repositories/social/musicShareDocuments';
import type { SocialBudgetDocument, SocialProfileDocument, SocialRelationshipDocument } from '../../repositories/social/socialDocuments';
import { getListenerAlbum, getListenerAudioTrack } from '../../services/listenerContentService';
import { AlbumReferenceUnavailableError, touchReadyAlbumReferences } from '../../services/albumReferenceFenceService';
import { AudioTrackReferenceUnavailableError, touchReadyAudioTrackReferences } from '../../services/audioTrackReferenceFenceService';
import { readSocialToken, signSocialToken } from './socialTokens';

export type ResolveMusicShareContent = (type: SharedMusicType, id: string, session?: ClientSession) => Promise<SharedMusicContent | null>;
type Plan = { outcome: 'applied' | 'noop'; affected: string[]; write: () => Promise<void> };
const noop = (): Plan => ({ outcome: 'noop', affected: [], write: async () => undefined });
const invalid = () => new SocialError(400, 'invalid_request');
const card = (profile: SocialProfileDocument) => ({ socialId: profile._id, handle: profile.handle, alias: profile.alias, iconSeed: profile._id });

/** Catalog services retain their ordinary ready/public boundary; only minimal card fields cross into shares. */
export const resolvePublicContent: ResolveMusicShareContent = async (type, id) => {
    const value = type === 'album' ? (await getListenerAlbum(id))?.album : (await getListenerAudioTrack(id))?.audioTrack;
    return value ? { id: value.id, contentType: type, title: value.title, artworkUrl: value.artworkUrl, artistNames: value.artistNames } : null;
};
/** Shares and ephemeral listening reuse the same minimal, bounded public catalog card. */
export const publicContent = (value: SharedMusicContent | null, type: SharedMusicType, id: string): SharedMusicContent | null => {
    if (!value || value.id !== id || value.contentType !== type || typeof value.title !== 'string' || typeof value.artworkUrl !== 'string'
        || !Array.isArray(value.artistNames) || !value.artistNames.every(name => typeof name === 'string')) return null;
    let artworkUrl = value.artworkUrl;
    if (artworkUrl.length > 2_048 || /[\u0000-\u001f\u007f\\]/.test(artworkUrl)) artworkUrl = '';
    if (artworkUrl && !(artworkUrl.startsWith('/') && !artworkUrl.startsWith('//'))) {
        try { const url = new URL(artworkUrl); if (url.protocol !== 'https:' || url.username || url.password) artworkUrl = ''; }
        catch { artworkUrl = ''; }
    }
    return { id, contentType: type, title: [...value.title].slice(0, 200).join(''), artworkUrl,
        artistNames: value.artistNames.slice(0, 20).map(name => [...name].slice(0, 160).join('')) };
};

/** Plans and reads only: the parent SocialService owns auth fences, transactions, budgets and immutable receipts. */
export const createMusicShareService = (options: { now: () => number; secret: () => string; resolveContent?: ResolveMusicShareContent }) => {
    const { now, secret } = options;
    const resolveContent = options.resolveContent ?? resolvePublicContent;
    const db = () => getDb()!;
    const shares = () => db().collection<MusicShareDocument>('socialMusicShares');
    const profiles = () => db().collection<SocialProfileDocument>('socialProfiles');
    const relationships = () => db().collection<SocialRelationshipDocument>('socialRelationships');
    const budgets = () => db().collection<SocialBudgetDocument>('socialBudgets');
    const friendship = (a: string, b: string, session: ClientSession) => relationships().findOne({ _id: [a, b].sort().join(':'),
        state: 'accepted', blockedBy: { $size: 0 } }, { session });

    return {
        async plan(actor: SocialActor, action: MusicShareAction, session: ClientSession): Promise<Plan> {
            if (action.action !== 'shareMusic') {
                const field = action.action === 'dismissMusicShare' ? 'recipientAccountId' : 'senderAccountId';
                const value = await shares().findOne({ _id: action.shareId, [field]: actor.userId }, { session });
                if (!value) return noop();
                const existing = await db().collection('users').find({ _id: { $in: value.accountIds.map(id => new ObjectId(id)) } }, { session, projection: { _id: 1 } }).toArray();
                return { outcome: 'applied', affected: existing.map(user => user._id.toHexString()),
                    write: async () => { await shares().deleteOne({ _id: value._id, [field]: actor.userId }, { session }); } };
            }
            const owner = await profiles().findOne({ accountId: actor.userId, active: true }, { session });
            const peer = await profiles().findOne({ _id: action.targetSocialId, active: true }, { session });
            const edge = owner && peer && peer.accountId !== actor.userId ? await friendship(actor.userId, peer.accountId, session) : null;
            if (!owner || !peer || !edge) throw new SocialError(404, 'profile_unavailable');
            if (edge.revision !== action.expectedRevision) throw new SocialError(409, 'relationship_changed');
            const pair = { senderAccountId: actor.userId, recipientAccountId: peer.accountId, contentType: action.contentType, contentId: action.contentId };
            if (await shares().findOne({ ...pair, expiresAt: { $gt: new Date(now()) } }, { session })) return noop();
            for (const [field, id, maximum] of [['senderAccountId', actor.userId, MUSIC_SHARE_LIMITS.outgoing],
                ['recipientAccountId', peer.accountId, MUSIC_SHARE_LIMITS.incoming]] as const) {
                const filter: Filter<MusicShareDocument> = { expiresAt: { $gt: new Date(now()) } }; filter[field] = id;
                if (await shares().countDocuments(filter, { session, limit: maximum }) >= maximum) throw new SocialError(429, 'music_share_capacity');
            }
            const day = Math.floor(now() / 86_400_000); const budget = await budgets().findOne({ _id: peer.accountId }, { session });
            const incoming = budget?.musicIncomingDay === day ? budget.musicIncoming ?? 0 : 0;
            if (incoming >= MUSIC_SHARE_LIMITS.incomingPerDay) throw new SocialError(429, 'music_share_limit');
            try {
                if (action.contentType === 'album') await touchReadyAlbumReferences([action.contentId], session);
                else await touchReadyAudioTrackReferences([action.contentId], session);
            } catch (error) {
                if (error instanceof AlbumReferenceUnavailableError || error instanceof AudioTrackReferenceUnavailableError) throw new SocialError(404, 'music_unavailable');
                throw error;
            }
            const value: MusicShareDocument = { _id: `ms_${randomBytes(16).toString('hex')}`, ...pair,
                accountIds: [actor.userId, peer.accountId].sort(), createdAt: new Date(now()), expiresAt: new Date(now() + MUSIC_SHARE_LIMITS.retentionMs) };
            return { outcome: 'applied', affected: value.accountIds, write: async () => {
                const expired = await shares().find({ accountIds: { $in: value.accountIds }, expiresAt: { $lte: new Date(now()) } },
                    { session, projection: { _id: 1 } }).limit(2 * (MUSIC_SHARE_LIMITS.incoming + MUSIC_SHARE_LIMITS.outgoing)).toArray();
                if (expired.length) await shares().deleteMany({ _id: { $in: expired.map(row => row._id) } }, { session });
                await shares().insertOne(value, { session });
                await budgets().updateOne({ _id: peer.accountId }, { $set: { accountId: peer.accountId, musicIncomingDay: day, musicIncoming: incoming + 1 } }, { upsert: true, session });
            } };
        },
        async list(actor: SocialActor, direction: MusicShareDirection, limit: number, cursor: string | undefined, session: ClientSession): Promise<MusicSharePage> {
            if (!['incoming', 'outgoing'].includes(direction) || !Number.isSafeInteger(limit) || limit < 1 || limit > MUSIC_SHARE_LIMITS.maximumPage) throw invalid();
            let after: { createdAt: number; id: string } | undefined;
            if (cursor !== undefined) {
                const parsed = readSocialToken(cursor, secret());
                if (!exactSocialKeys(parsed, ['audience', 'accountId', 'direction', 'createdAt', 'id', 'expiresAt'])
                    || parsed.audience !== 'music-share-list-v1' || parsed.accountId !== actor.userId || parsed.direction !== direction
                    || !Number.isSafeInteger(parsed.createdAt) || Number(parsed.createdAt) < 0 || !isMusicShareId(parsed.id)
                    || !Number.isSafeInteger(parsed.expiresAt) || Number(parsed.expiresAt) <= now()) throw new SocialError(400, 'cursor_invalid');
                after = { createdAt: Number(parsed.createdAt), id: parsed.id };
            }
            const owner = await profiles().findOne({ accountId: actor.userId, active: true }, { session });
            if (!owner) return { items: [], nextCursor: null };
            const filter: Filter<MusicShareDocument> = { [direction === 'incoming' ? 'recipientAccountId' : 'senderAccountId']: actor.userId,
                expiresAt: { $gt: new Date(now()) }, ...(after ? { $or: [{ createdAt: { $lt: new Date(after.createdAt) } },
                    { createdAt: new Date(after.createdAt), _id: { $lt: after.id } }] } : {}) };
            const rows = await shares().find(filter, { session }).sort({ createdAt: -1, _id: -1 }).limit(MUSIC_SHARE_LIMITS[direction] + 1).toArray();
            if (rows.length > MUSIC_SHARE_LIMITS[direction]) throw new SocialError(503, 'social_unavailable');
            const items: MusicSharePage['items'] = [];
            for (const row of rows) {
                const peerId = direction === 'incoming' ? row.senderAccountId : row.recipientAccountId;
                const peer = await profiles().findOne({ accountId: peerId, active: true }, { session });
                if (!peer || !await friendship(actor.userId, peerId, session)) continue;
                items.push({ shareId: row._id, peer: card(peer), contentType: row.contentType, contentId: row.contentId,
                    content: publicContent(await resolveContent(row.contentType, row.contentId, session), row.contentType, row.contentId),
                    createdAtMs: row.createdAt.getTime(), expiresAtMs: row.expiresAt.getTime() });
                if (items.length > limit) break;
            }
            const more = items.length > limit; const page = items.slice(0, limit); const last = page[page.length - 1];
            return { items: page, nextCursor: more && last ? signSocialToken({ audience: 'music-share-list-v1', accountId: actor.userId, direction,
                createdAt: last.createdAtMs, id: last.shareId, expiresAt: now() + 900_000 }, secret()) : null };
        }
    };
};
