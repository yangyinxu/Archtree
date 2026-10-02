import { safeServerErrorCategory } from '../middleware/requestDiagnosticsMiddleware';

/** Fixed media/catalog operations shared by request handlers and lifecycle recovery. */
export type MediaFailureCategory = 'cover_art_cleanup_deferred' | 'audio_metadata_unavailable'
    | 'media_deletion_failed' | 'media_upload_failed' | 'media_probe_failed'
    | 'media_stream_failed' | 'media_download_failed' | 'media_upload_state_write_failed'
    | 'media_deletion_state_write_failed' | 'media_reference_cleanup_state_write_failed';

/** Logs bounded failure evidence; lifecycle-only work has no HTTP request identity. */
export const logMediaFailure = (
    category: MediaFailureCategory,
    error: unknown,
    requestId?: string
) => {
    console.error(JSON.stringify({
        category,
        ...(requestId ? { requestId } : {}),
        errorCategory: safeServerErrorCategory(error)
    }));
};
