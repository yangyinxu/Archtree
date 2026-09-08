/** Adapts reviewed release intent and resumable operation requests to the shared workflow service. */
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/authMiddleware';
import { getUploadedFile } from '../../middleware/imageUpload';
import {
    resumeArtistReleaseWorkflow,
    runArtistReleaseWorkflow
} from '../../services/artistReleaseWorkflowService';
import { rejectNonAdminManagerRequest, redirectWithMessage, parseDateInput } from './requestHelpers';

/** Submits the reviewed, resumable Artist release setup workflow. */
export const createArtistReleaseWorkflowWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistMode = req.body.artistMode === 'new' ? 'new' : 'existing';
        const existingArtistId = String(req.body.existingArtistId ?? '').trim();
        const artistName = String(req.body.artistName ?? '').trim();
        const albumTitle = String(req.body.albumTitle ?? '').trim();
        if ((artistMode === 'existing' && !existingArtistId)
            || (artistMode === 'new' && !artistName)
            || !albumTitle) {
            return redirectWithMessage(res, 'Choose or name an Artist and enter an Album title.');
        }
        const createCarousel = req.body.createCarousel === 'true';
        const requestedPage = String(req.body.pageSlug ?? '').trim();
        const pageSlug = createCarousel && (requestedPage === 'home' || requestedPage === 'library')
            ? requestedPage
            : undefined;
        const positionRaw = String(req.body.pagePosition ?? '').trim();
        const pagePosition = positionRaw && Number.isFinite(Number(positionRaw))
            ? Math.max(0, Math.floor(Number(positionRaw)))
            : undefined;
        const requestedLimit = Number(req.body.carouselLimit ?? 20);
        const result = await runArtistReleaseWorkflow(
            authReq.auth.userId,
            {
                idempotencyToken: String(req.body.idempotencyToken ?? '').trim(),
                artistMode,
                existingArtistId: artistMode === 'existing' ? existingArtistId : undefined,
                artistName: artistMode === 'new' ? artistName : undefined,
                artistBio: artistMode === 'new' ? String(req.body.artistBio ?? '') : undefined,
                artistBirthDate: parseDateInput(String(req.body.artistBirthDate ?? '')),
                artistCoverArtRequested: Boolean(getUploadedFile(req, 'artistCoverArtFile')),
                albumTitle,
                albumReleaseDate: parseDateInput(String(req.body.albumReleaseDate ?? '')),
                albumCoverArtRequested: Boolean(getUploadedFile(req, 'albumCoverArtFile')),
                createCarousel,
                carouselName: createCarousel ? String(req.body.carouselName ?? '').trim() || undefined : undefined,
                carouselSort: req.body.carouselSort === 'titleAsc' ? 'titleAsc' : 'releaseDateDesc',
                carouselLimit: Number.isFinite(requestedLimit)
                    ? Math.max(1, Math.min(Math.floor(requestedLimit), 100))
                    : 20,
                pageSlug,
                pagePosition
            },
            {
                artistCoverArtFile: getUploadedFile(req, 'artistCoverArtFile'),
                albumCoverArtFile: getUploadedFile(req, 'albumCoverArtFile')
            }
        );
        const message = `Artist release setup completed. Artist ${result.artistId}; Album ${result.albumId}${result.carouselId ? `; Carousel ${result.carouselId}` : ''}.`;
        return res.redirect(`/content/manage?view=operations&workflowComplete=1&prefillType=artist&prefillId=${encodeURIComponent(result.artistId ?? '')}&message=${encodeURIComponent(message)}#workflow-operations`);
    } catch (error) {
        if ((error as any)?.operationId) {
            return res.redirect(`/content/manage?view=operations&message=${encodeURIComponent(`Artist release setup needs attention. Operation ${(error as any).operationId} retained every completed step; do not recreate completed content.`)}#workflow-operations`);
        }
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

/** Retries only retained intent and completed IDs from a prior setup operation. */
export const retryArtistReleaseWorkflowWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const result = await resumeArtistReleaseWorkflow(
            authReq.auth.userId,
            String(req.body.operationId ?? '').trim()
        );
        return res.redirect(`/content/manage?view=operations&workflowComplete=1&prefillType=artist&prefillId=${encodeURIComponent(result.artistId ?? '')}&message=${encodeURIComponent('Artist release setup completed after retry.')}#workflow-operations`);
    } catch (error) {
        if ((error as any)?.operationId) {
            return res.redirect(`/content/manage?view=operations&message=${encodeURIComponent(`Artist release setup still needs attention: ${String((error as Error).message)}`)}#workflow-operations`);
        }
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};
