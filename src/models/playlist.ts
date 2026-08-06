import { createHash, randomUUID } from 'node:crypto';
import { ClientSession, ObjectId } from 'mongodb';

import { getDatabaseClient, getDb } from '../infrastructure/database';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';

export const PLAYLIST_COLLECTION = 'playlists';
export const ACCOUNT_MUTATION_COLLECTION = 'accountMutations';
export const MAX_PLAYLISTS_PER_ACCOUNT = 100;
export const MAX_PLAYLIST_ITEMS = 500;
export const MAX_PLAYLIST_PAGE_SIZE = 100;
export const DEFAULT_PLAYLIST_PAGE_SIZE = 50;
export const MAX_PLAYLIST_MEMBERSHIP_TRACK_IDS = 50;
export const PLAYLIST_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000;

const queryTimeoutMs = 3_000;

export interface PlaylistItemDocument {
    itemId: string;
    audioTrackId: string;
    addedAt: Date;
}

export interface PlaylistDocument {
    _id: ObjectId;
    ownerUserId: string;
    name: string;
    items: PlaylistItemDocument[];
    revision: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface PlaylistSummaryV1 {
    id: string;
    name: string;
    itemCount: number;
    artworkUrl: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
}

export interface PlaylistPageV1 {
    items: PlaylistSummaryV1[];
    nextCursor: string | null;
}

export interface PlaylistMembershipV1 {
    audioTrackId: string;
    playlistIds: string[];
}

export interface PlaylistMembershipPageV1 {
    items: PlaylistMembershipV1[];
}

export interface PlaylistListOptions {
    limit?: number;
    cursor?: string;
}

/** Carries only bounded fields needed to derive owner-scoped Playlist summaries. */
export interface PlaylistListRecord {
    _id: ObjectId;
    name: string;
    itemCount: number;
    artworkAudioTrackIds: string[];
    revision: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface PlaylistListResult {
    records: PlaylistListRecord[];
    nextCursor: string | null;
}

export type PlaylistMutationOperation =
    | 'playlist.create'
    | 'playlist.rename'
    | 'playlist.delete'
    | 'playlist.item.add'
    | 'playlist.item.remove'
    | 'playlist.item.reorder';

interface PlaylistCursor {
    version: 1;
    updatedAt: string;
    id: string;
}

interface PlaylistMutationReceiptResponse {
    statusCode: 200 | 201 | 204;
    kind: 'playlist' | 'deleted';
    playlistId: string;
    revision: number;
}

interface AccountMutationReceipt {
    _id: string;
    ownerUserId: string;
    idempotencyKeyHash: string;
    operation: PlaylistMutationOperation;
    targetId?: string;
    requestFingerprint: string;
    status: 'pending' | 'completed';
    response?: PlaylistMutationReceiptResponse;
    createdAt: Date;
    completedAt?: Date;
    expiresAt: Date;
}

export interface PlaylistMutationResult {
    statusCode: 200 | 201 | 204;
    playlist: PlaylistDocument | null;
    replayed: boolean;
}

/** Carries a bounded, client-safe Playlist failure without exposing database records. */
export class PlaylistError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string,
        public readonly details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'PlaylistError';
    }
}

const isObjectIdString = (value: unknown): value is string =>
    /^[0-9a-fA-F]{24}$/.test(String(value ?? '').trim());

export const normalizePlaylistObjectId = (value: unknown) => {
    const normalized = String(value ?? '').trim();
    return isObjectIdString(normalized)
        ? ObjectId.createFromHexString(normalized).toHexString()
        : null;
};

const safeDate = (value: unknown) => {
    const date = value instanceof Date ? value : new Date(String(value ?? ''));
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
};

/** Produces the allowlisted summary shared by list results and conflict errors. */
export const toPlaylistSummary = (
    playlist: Partial<PlaylistDocument> & { _id: unknown; itemCount?: unknown },
    artworkUrl = ''
): PlaylistSummaryV1 => ({
    id: String(playlist._id),
    name: String(playlist.name ?? ''),
    itemCount: Number.isSafeInteger(Number(playlist.itemCount))
        ? Math.max(0, Math.min(Number(playlist.itemCount), MAX_PLAYLIST_ITEMS))
        : Math.min(
            Array.isArray(playlist.items) ? playlist.items.length : 0,
            MAX_PLAYLIST_ITEMS
        ),
    artworkUrl,
    revision: Number.isSafeInteger(Number(playlist.revision))
        ? Math.max(1, Number(playlist.revision))
        : 1,
    createdAt: safeDate(playlist.createdAt).toISOString(),
    updatedAt: safeDate(playlist.updatedAt).toISOString()
});

const encodeCursor = (playlist: { _id: unknown; updatedAt?: unknown }) => Buffer.from(
    JSON.stringify({
        version: 1,
        updatedAt: safeDate(playlist.updatedAt).toISOString(),
        id: String(playlist._id)
    } satisfies PlaylistCursor),
    'utf8'
).toString('base64url');

/** Rejects malformed cursors instead of silently restarting a private listing. */
export const decodePlaylistCursor = (value?: string): PlaylistCursor | null => {
    if (!value) return null;
    if (value.length > 512) {
        throw new PlaylistError(400, 'invalid_request', 'Playlist cursor is invalid.');
    }
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as any;
        if (parsed?.version !== 1 || !normalizePlaylistObjectId(parsed?.id)) {
            throw new Error('Invalid cursor identity.');
        }
        const updatedAt = String(parsed?.updatedAt ?? '');
        if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
            throw new Error('Invalid cursor timestamp.');
        }
        return {
            version: 1,
            updatedAt: new Date(updatedAt).toISOString(),
            id: ObjectId.createFromHexString(String(parsed.id)).toHexString()
        };
    } catch {
        throw new PlaylistError(400, 'invalid_request', 'Playlist cursor is invalid.');
    }
};

const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(',')}}`;
};

/** Hashes the complete normalized request so one key cannot authorize different input. */
export const playlistRequestFingerprint = (
    operation: PlaylistMutationOperation,
    input: Record<string, unknown>
) => createHash('sha256')
    .update(canonicalJson({ operation, input }), 'utf8')
    .digest('hex');

const idempotencyKeyHash = (idempotencyKey: string) => createHash('sha256')
    .update(idempotencyKey, 'utf8')
    .digest('hex');

const receiptId = (ownerUserId: string, idempotencyKey: string) => createHash('sha256')
    .update(`${ownerUserId}\0${idempotencyKey}`, 'utf8')
    .digest('hex');

const revisionConflict = (playlist: PlaylistDocument) => new PlaylistError(
    409,
    'playlist_revision_conflict',
    'Playlist changed on another device.',
    {
        currentRevision: Number(playlist.revision),
        playlist: toPlaylistSummary(playlist)
    }
);

const notFound = () => new PlaylistError(
    404,
    'playlist_not_found',
    'Playlist was not found.'
);

const receiptOutcome = (
    receipt: AccountMutationReceipt | null,
    operation: PlaylistMutationOperation,
    requestFingerprint: string
) => {
    if (!receipt
        || receipt.operation !== operation
        || receipt.requestFingerprint !== requestFingerprint) {
        throw new PlaylistError(
            409,
            'idempotency_key_reused',
            'Idempotency key was reused for another operation.'
        );
    }
    if (receipt.status !== 'completed' || !receipt.response) {
        throw new PlaylistError(
            409,
            'idempotency_in_progress',
            'The Playlist operation is still in progress.'
        );
    }
    return receipt.response;
};

const touchActiveOwner = async (ownerUserId: string, session: ClientSession) => {
    const ownerId = normalizePlaylistObjectId(ownerUserId);
    if (!ownerId) {
        throw new PlaylistError(409, 'account_unavailable', 'The listener account is unavailable.');
    }
    const result = await getDb()!.collection('users').updateOne(
        { _id: ObjectId.createFromHexString(ownerId) },
        { $inc: { listenerMutationRevision: 1 } },
        { session }
    );
    if (result.matchedCount !== 1) {
        throw new PlaylistError(409, 'account_unavailable', 'The listener account is unavailable.');
    }
};

const loadOwnedForMutation = async (
    ownerUserId: string,
    playlistId: string,
    expectedRevision: number,
    session: ClientSession
) => {
    const playlist = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION).findOne(
        {
            _id: ObjectId.createFromHexString(playlistId),
            ownerUserId
        },
        { session, maxTimeMS: queryTimeoutMs }
    );
    if (!playlist) throw notFound();
    if (playlist.revision !== expectedRevision) throw revisionConflict(playlist);
    return playlist;
};

const resolveFailedConditionalWrite = async (
    ownerUserId: string,
    playlistId: string,
    expectedRevision: number,
    session: ClientSession
): Promise<never> => {
    const current = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION).findOne(
        {
            _id: ObjectId.createFromHexString(playlistId),
            ownerUserId
        },
        { session, maxTimeMS: queryTimeoutMs }
    );
    if (!current) throw notFound();
    if (current.revision !== expectedRevision) throw revisionConflict(current);
    throw new Error('Playlist conditional mutation did not modify its matched record.');
};

type ReceiptMutation = (session: ClientSession) => Promise<PlaylistMutationReceiptResponse>;

const executeReceiptMutation = async (
    ownerUserId: string,
    idempotencyKey: string,
    operation: PlaylistMutationOperation,
    requestFingerprint: string,
    targetId: string | undefined,
    mutate: ReceiptMutation
): Promise<PlaylistMutationResult> => {
    const _id = receiptId(ownerUserId, idempotencyKey);
    const receipts = getDb()!.collection<AccountMutationReceipt>(ACCOUNT_MUTATION_COLLECTION);
    const session = getDatabaseClient().startSession();
    let response: PlaylistMutationReceiptResponse | undefined;
    let replayed = false;

    try {
        try {
            await session.withTransaction(async () => {
                const existing = await receipts.findOne(
                    { _id },
                    { session, maxTimeMS: queryTimeoutMs }
                );
                if (existing) {
                    response = receiptOutcome(existing, operation, requestFingerprint);
                    replayed = true;
                    return;
                }

                const createdAt = new Date();
                await receipts.insertOne({
                    _id,
                    ownerUserId,
                    idempotencyKeyHash: idempotencyKeyHash(idempotencyKey),
                    operation,
                    ...(targetId ? { targetId } : {}),
                    requestFingerprint,
                    status: 'pending',
                    createdAt,
                    expiresAt: new Date(createdAt.getTime() + PLAYLIST_IDEMPOTENCY_WINDOW_MS)
                }, { session });

                response = await mutate(session);
                const completedAt = new Date();
                await receipts.updateOne(
                    { _id, status: 'pending' },
                    {
                        $set: {
                            status: 'completed',
                            response,
                            completedAt,
                            expiresAt: new Date(
                                completedAt.getTime() + PLAYLIST_IDEMPOTENCY_WINDOW_MS
                            )
                        }
                    },
                    { session }
                );
            });
        } catch (error: any) {
            if (error?.code !== 11000) throw error;
            response = receiptOutcome(
                await receipts.findOne({ _id }, { maxTimeMS: queryTimeoutMs }),
                operation,
                requestFingerprint
            );
            replayed = true;
        }
    } finally {
        await session.endSession();
    }

    if (!response) throw new Error('Playlist mutation completed without a receipt response.');
    if (response.kind === 'deleted') {
        return { statusCode: response.statusCode, playlist: null, replayed };
    }
    const playlist = await Playlist.findOwned(ownerUserId, response.playlistId);
    if (!playlist) throw notFound();
    return { statusCode: response.statusCode, playlist, replayed };
};

/** Owns private Playlist persistence, optimistic revisions, and replay-safe writes. */
export class Playlist {
    static async list(
        ownerUserId: string,
        options: PlaylistListOptions = {}
    ): Promise<PlaylistListResult> {
        const limit = Math.max(
            1,
            Math.min(
                Number.isFinite(options.limit) ? Math.floor(options.limit!) : DEFAULT_PLAYLIST_PAGE_SIZE,
                MAX_PLAYLIST_PAGE_SIZE
            )
        );
        const cursor = decodePlaylistCursor(options.cursor);
        const match: Record<string, unknown> = { ownerUserId };
        if (cursor) {
            const cursorDate = new Date(cursor.updatedAt);
            const cursorId = ObjectId.createFromHexString(cursor.id);
            match.$or = [
                { updatedAt: { $lt: cursorDate } },
                { updatedAt: cursorDate, _id: { $lt: cursorId } }
            ];
        }

        const records = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION)
            .aggregate<PlaylistListRecord>([
                { $match: match },
                { $sort: { updatedAt: -1, _id: -1 } },
                { $limit: limit + 1 },
                {
                    $project: {
                        name: 1,
                        itemCount: { $size: { $ifNull: ['$items', []] } },
                        artworkAudioTrackIds: {
                            $map: {
                                input: {
                                    $slice: [{ $ifNull: ['$items', []] }, MAX_PLAYLIST_ITEMS]
                                },
                                as: 'item',
                                in: '$$item.audioTrackId'
                            }
                        },
                        revision: 1,
                        createdAt: 1,
                        updatedAt: 1
                    }
                }
            ], { maxTimeMS: queryTimeoutMs })
            .toArray();
        const page = records.slice(0, limit);
        const last = page[page.length - 1];
        return {
            records: page,
            nextCursor: records.length > limit && last ? encodeCursor(last) : null
        };
    }

    static async findOwned(ownerUserId: string, playlistId: string) {
        const normalizedId = normalizePlaylistObjectId(playlistId);
        if (!normalizedId) return null;
        return getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION).findOne(
            {
                _id: ObjectId.createFromHexString(normalizedId),
                ownerUserId
            },
            { maxTimeMS: queryTimeoutMs }
        );
    }

    /** Resolves memberships for a bounded Soundtrack set without exposing Playlist metadata. */
    static async findMemberships(
        ownerUserId: string,
        audioTrackIds: string[]
    ): Promise<PlaylistMembershipPageV1> {
        const requestedIds = [...audioTrackIds].sort();
        const playlistIdsByTrack = new Map<string, Set<string>>(
            requestedIds.map((audioTrackId) => [audioTrackId, new Set<string>()])
        );
        const playlists = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION)
            .find(
                {
                    ownerUserId,
                    'items.audioTrackId': { $in: requestedIds }
                },
                {
                    projection: { _id: 1, 'items.audioTrackId': 1 },
                    maxTimeMS: queryTimeoutMs
                }
            )
            .sort({ _id: 1 })
            .toArray();

        for (const playlist of playlists) {
            const playlistId = playlist._id.toHexString();
            for (const item of Array.isArray(playlist.items) ? playlist.items : []) {
                playlistIdsByTrack.get(item.audioTrackId)?.add(playlistId);
            }
        }

        return {
            items: requestedIds.map((audioTrackId) => ({
                audioTrackId,
                playlistIds: [...(playlistIdsByTrack.get(audioTrackId) ?? [])].sort()
            }))
        };
    }

    static create(
        ownerUserId: string,
        name: string,
        idempotencyKey: string,
        requestFingerprint: string
    ) {
        const playlistId = new ObjectId();
        return executeReceiptMutation(
            ownerUserId,
            idempotencyKey,
            'playlist.create',
            requestFingerprint,
            undefined,
            async (session) => {
                await touchActiveOwner(ownerUserId, session);
                const count = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION)
                    .countDocuments(
                        { ownerUserId },
                        { session, limit: MAX_PLAYLISTS_PER_ACCOUNT, maxTimeMS: queryTimeoutMs }
                    );
                if (count >= MAX_PLAYLISTS_PER_ACCOUNT) {
                    throw new PlaylistError(
                        409,
                        'playlist_limit_reached',
                        `An account can have at most ${MAX_PLAYLISTS_PER_ACCOUNT} Playlists.`
                    );
                }
                const now = new Date();
                await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION).insertOne({
                    _id: playlistId,
                    ownerUserId,
                    name,
                    items: [],
                    revision: 1,
                    createdAt: now,
                    updatedAt: now
                }, { session });
                return {
                    statusCode: 201,
                    kind: 'playlist',
                    playlistId: playlistId.toHexString(),
                    revision: 1
                };
            }
        );
    }

    static rename(
        ownerUserId: string,
        playlistId: string,
        name: string,
        expectedRevision: number,
        idempotencyKey: string,
        requestFingerprint: string
    ) {
        return executeReceiptMutation(
            ownerUserId,
            idempotencyKey,
            'playlist.rename',
            requestFingerprint,
            playlistId,
            async (session) => {
                await touchActiveOwner(ownerUserId, session);
                await loadOwnedForMutation(ownerUserId, playlistId, expectedRevision, session);
                const updated = await getDb()!
                    .collection<PlaylistDocument>(PLAYLIST_COLLECTION)
                    .findOneAndUpdate(
                        {
                            _id: ObjectId.createFromHexString(playlistId),
                            ownerUserId,
                            revision: expectedRevision
                        },
                        {
                            $set: { name, updatedAt: new Date() },
                            $inc: { revision: 1 }
                        },
                        { session, returnDocument: 'after' }
                    );
                if (!updated.value) {
                    await resolveFailedConditionalWrite(
                        ownerUserId,
                        playlistId,
                        expectedRevision,
                        session
                    );
                }
                return {
                    statusCode: 200,
                    kind: 'playlist',
                    playlistId,
                    revision: expectedRevision + 1
                };
            }
        );
    }

    static delete(
        ownerUserId: string,
        playlistId: string,
        expectedRevision: number,
        idempotencyKey: string,
        requestFingerprint: string
    ) {
        return executeReceiptMutation(
            ownerUserId,
            idempotencyKey,
            'playlist.delete',
            requestFingerprint,
            playlistId,
            async (session) => {
                await touchActiveOwner(ownerUserId, session);
                await loadOwnedForMutation(ownerUserId, playlistId, expectedRevision, session);
                const removed = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION)
                    .deleteOne(
                        {
                            _id: ObjectId.createFromHexString(playlistId),
                            ownerUserId,
                            revision: expectedRevision
                        },
                        { session }
                    );
                if (removed.deletedCount !== 1) {
                    await resolveFailedConditionalWrite(
                        ownerUserId,
                        playlistId,
                        expectedRevision,
                        session
                    );
                }
                return {
                    statusCode: 204,
                    kind: 'deleted',
                    playlistId,
                    revision: expectedRevision
                };
            }
        );
    }

    static addItem(
        ownerUserId: string,
        playlistId: string,
        audioTrackId: string,
        position: number | undefined,
        expectedRevision: number,
        idempotencyKey: string,
        requestFingerprint: string
    ) {
        const itemId = randomUUID();
        return executeReceiptMutation(
            ownerUserId,
            idempotencyKey,
            'playlist.item.add',
            requestFingerprint,
            playlistId,
            async (session) => {
                await touchActiveOwner(ownerUserId, session);
                const playlist = await loadOwnedForMutation(
                    ownerUserId,
                    playlistId,
                    expectedRevision,
                    session
                );
                const currentItems = Array.isArray(playlist.items) ? [...playlist.items] : [];
                if (currentItems.some((item) => item.audioTrackId === audioTrackId)) {
                    return {
                        statusCode: 200,
                        kind: 'playlist',
                        playlistId,
                        revision: expectedRevision
                    };
                }
                if (currentItems.length >= MAX_PLAYLIST_ITEMS) {
                    throw new PlaylistError(
                        409,
                        'playlist_item_limit_reached',
                        `A Playlist can have at most ${MAX_PLAYLIST_ITEMS} Soundtracks.`
                    );
                }
                const insertAt = position === undefined ? currentItems.length : position;
                if (!Number.isSafeInteger(insertAt) || insertAt < 0 || insertAt > currentItems.length) {
                    throw new PlaylistError(
                        400,
                        'invalid_request',
                        'Playlist item position is outside the current order.'
                    );
                }

                const trackFence = await getDb()!.collection('audioTracks').updateOne(
                    {
                        _id: ObjectId.createFromHexString(audioTrackId),
                        ...readyAudioStorageFilter
                    },
                    { $inc: { playlistReferenceRevision: 1 } },
                    { session }
                );
                if (trackFence.matchedCount !== 1) {
                    throw new PlaylistError(
                        404,
                        'audio_track_not_found',
                        'A ready Soundtrack was not found.'
                    );
                }

                const nextItems = [...currentItems];
                nextItems.splice(insertAt, 0, { itemId, audioTrackId, addedAt: new Date() });
                const updated = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION)
                    .updateOne(
                        {
                            _id: ObjectId.createFromHexString(playlistId),
                            ownerUserId,
                            revision: expectedRevision
                        },
                        {
                            $set: { items: nextItems, updatedAt: new Date() },
                            $inc: { revision: 1 }
                        },
                        { session }
                    );
                if (updated.matchedCount !== 1) {
                    await resolveFailedConditionalWrite(
                        ownerUserId,
                        playlistId,
                        expectedRevision,
                        session
                    );
                }
                return {
                    statusCode: 200,
                    kind: 'playlist',
                    playlistId,
                    revision: expectedRevision + 1
                };
            }
        );
    }

    static removeItem(
        ownerUserId: string,
        playlistId: string,
        itemId: string,
        expectedRevision: number,
        idempotencyKey: string,
        requestFingerprint: string
    ) {
        return executeReceiptMutation(
            ownerUserId,
            idempotencyKey,
            'playlist.item.remove',
            requestFingerprint,
            playlistId,
            async (session) => {
                await touchActiveOwner(ownerUserId, session);
                const playlist = await loadOwnedForMutation(
                    ownerUserId,
                    playlistId,
                    expectedRevision,
                    session
                );
                const currentItems = Array.isArray(playlist.items) ? playlist.items : [];
                if (!currentItems.some((item) => item.itemId === itemId)) {
                    throw new PlaylistError(
                        404,
                        'playlist_item_not_found',
                        'Playlist item was not found.'
                    );
                }
                const updated = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION)
                    .updateOne(
                        {
                            _id: ObjectId.createFromHexString(playlistId),
                            ownerUserId,
                            revision: expectedRevision,
                            'items.itemId': itemId
                        },
                        {
                            $pull: { items: { itemId } },
                            $set: { updatedAt: new Date() },
                            $inc: { revision: 1 }
                        },
                        { session }
                    );
                if (updated.matchedCount !== 1) {
                    await resolveFailedConditionalWrite(
                        ownerUserId,
                        playlistId,
                        expectedRevision,
                        session
                    );
                }
                return {
                    statusCode: 200,
                    kind: 'playlist',
                    playlistId,
                    revision: expectedRevision + 1
                };
            }
        );
    }

    static reorderItems(
        ownerUserId: string,
        playlistId: string,
        itemIds: string[],
        expectedRevision: number,
        idempotencyKey: string,
        requestFingerprint: string
    ) {
        return executeReceiptMutation(
            ownerUserId,
            idempotencyKey,
            'playlist.item.reorder',
            requestFingerprint,
            playlistId,
            async (session) => {
                await touchActiveOwner(ownerUserId, session);
                const playlist = await loadOwnedForMutation(
                    ownerUserId,
                    playlistId,
                    expectedRevision,
                    session
                );
                const currentItems = Array.isArray(playlist.items) ? playlist.items : [];
                const byId = new Map(currentItems.map((item) => [item.itemId, item]));
                if (itemIds.length !== currentItems.length
                    || new Set(itemIds).size !== itemIds.length
                    || itemIds.some((itemId) => !byId.has(itemId))) {
                    throw new PlaylistError(
                        400,
                        'invalid_playlist_order',
                        'Playlist order must contain every current item ID exactly once.'
                    );
                }
                const nextItems = itemIds.map((itemId) => byId.get(itemId)!);
                const updated = await getDb()!.collection<PlaylistDocument>(PLAYLIST_COLLECTION)
                    .updateOne(
                        {
                            _id: ObjectId.createFromHexString(playlistId),
                            ownerUserId,
                            revision: expectedRevision
                        },
                        {
                            $set: { items: nextItems, updatedAt: new Date() },
                            $inc: { revision: 1 }
                        },
                        { session }
                    );
                if (updated.matchedCount !== 1) {
                    await resolveFailedConditionalWrite(
                        ownerUserId,
                        playlistId,
                        expectedRevision,
                        session
                    );
                }
                return {
                    statusCode: 200,
                    kind: 'playlist',
                    playlistId,
                    revision: expectedRevision + 1
                };
            }
        );
    }
}
