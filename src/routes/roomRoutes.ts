import express, { type NextFunction, type Request, type Response } from 'express';
import { createRoomService } from '../application/rooms/roomService';
import { isRoomClientId, isRoomIdentifier, normalizeRoomMediaQuery, parseRoomCommand, ROOM_LIMITS, ROOM_MEDIA_DISCOVERY_LIMITS, type RoomActor, type RoomApi } from '../contracts/roomV1';
import { exactSocialKeys, SocialError } from '../contracts/socialV1';
import { socialCapacity, type SocialCapacity } from '../config/socialCapacity';
import { requireAuth, requireCurrentAccountViewer, type AuthenticatedRequest } from '../middleware/authMiddleware';
import { asyncHandler, limitConcurrency, rateLimit, requireSecureAuthTransport } from '../middleware/requestProtectionMiddleware';
import { realtimeSeats, type RealtimeSeatCheck } from '../realtime/realtimeSeats';
import { issueRoomTicket } from '../realtime/roomTickets';
import { socialOperations, type SocialOperations, type TicketFailureKind } from '../realtime/socialOperations';

const invalid = () => new SocialError(400, 'invalid_request');
const actor = (req: Request, clientId = req.get('X-Finitude-Room-Client')): RoomActor => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.sessionId) throw new SocialError(401, 'session_required');
    if (!isRoomClientId(clientId)) throw invalid();
    return { userId: auth.userId, sessionId: auth.sessionId, clientId };
};

export interface RoomRouterOptions {
    capacity?: SocialCapacity;
    /** The gateway's seat rule; defaults to the installed gateway's. */
    seatCheck?: RealtimeSeatCheck;
    issueTicket?: typeof issueRoomTicket;
    operations?: SocialOperations;
}
/** Clients wait this long before asking for another realtime ticket while every seat is taken. */
export const REALTIME_CAPACITY_RETRY_SECONDS = 30;

const ticketFailure = (error: unknown): TicketFailureKind => error instanceof SocialError && error.code === 'ticket_limit' ? 'limit'
    : error instanceof SocialError && error.statusCode === 401 ? 'session' : 'unavailable';

/** Room endpoints precede the smaller social parser and return only current authorized projections. */
export const createRoomRouter = (api: RoomApi = createRoomService(), options: RoomRouterOptions = {}) => {
    const capacity = options.capacity ?? socialCapacity();
    const seatCheck = options.seatCheck ?? realtimeSeats.check;
    const issueTicket = options.issueTicket ?? issueRoomTicket;
    const operations = options.operations ?? socialOperations;
    const router = express.Router();
    router.use((req, _res, next) => /^\/(rooms(?:\/|$)|room-commands$|room-invitations(?:\/|$)|room-media(?:\/|$)|realtime-tickets$|capabilities$)/.test(req.path) ? next() : next('router'));
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization');
        res.vary('X-Finitude-Account-Viewer'); res.vary('X-Finitude-Room-Client'); next(); });
    router.use(requireSecureAuthTransport, rateLimit('room-http', 180, 60_000), requireAuth, requireCurrentAccountViewer);
    router.use((req, _res, next) => {
        if (!(req.method === 'GET' || req.method === 'HEAD') || !/^\/room-media\/search\/?$/.test(req.path)) {
            if (!exactSocialKeys(req.query, [])) return next(invalid());
        }
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        if (!req.is('application/json')) return next(new SocialError(415, 'json_required'));
        next();
    });
    // Reads cannot occupy the entire shared pool; commands and tickets still obey its original ceiling.
    const readConcurrency = limitConcurrency('room-http-read', 4, 40);
    router.use((req, res, next) => req.method === 'GET' || req.method === 'HEAD'
        ? readConcurrency(req, res, next) : next());
    router.use(limitConcurrency('room-http', 6, 48), express.json({ limit: ROOM_LIMITS.commandBytes, strict: true }));
    router.get('/capabilities', (_req, res) => res.json({ socialEnabled: process.env.FINITUDE_SOCIAL_ENABLED === 'true',
        roomsEnabled: process.env.FINITUDE_SOCIAL_ENABLED === 'true' && process.env.FINITUDE_ROOMS_ENABLED === 'true' }));
    router.get('/rooms/current', asyncHandler(async (req, res) => { res.json({ room: await api.currentRoom(actor(req)) }); }));
    router.get('/rooms/:roomId', asyncHandler(async (req, res) => {
        if (!isRoomIdentifier(req.params.roomId)) throw invalid();
        res.json({ room: await api.room(actor(req), req.params.roomId) });
    }));
    router.get('/rooms/:roomId/invitations', asyncHandler(async (req, res) => {
        if (!isRoomIdentifier(req.params.roomId)) throw invalid();
        res.json({ invitations: await api.outgoingInvitations(actor(req), req.params.roomId) });
    }));
    router.get('/rooms/:roomId/community', asyncHandler(async (req, res) => {
        if (!isRoomIdentifier(req.params.roomId)) throw invalid();
        res.json({ community: await api.community(actor(req), req.params.roomId) });
    }));
    router.get('/room-invitations', asyncHandler(async (req, res) => { res.json({ invitations: await api.invitations(actor(req)) }); }));
    router.get('/room-invitations/:invitationId', asyncHandler(async (req, res) => {
        if (!isRoomIdentifier(req.params.invitationId)) throw invalid();
        res.json({ invitation: await api.invitation(actor(req), req.params.invitationId) });
    }));
    router.get('/room-media', asyncHandler(async (req, res) => { res.json({ items: await api.eligibleMedia(actor(req)) }); }));
    router.get('/room-media/search', asyncHandler(async (req, res) => {
        if (!Object.keys(req.query).every(key => ['q', 'cursor', 'limit'].includes(key))) throw invalid();
        const query = normalizeRoomMediaQuery(req.query.q), rawLimit = req.query.limit, cursor = req.query.cursor;
        if (query === null || rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit))
            || cursor !== undefined && (typeof cursor !== 'string' || !cursor.length || Buffer.byteLength(cursor) > ROOM_MEDIA_DISCOVERY_LIMITS.cursorBytes)) throw invalid();
        const limit = rawLimit === undefined ? ROOM_MEDIA_DISCOVERY_LIMITS.page : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > ROOM_MEDIA_DISCOVERY_LIMITS.maximumPage) throw invalid();
        res.json(await api.searchMedia(actor(req), { query, cursor, limit }));
    }));
    router.get('/room-media/:mediaTrackId', asyncHandler(async (req, res) => {
        if (!/^[a-f0-9]{24}$/.test(req.params.mediaTrackId)) throw invalid();
        res.json({ item: await api.mediaTrack(actor(req), req.params.mediaTrackId) });
    }));
    router.post('/room-commands', asyncHandler(async (req, res) => {
        const command = parseRoomCommand(req.body);
        if (!command) throw invalid();
        const outcome = await api.mutate(actor(req), command);
        res.json(outcome);
    }));
    router.post('/realtime-tickets', asyncHandler(async (req, res) => {
        if (process.env.FINITUDE_SOCIAL_ENABLED !== 'true' || process.env.FINITUDE_ROOMS_ENABLED !== 'true') throw new SocialError(503, 'rooms_disabled');
        if (!exactSocialKeys(req.body, ['clientId']) || !isRoomClientId(req.body.clientId)) throw invalid();
        if (req.get('X-Finitude-Room-Client') && req.get('X-Finitude-Room-Client') !== req.body.clientId) throw invalid();
        const origin = new URL(`${req.protocol}://${req.get('Host')}`).origin;
        const viewer = actor(req, req.body.clientId);
        // Refusing before issuance spends no ticket transaction; the upgrade rechecks the same rule. Both
        // refusals share one client response: the tab waits, and can still create or join a room meanwhile.
        const refusal = await seatCheck(viewer);
        if (refusal) {
            operations.recordTicketFailure(refusal);
            if (refusal === 'capacity') operations.recordCapacityRejection('sockets', capacity.maxRealtimeSockets);
            res.setHeader('Retry-After', String(REALTIME_CAPACITY_RETRY_SECONDS));
            throw new SocialError(503, 'realtime_capacity');
        }
        try { res.json(await issueTicket(viewer, origin)); } catch (error) { operations.recordTicketFailure(ticketFailure(error)); throw error; }
    }));
    router.use((_req, _res, next) => next(new SocialError(404, 'not_found')));
    router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent || res.destroyed || res.writableEnded) return next(error);
        const parser = error as { type?: string };
        const known = error instanceof SocialError ? error : parser?.type === 'entity.too.large'
            ? new SocialError(413, 'request_too_large') : parser?.type === 'entity.parse.failed' ? invalid() : null;
        if (!known) return next(error);
        if (known.statusCode === 429 || known.statusCode === 503) operations.recordRejection(known.code);
        res.status(known.statusCode).json({ code: known.code, message: known.message });
    });
    return router;
};
