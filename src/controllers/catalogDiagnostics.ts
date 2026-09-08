import type { Response } from 'express';
import { safeServerErrorCategory } from '../middleware/requestDiagnosticsMiddleware';

type CatalogFailureCategory = 'cover_art_cleanup_deferred' | 'audio_metadata_unavailable'
    | 'media_deletion_failed' | 'media_upload_failed';

/** Correlates an administrator failure without logging filenames, content IDs, or raw exceptions. */
export const logCatalogFailure = (res: Response, category: CatalogFailureCategory, error: unknown) => {
    console.error(JSON.stringify({
        category,
        requestId: res.locals?.requestId,
        errorCategory: safeServerErrorCategory(error)
    }));
};
