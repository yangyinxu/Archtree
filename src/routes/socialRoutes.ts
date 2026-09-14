import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { createSocialService } from '../application/social/socialService';
import {
    exactSocialKeys, isSocialId, normalizeSocialHandle, parseSocialCommand, SOCIAL_LIMITS,
    SocialActor, SocialApi, SocialCard, SocialError, SocialListKind, SocialOutcome
} from '../contracts/socialV1';
import { MUSIC_SHARE_LIMITS, type MusicShareDirection } from '../contracts/socialMusicV1';
import { LISTENING_LIMITS, parseListeningReport } from '../contracts/listeningV1';
import {
    AuthenticatedRequest, requireAuth, requireCurrentAccountViewer
} from '../middleware/authMiddleware';
import {
    asyncHandler, limitConcurrency, rateLimit, requireSecureAuthTransport
} from '../middleware/requestProtectionMiddleware';

interface SocialRouterOptions {
    api?: SocialApi;
    /** Tests can supply identity; production always uses database-backed authentication. */
    authenticate?: RequestHandler;
}

const invalid = () => new SocialError(400, 'invalid_request');
const actor = (req: Request): SocialActor => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId || !auth.sessionId) throw new SocialError(401, 'session_required');
    return { userId: auth.userId, sessionId: auth.sessionId };
};
const noQuery = (req: Request) => {
    if (!exactSocialKeys(req.query, [])) throw invalid();
};
const card = (value: SocialCard | null) => value === null ? null : ({
    socialId: value.socialId, handle: value.handle, alias: value.alias, iconSeed: value.iconSeed
});
const outcome = (value: SocialOutcome | null) => value === null ? null : ({
    commandId: value.commandId, outcome: value.outcome, replayed: value.replayed,
    ...(value.code === undefined ? {} : { code: value.code })
});

/** Owns additive social HTTP boundaries without exposing persisted account or relationship records. */
export const createSocialRouter = (options: SocialRouterOptions = {}): Router => {
    const router = express.Router();
    const api = options.api ?? createSocialService();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Pragma', 'no-cache');
        res.vary('Cookie');
        res.vary('Authorization');
        res.vary('X-Finitude-Account-Viewer');
        next();
    });
    router.use(requireSecureAuthTransport, rateLimit('social-api', 120, 60_000,
        (_req, res) => res.status(429).json({ code: 'rate_limited', message: 'Too many requests. Please try again later.' })));
    router.use(options.authenticate ?? requireAuth, requireCurrentAccountViewer);
    router.use((req, res, next) => {
        try { actor(req); } catch (error) { return next(error); }
        // The viewer guard writes its generic privacy header; restore the stricter shared contract.
        res.setHeader('Cache-Control', 'private, no-store');
        next();
    });
    const mutationCapacity = limitConcurrency('social-mutation', 4, 32);
    router.use((req, res, next) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        if (!req.is('application/json')) return next(new SocialError(415, 'json_required'));
        return mutationCapacity(req, res, next);
    });
    router.use(express.json({ limit: '4kb', strict: true }));

    router.post('/mutation-scopes', asyncHandler(async (req, res) => {
        noQuery(req);
        if (!exactSocialKeys(req.body, [])) throw invalid();
        const scope = await api.issueScope(actor(req));
        res.status(200).json({ scopeToken: scope.scopeToken, expiresAt: scope.expiresAt });
    }));
    router.post('/mutation-outcomes', asyncHandler(async (req, res) => {
        noQuery(req);
        if (!exactSocialKeys(req.body, ['scopeToken', 'commandId'])) throw invalid();
        // The domain verifies the scope signature while deliberately allowing expired-scope lookup.
        const identity = parseSocialCommand({ ...req.body, action: 'deactivate' });
        if (!identity) throw invalid();
        const result = await api.outcome(actor(req), {
            scopeToken: identity.scopeToken, commandId: identity.commandId
        });
        res.status(200).json({ outcome: outcome(result) });
    }));
    router.get('/me/profile', asyncHandler(async (req, res) => {
        noQuery(req);
        const profile = await api.ownProfile(actor(req));
        res.status(200).json({ profile: profile === null ? null : {
            ...card(profile), active: profile.active, discoverable: profile.discoverable, revision: profile.revision
        } });
    }));
    router.get('/me/listening', asyncHandler(async (req, res) => {
        noQuery(req);
        const value = await api.ownListening(actor(req));
        res.json({ listening: { enabled: value.enabled, revision: value.revision,
            publisherRevision: value.publisherRevision, serverTimeMs: value.serverTimeMs } });
    }));
    router.post('/listening-publications/report', asyncHandler(async (req, res) => {
        noQuery(req);
        const report = parseListeningReport(req.body); if (!report) throw invalid();
        const value = await api.reportListening(actor(req), report);
        res.json({ accepted: value.accepted, serverTimeMs: value.serverTimeMs, expiresAtMs: value.expiresAtMs });
    }));
    router.post('/listening-status/query', asyncHandler(async (req, res) => {
        noQuery(req);
        if (!exactSocialKeys(req.body, ['socialIds']) || !Array.isArray(req.body.socialIds) || !req.body.socialIds.length
            || req.body.socialIds.length > LISTENING_LIMITS.query || !req.body.socialIds.every(isSocialId)
            || new Set(req.body.socialIds).size !== req.body.socialIds.length) throw invalid();
        const values = await api.listeningStatuses(actor(req), [...req.body.socialIds]);
        res.json({ items: values.map(value => ({ peer: card(value.peer), expiresAtMs: value.expiresAtMs,
            track: { id: value.track.id, contentType: value.track.contentType, title: value.track.title,
                artworkUrl: value.track.artworkUrl, artistNames: value.track.artistNames } })) });
    }));
    router.get('/profiles', asyncHandler(async (req, res) => {
        if (!exactSocialKeys(req.query, ['handle'])) throw invalid();
        const handle = normalizeSocialHandle(req.query.handle);
        if (!handle) throw invalid();
        res.status(200).json({ profile: card(await api.lookup(actor(req), handle)) });
    }));
    router.get('/relationships', asyncHandler(async (req, res) => {
        if (!Object.keys(req.query).every(key => ['kind', 'limit', 'cursor'].includes(key))
            || typeof req.query.kind !== 'string'
            || !['friends', 'incoming', 'outgoing', 'blocks'].includes(req.query.kind)) throw invalid();
        const rawLimit = req.query.limit;
        if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit))) throw invalid();
        const limit = rawLimit === undefined ? SOCIAL_LIMITS.page : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOCIAL_LIMITS.maximumPage) throw invalid();
        const cursor = req.query.cursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length < 1
            || Buffer.byteLength(cursor, 'utf8') > 512 || !/^[A-Za-z0-9_.-]+$/.test(cursor))) throw invalid();
        const page = await api.list(actor(req), req.query.kind as SocialListKind, limit, cursor as string | undefined);
        res.status(200).json({ items: page.items.map(row => ({
            socialId: row.socialId, profile: card(row.profile), revision: row.revision
        })), nextCursor: page.nextCursor });
    }));
    router.get('/relationships/:socialId', asyncHandler(async (req, res) => {
        noQuery(req);
        if (!isSocialId(req.params.socialId)) throw invalid();
        const relationship = await api.relationship(actor(req), req.params.socialId);
        res.status(200).json({ relationship: relationship === null ? null : {
            socialId: relationship.socialId, state: relationship.state, revision: relationship.revision
        } });
    }));
    router.get('/music-shares', asyncHandler(async (req, res) => {
        if (!Object.keys(req.query).every(key => ['direction', 'limit', 'cursor'].includes(key))
            || typeof req.query.direction !== 'string' || !['incoming', 'outgoing'].includes(req.query.direction)) throw invalid();
        const rawLimit = req.query.limit;
        if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit))) throw invalid();
        const limit = rawLimit === undefined ? MUSIC_SHARE_LIMITS.page : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MUSIC_SHARE_LIMITS.maximumPage) throw invalid();
        const cursor = req.query.cursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || !cursor.length || Buffer.byteLength(cursor) > 512 || !/^[A-Za-z0-9_.-]+$/.test(cursor))) throw invalid();
        const page = await api.musicShares(actor(req), req.query.direction as MusicShareDirection, limit, cursor as string | undefined);
        res.json({ items: page.items.map(value => ({ shareId: value.shareId, peer: card(value.peer), contentType: value.contentType,
            contentId: value.contentId, createdAtMs: value.createdAtMs, expiresAtMs: value.expiresAtMs,
            content: value.content === null ? null : { id: value.content.id, contentType: value.content.contentType,
                title: value.content.title, artworkUrl: value.content.artworkUrl, artistNames: value.content.artistNames } })), nextCursor: page.nextCursor });
    }));

    const mutate = (action: string, keys: string[], targetFromPath = false, shareFromPath = false) => async (req: Request, res: Response) => {
        noQuery(req);
        if (!exactSocialKeys(req.body, ['scopeToken', 'commandId', ...keys])) throw invalid();
        const command = parseSocialCommand({
            ...req.body, action, ...(targetFromPath ? { targetSocialId: req.params.socialId } : {}), ...(shareFromPath ? { shareId: req.params.shareId } : {})
        });
        if (!command) throw invalid();
        // A durable rejected receipt is still a successful outcome response. Transport errors stay non-2xx.
        res.status(200).json(outcome(await api.mutate(actor(req), command)));
    };
    router.patch('/me/profile', asyncHandler(mutate('profile', ['handle', 'alias', 'discoverable', 'expectedRevision'])));
    router.patch('/me/listening', asyncHandler(mutate('setListeningSharing', ['enabled', 'expectedRevision'])));
    router.post('/listening-publications/claim', asyncHandler(mutate('claimListening', ['clientId', 'expectedPreferenceRevision', 'expectedPublisherRevision'])));
    router.post('/me/deactivate', asyncHandler(mutate('deactivate', [])));
    router.post('/friend-requests', asyncHandler(mutate('request', ['targetSocialId', 'expectedRevision'])));
    router.post('/music-shares', asyncHandler(mutate('shareMusic', ['targetSocialId', 'expectedRevision', 'contentType', 'contentId'])));
    router.post('/music-shares/:shareId/dismiss', asyncHandler(mutate('dismissMusicShare', [], false, true)));
    router.post('/music-shares/:shareId/withdraw', asyncHandler(mutate('withdrawMusicShare', [], false, true)));
    for (const action of ['accept', 'decline', 'cancel', 'remove', 'block', 'unblock']) {
        router.post(`/relationships/:socialId/${action}`,
            asyncHandler(mutate(action, action === 'block' ? [] : ['expectedRevision'], true)));
    }
    // Never fall through to an unrelated router or HTML document for a private API miss.
    router.use((_req, _res, next) => next(new SocialError(404, 'not_found')));
    router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) return next(error);
        const parserError = error as { type?: string; status?: number } | undefined;
        const known = error instanceof SocialError ? error
            : parserError?.type === 'entity.too.large' ? new SocialError(413, 'request_too_large')
                : parserError?.type === 'entity.parse.failed' ? invalid() : null;
        if (!known) return next(error);
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(known.statusCode).json({ code: known.code, message: known.message });
    });
    return router;
};
