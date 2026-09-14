import express, { type NextFunction, type Request, type Response } from 'express';
import { createRoomService } from '../application/rooms/roomService';
import { isRoomClientId, isRoomIdentifier, parseRoomCommand, ROOM_LIMITS, type RoomActor, type RoomApi } from '../contracts/roomV1';
import { exactSocialKeys, SocialError } from '../contracts/socialV1';
import { requireAuth, requireCurrentAccountViewer, type AuthenticatedRequest } from '../middleware/authMiddleware';
import { asyncHandler, limitConcurrency, rateLimit, requireSecureAuthTransport } from '../middleware/requestProtectionMiddleware';
import { issueRoomTicket } from '../realtime/roomTickets';

const invalid = () => new SocialError(400, 'invalid_request');
const actor = (req: Request, clientId = req.get('X-Finitude-Room-Client')): RoomActor => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.sessionId) throw new SocialError(401, 'session_required');
    if (!isRoomClientId(clientId)) throw invalid();
    return { userId: auth.userId, sessionId: auth.sessionId, clientId };
};

/** Room endpoints precede the smaller social parser and return only current authorized projections. */
export const createRoomRouter = (api: RoomApi = createRoomService()) => {
    const router = express.Router();
    router.use((req, _res, next) => /^\/(rooms(?:\/|$)|room-commands$|room-invitations(?:\/|$)|room-media$|realtime-tickets$|capabilities$)/.test(req.path) ? next() : next('router'));
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization');
        res.vary('X-Finitude-Account-Viewer'); res.vary('X-Finitude-Room-Client'); next(); });
    router.use(requireSecureAuthTransport, rateLimit('room-http', 180, 60_000), requireAuth, requireCurrentAccountViewer);
    router.use((req, _res, next) => {
        if (!exactSocialKeys(req.query, [])) return next(invalid());
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        if (!req.is('application/json')) return next(new SocialError(415, 'json_required'));
        next();
    });
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
        res.json(await issueRoomTicket(actor(req, req.body.clientId), origin));
    }));
    router.use((_req, _res, next) => next(new SocialError(404, 'not_found')));
    router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) return next(error);
        const parser = error as { type?: string };
        const known = error instanceof SocialError ? error : parser?.type === 'entity.too.large'
            ? new SocialError(413, 'request_too_large') : parser?.type === 'entity.parse.failed' ? invalid() : null;
        if (!known) return next(error);
        res.status(known.statusCode).json({ code: known.code, message: known.message });
    });
    return router;
};
