import type { Response } from 'express';
import { logMediaFailure, type MediaFailureCategory } from '../services/mediaDiagnosticsService';

/** Correlates catalog and public media failures without logging filenames, IDs, or raw exceptions. */
export const logCatalogFailure = (res: Response, category: MediaFailureCategory, error: unknown) => {
    logMediaFailure(category, error, res.locals?.requestId);
};
