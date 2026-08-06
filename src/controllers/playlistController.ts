import { NextFunction, Request, RequestHandler, Response } from 'express';

import { AuthenticatedRequest } from '../middleware/authMiddleware';
import {
    DEFAULT_PLAYLIST_PAGE_SIZE,
    MAX_PLAYLIST_ITEMS,
    MAX_PLAYLIST_MEMBERSHIP_TRACK_IDS,
    MAX_PLAYLIST_PAGE_SIZE,
    Playlist,
    PlaylistError,
    PlaylistMutationOperation,
    normalizePlaylistObjectId,
    playlistRequestFingerprint
} from '../models/playlist';
import { toPlaylistDetail, toPlaylistPage } from '../services/playlistProjectionService';
import { isPlaylistFeatureEnabled } from '../services/playlistFeatureService';

const validItemId = /^[A-Za-z0-9-]{1,64}$/;
const controlCharacters = /[\u0000-\u001F\u007F]/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (body: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(body).every((key) => keys.includes(key));

const invalidRequest = (message: string, code = 'invalid_request') =>
    new PlaylistError(400, code, message);

const playlistNotFound = () => new PlaylistError(
    404,
    'playlist_not_found',
    'Playlist was not found.'
);

/** Normalizes one bounded, control-character-free user-visible Playlist name. */
export const parsePlaylistName = (value: unknown) => {
    if (typeof value !== 'string') {
        throw invalidRequest('Playlist name must be a string.', 'invalid_playlist_name');
    }
    const name = value.normalize('NFC').trim();
    const length = [...name].length;
    if (length < 1 || length > 100 || controlCharacters.test(name)) {
        throw invalidRequest(
            'Playlist name must contain 1 to 100 Unicode characters.',
            'invalid_playlist_name'
        );
    }
    return name;
};

/** Requires a bounded key while retaining only its hash in persistence. */
export const parseIdempotencyKey = (req: Request) => {
    const key = String(req.get('Idempotency-Key') ?? '').trim();
    if (!key) {
        throw new PlaylistError(
            428,
            'idempotency_key_required',
            'Idempotency-Key is required for Playlist mutations.'
        );
    }
    if (key.length > 128 || controlCharacters.test(key)) {
        throw invalidRequest('Idempotency-Key is invalid.', 'invalid_idempotency_key');
    }
    return key;
};

/** Accepts only the advertised quoted decimal revision ETag form. */
export const parsePlaylistRevision = (req: Request) => {
    const raw = String(req.get('If-Match') ?? '').trim();
    if (!raw) {
        throw new PlaylistError(
            428,
            'playlist_revision_required',
            'If-Match is required for this Playlist mutation.'
        );
    }
    const match = /^"([1-9]\d*)"$/.exec(raw);
    const revision = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(revision)) {
        throw invalidRequest(
            'If-Match must contain a quoted positive Playlist revision.',
            'invalid_playlist_revision'
        );
    }
    return revision;
};

const parsePlaylistId = (value: unknown) => {
    const id = normalizePlaylistObjectId(value);
    if (!id) throw playlistNotFound();
    return id;
};

const parseItemId = (value: unknown) => {
    const itemId = String(value ?? '').trim();
    if (!validItemId.test(itemId)) {
        throw new PlaylistError(
            404,
            'playlist_item_not_found',
            'Playlist item was not found.'
        );
    }
    return itemId;
};

const parseExactBody = (value: unknown, keys: readonly string[]) => {
    if (!isRecord(value) || !hasOnlyKeys(value, keys)) {
        throw invalidRequest('Playlist request body is invalid.');
    }
    return value;
};

const mutationFingerprint = (
    operation: PlaylistMutationOperation,
    input: Record<string, unknown>
) => playlistRequestFingerprint(operation, input);

const setPlaylistEtag = (res: Response, revision: number) => {
    res.setHeader('ETag', `"${revision}"`);
};

const sendPlaylistError = (res: Response, error: PlaylistError) => res
    .status(error.statusCode)
    .json({ code: error.code, message: error.message, ...error.details });

type PlaylistAction = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) => Promise<unknown>;

const playlistHandler = (action: PlaylistAction): RequestHandler => async (req, res, next) => {
    try {
        await action(req as AuthenticatedRequest, res, next);
    } catch (error) {
        if (error instanceof PlaylistError) {
            sendPlaylistError(res, error);
            return;
        }
        next(error);
    }
};

/** Adds private cache boundaries to every owner-scoped Playlist response. */
export const setPlaylistPrivacyHeaders: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    res.vary('Cookie');
    res.vary('Authorization');
    next();
};

/** Allows an emergency rollout stop without deleting private Playlist data. */
export const requirePlaylistFeature: RequestHandler = (_req, res, next) => {
    if (!isPlaylistFeatureEnabled()) {
        return res.status(503).json({
            code: 'playlist_unavailable',
            message: 'Playlists are temporarily unavailable.'
        });
    }
    return next();
};

/** Binds every cookie-authenticated private Playlist request to the Web tab's viewer. */
export const requirePlaylistCurrentViewer: RequestHandler = (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.get('Authorization')?.startsWith('Bearer ')) return next();
    const auth = (req as AuthenticatedRequest).auth;
    const requestedViewer = String(req.get('X-Finitude-Account-Viewer') ?? '').trim();
    if (!auth || !requestedViewer || requestedViewer !== auth.userId) {
        return res.status(409).json({
            code: 'account_viewer_mismatch',
            message: 'The active account changed. Refresh the account before trying again.'
        });
    }
    return next();
};

export const listPlaylists = playlistHandler(async (req, res) => {
    const rawLimit = req.query.limit;
    if (Array.isArray(rawLimit) || (rawLimit !== undefined && typeof rawLimit !== 'string')) {
        throw invalidRequest('Playlist limit is invalid.');
    }
    const requestedLimit = rawLimit === undefined ? DEFAULT_PLAYLIST_PAGE_SIZE : Number(rawLimit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
        throw invalidRequest('Playlist limit must be a positive integer.');
    }
    const rawCursor = req.query.cursor;
    if (Array.isArray(rawCursor) || (rawCursor !== undefined && typeof rawCursor !== 'string')) {
        throw invalidRequest('Playlist cursor is invalid.');
    }
    const ownerPage = await Playlist.list(req.auth!.userId, {
        limit: Math.min(requestedLimit, MAX_PLAYLIST_PAGE_SIZE),
        cursor: rawCursor
    });
    const page = await toPlaylistPage(ownerPage);
    return res.status(200).json(page);
});

/** Returns owner-only Playlist IDs for a bounded, strictly validated Soundtrack set. */
export const getPlaylistMemberships = playlistHandler(async (req, res) => {
    if (Object.keys(req.query).length !== 1
        || !Object.prototype.hasOwnProperty.call(req.query, 'audioTrackIds')) {
        throw invalidRequest(
            'Playlist membership query must contain only audioTrackIds.',
            'invalid_audio_track_ids'
        );
    }
    const rawAudioTrackIds = req.query.audioTrackIds;
    if (typeof rawAudioTrackIds !== 'string' || !rawAudioTrackIds.trim()) {
        throw invalidRequest(
            'audioTrackIds must be a comma-separated list of Soundtrack IDs.',
            'invalid_audio_track_ids'
        );
    }
    const values = rawAudioTrackIds.split(',').map((value) => value.trim());
    if (values.length > MAX_PLAYLIST_MEMBERSHIP_TRACK_IDS) {
        throw invalidRequest(
            `At most ${MAX_PLAYLIST_MEMBERSHIP_TRACK_IDS} Soundtrack IDs may be requested.`,
            'invalid_audio_track_ids'
        );
    }
    const audioTrackIds = values.map(normalizePlaylistObjectId);
    if (audioTrackIds.some((value) => value === null)
        || new Set(audioTrackIds).size !== audioTrackIds.length) {
        throw invalidRequest(
            'audioTrackIds must contain unique valid Soundtrack IDs.',
            'invalid_audio_track_ids'
        );
    }
    const memberships = await Playlist.findMemberships(
        req.auth!.userId,
        audioTrackIds as string[]
    );
    return res.status(200).json(memberships);
});

export const createPlaylist = playlistHandler(async (req, res) => {
    const body = parseExactBody(req.body, ['name']);
    const name = parsePlaylistName(body.name);
    const idempotencyKey = parseIdempotencyKey(req);
    const result = await Playlist.create(
        req.auth!.userId,
        name,
        idempotencyKey,
        mutationFingerprint('playlist.create', { name })
    );
    const detail = await toPlaylistDetail(result.playlist!);
    setPlaylistEtag(res, detail.revision);
    return res.status(result.statusCode).json(detail);
});

export const getPlaylist = playlistHandler(async (req, res) => {
    const playlistId = parsePlaylistId(req.params.playlistId);
    const playlist = await Playlist.findOwned(req.auth!.userId, playlistId);
    if (!playlist) throw playlistNotFound();
    const detail = await toPlaylistDetail(playlist);
    setPlaylistEtag(res, detail.revision);
    return res.status(200).json(detail);
});

export const renamePlaylist = playlistHandler(async (req, res) => {
    const playlistId = parsePlaylistId(req.params.playlistId);
    const body = parseExactBody(req.body, ['name']);
    const name = parsePlaylistName(body.name);
    const idempotencyKey = parseIdempotencyKey(req);
    const expectedRevision = parsePlaylistRevision(req);
    const result = await Playlist.rename(
        req.auth!.userId,
        playlistId,
        name,
        expectedRevision,
        idempotencyKey,
        mutationFingerprint('playlist.rename', { playlistId, name, expectedRevision })
    );
    const detail = await toPlaylistDetail(result.playlist!);
    setPlaylistEtag(res, detail.revision);
    return res.status(200).json(detail);
});

export const deletePlaylist = playlistHandler(async (req, res) => {
    const playlistId = parsePlaylistId(req.params.playlistId);
    parseExactBody(req.body ?? {}, []);
    const idempotencyKey = parseIdempotencyKey(req);
    const expectedRevision = parsePlaylistRevision(req);
    await Playlist.delete(
        req.auth!.userId,
        playlistId,
        expectedRevision,
        idempotencyKey,
        mutationFingerprint('playlist.delete', { playlistId, expectedRevision })
    );
    return res.status(204).send();
});

export const addPlaylistItem = playlistHandler(async (req, res) => {
    const playlistId = parsePlaylistId(req.params.playlistId);
    const body = parseExactBody(req.body, ['audioTrackId', 'position']);
    const audioTrackId = normalizePlaylistObjectId(body.audioTrackId);
    if (!audioTrackId) {
        throw new PlaylistError(
            404,
            'audio_track_not_found',
            'A ready Soundtrack was not found.'
        );
    }
    let position: number | undefined;
    if (body.position !== undefined) {
        if (!Number.isSafeInteger(body.position)
            || Number(body.position) < 0
            || Number(body.position) > MAX_PLAYLIST_ITEMS) {
            throw invalidRequest('Playlist item position must be a non-negative integer.');
        }
        position = Number(body.position);
    }
    const idempotencyKey = parseIdempotencyKey(req);
    const expectedRevision = parsePlaylistRevision(req);
    const result = await Playlist.addItem(
        req.auth!.userId,
        playlistId,
        audioTrackId,
        position,
        expectedRevision,
        idempotencyKey,
        mutationFingerprint('playlist.item.add', {
            playlistId,
            audioTrackId,
            position: position ?? null,
            expectedRevision
        })
    );
    const detail = await toPlaylistDetail(result.playlist!);
    setPlaylistEtag(res, detail.revision);
    return res.status(200).json(detail);
});

export const removePlaylistItem = playlistHandler(async (req, res) => {
    const playlistId = parsePlaylistId(req.params.playlistId);
    const itemId = parseItemId(req.params.itemId);
    parseExactBody(req.body ?? {}, []);
    const idempotencyKey = parseIdempotencyKey(req);
    const expectedRevision = parsePlaylistRevision(req);
    const result = await Playlist.removeItem(
        req.auth!.userId,
        playlistId,
        itemId,
        expectedRevision,
        idempotencyKey,
        mutationFingerprint('playlist.item.remove', {
            playlistId,
            itemId,
            expectedRevision
        })
    );
    const detail = await toPlaylistDetail(result.playlist!);
    setPlaylistEtag(res, detail.revision);
    return res.status(200).json(detail);
});

export const reorderPlaylistItems = playlistHandler(async (req, res) => {
    const playlistId = parsePlaylistId(req.params.playlistId);
    const body = parseExactBody(req.body, ['itemIds']);
    if (!Array.isArray(body.itemIds) || body.itemIds.length > MAX_PLAYLIST_ITEMS) {
        throw invalidRequest(
            'Playlist order must contain at most 500 item IDs.',
            'invalid_playlist_order'
        );
    }
    const itemIds = body.itemIds.map((value) => String(value ?? '').trim());
    if (itemIds.some((itemId) => !validItemId.test(itemId))
        || new Set(itemIds).size !== itemIds.length) {
        throw invalidRequest(
            'Playlist order must contain unique valid item IDs.',
            'invalid_playlist_order'
        );
    }
    const idempotencyKey = parseIdempotencyKey(req);
    const expectedRevision = parsePlaylistRevision(req);
    const result = await Playlist.reorderItems(
        req.auth!.userId,
        playlistId,
        itemIds,
        expectedRevision,
        idempotencyKey,
        mutationFingerprint('playlist.item.reorder', {
            playlistId,
            itemIds,
            expectedRevision
        })
    );
    const detail = await toPlaylistDetail(result.playlist!);
    setPlaylistEtag(res, detail.revision);
    return res.status(200).json(detail);
});
