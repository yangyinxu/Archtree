import type { Request, Response } from 'express';
import type { RoomAudioAnalysisInput, RoomAudioAnalysisOutcome, RoomAudioAnalysisPage, RoomAudioAnalysisReason } from '../../contracts/roomAudioAnalysis';
import type { AuthenticatedRequest } from '../../middleware/authMiddleware';
import { getRequestAbortSignal } from '../../middleware/requestProtectionMiddleware';
import { analyzeRoomAudioTrack, listRoomAudioAnalysis, RoomAudioAnalysisError } from '../../services/roomAudioAnalysisService';
import { renderRoomAudioAnalysisPage, roomAudioAnalysisNotices, roomAudioAnalysisUrl, type RoomAudioAnalysisNotice } from '../../views/contentManager/roomAudioAnalysisView';
import { rejectNonAdminManagerRequest } from './requestHelpers';

interface AnalysisControllerDependencies {
    list: (input: { actorId: string; after?: string; limit?: number }) => Promise<RoomAudioAnalysisPage>;
    analyze: (input: RoomAudioAnalysisInput) => Promise<RoomAudioAnalysisOutcome>;
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
const validAfter = (value: unknown) => value === undefined || validId(value);
const wantsJson = (req: Request) => req.query.format === 'json' || Boolean(req.is('application/json'));
const knownReasons = new Set<RoomAudioAnalysisReason>(['unsupported_audio', 'decoder_unavailable', 'analysis_timeout', 'analysis_failed', 'storage_unavailable', 'source_changed', 'cancelled', 'interrupted']);
const knownOutcomes = new Set<RoomAudioAnalysisOutcome['outcome']>(['complete', 'unsupported', 'failed', 'cancelled', 'stale', 'busy', 'unknown']);

/** Never forwards provider diagnostics or arbitrary exception codes into browser or API responses. */
const errorResponse = (req: Request, res: Response, statusCode: number) => {
    const status = [400, 401, 403, 404, 409, 429, 503].includes(statusCode) ? statusCode : 503;
    const message = status === 400 ? 'Invalid audio analysis request.'
        : status === 401 || status === 403 ? 'Administrator access is required.'
            : status === 409 ? 'The source changed. Refresh its status before trying again.'
                : 'Audio analysis is unavailable. Refresh the status before trying again.';
    return wantsJson(req) ? res.status(status).json({ message }) : res.status(status).type('text/plain').send(message);
};

/** Thin adapters keep body decoding, safe presentation and request cancellation outside the service. */
export const createRoomAudioAnalysisController = (dependencies: AnalysisControllerDependencies) => ({
    get: async (req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        const authReq = req as AuthenticatedRequest;
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        if (!validId(authReq.auth?.userId) || !validAfter(req.query.after)
            || (req.query.format !== undefined && req.query.format !== 'json')
            || Object.keys(req.query).some(key => !['after', 'format', 'notice'].includes(key))) {
            return errorResponse(req, res, 400);
        }
        try {
            const after = req.query.after as string | undefined;
            const page = await dependencies.list({ actorId: authReq.auth!.userId, after, limit: 25 });
            if (wantsJson(req)) {
                return res.status(200).json({
                    items: page.items.map(item => ({
                        mediaTrackId: item.mediaTrackId, title: item.title, status: item.status,
                        sourceRevision: item.sourceRevision, attemptId: item.attemptId, updatedAt: item.updatedAt,
                        reason: item.reason && knownReasons.has(item.reason) ? item.reason : null
                    })),
                    nextAfter: page.nextAfter
                });
            }
            const notice = typeof req.query.notice === 'string' && Object.prototype.hasOwnProperty.call(roomAudioAnalysisNotices, req.query.notice)
                ? req.query.notice as RoomAudioAnalysisNotice : undefined;
            return res.status(200).send(renderRoomAudioAnalysisPage(page, { after, notice }));
        } catch (error) {
            return errorResponse(req, res, error instanceof RoomAudioAnalysisError ? error.statusCode : 503);
        }
    },
    post: async (req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        const authReq = req as AuthenticatedRequest;
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const body: unknown = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse(req, res, 400);
        const fields = body as Record<string, unknown>;
        if (!validId(authReq.auth?.userId) || !validId(fields.mediaTrackId)
            || typeof fields.sourceRevision !== 'string' || !/^[0-9a-f]{64}$/.test(fields.sourceRevision)
            || typeof fields.attemptId !== 'string' || !/^[0-9a-f]{32}$/.test(fields.attemptId)
            || !validAfter(fields.after)
            || Object.keys(fields).some(key => !['mediaTrackId', 'sourceRevision', 'attemptId', 'after'].includes(key))) {
            return errorResponse(req, res, 400);
        }
        try {
            const result = await dependencies.analyze({
                actorId: authReq.auth!.userId, mediaTrackId: fields.mediaTrackId,
                sourceRevision: fields.sourceRevision, attemptId: fields.attemptId,
                signal: getRequestAbortSignal(req)
            });
            const matchesAttempt = result.mediaTrackId === fields.mediaTrackId && result.attemptId === fields.attemptId;
            const outcome = matchesAttempt && knownOutcomes.has(result.outcome) ? result.outcome : 'unknown';
            if (wantsJson(req)) {
                return res.status(200).json({
                    mediaTrackId: fields.mediaTrackId, attemptId: fields.attemptId, outcome,
                    reason: result.reason && knownReasons.has(result.reason) ? result.reason : null
                });
            }
            const notice: RoomAudioAnalysisNotice = outcome === 'complete' || outcome === 'unsupported' ? 'finished' : outcome;
            return res.redirect(303, roomAudioAnalysisUrl(fields.after as string | undefined, notice));
        } catch (error) {
            if (!wantsJson(req) && (!(error instanceof RoomAudioAnalysisError) || error.statusCode >= 500)) {
                return res.redirect(303, roomAudioAnalysisUrl(fields.after as string | undefined, 'unknown'));
            }
            return errorResponse(req, res, error instanceof RoomAudioAnalysisError ? error.statusCode : 503);
        }
    }
});

const controller = createRoomAudioAnalysisController({ list: listRoomAudioAnalysis, analyze: analyzeRoomAudioTrack });
export const getRoomAudioAnalysis = controller.get;
export const postRoomAudioAnalysis = controller.post;
