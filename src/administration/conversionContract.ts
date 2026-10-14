import { createHash } from 'node:crypto';

export const CONVERSION_PRESET = 'mp3-320' as const;
export const CONVERSION_MAX_FILES = 100;
export const CONVERSION_MAX_BYTES = 512 * 1024 * 1024;
export const conversionId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
export const conversionOperationId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const conversionCatalogRevision = (value: unknown): value is string => typeof value === 'string' && /^cr_[A-Za-z0-9_-]{43}$/.test(value);
export const conversionSourceRevision = (value: unknown): value is string => typeof value === 'string' && /^mr_[a-f0-9]{32}$/.test(value);
export const conversionMembershipRevision = (value: unknown): value is string => typeof value === 'string' && /^cm_[A-Za-z0-9_-]{43}$/.test(value);
export const conversionEtag = (value: unknown): value is string => typeof value === 'string' && /^"[^"\r\n]{1,200}"$/.test(value);

/** Public errors are finite codes; uploaded names, payloads and storage errors never become messages. */
export class AdminConversionError extends Error {
    constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
export const conversionFail = (status: number, code: string): never => { throw new AdminConversionError(status, code); };
export const conversionDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
export const conversionRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : conversionFail(400, 'ADMIN_CONVERSION_INVALID_INPUT');
export const conversionExact = (value: Record<string, unknown>, keys: readonly string[]) => {
    if (Object.keys(value).some(key => !keys.includes(key))) conversionFail(400, 'ADMIN_CONVERSION_INVALID_INPUT');
};
const positiveBytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= CONVERSION_MAX_BYTES;

export interface ConversionAlbumApproval { id: string; revision: string; membershipRevision: string }
export interface ConversionOutput { sha256: string; byteLength: number; filename: string; preset: typeof CONVERSION_PRESET }
export interface ConversionIntent {
    operationId: string; expectedRevision: string; sourceRevision: string; sourceEtag: string; sourceByteLength: number;
    album: ConversionAlbumApproval | null; output: ConversionOutput;
}
export interface ConversionSourceManifest {
    schemaVersion: 1;
    album: (ConversionAlbumApproval & { title: string }) | null;
    tracks: Array<{
        id: string; albumId: string | null; revision: string; sourceRevision: string; title: string; originalFileName: string | null;
        format: { container: string | null; codec: string | null; lossless: boolean | null; sampleRate: number | null; channels: number | null; bitDepth: number | null; duration: number | null };
        mediaUrl: string;
    }>;
}
export type ConversionUploadState = 'notStarted' | 'pending' | 'ready' | 'failed' | 'unknown';
export type ConversionPublicationState = 'notStarted' | 'ready' | 'failed' | 'unknown';
export interface ConversionOperationResponse {
    schemaVersion: 1;
    operation: {
        operationId: string; trackId: string; status: 'awaitingUpload' | 'uploading' | 'needsAttention' | 'complete' | 'superseded';
        upload: ConversionUploadState; publication: ConversionPublicationState; ready: boolean; cleanupPending: boolean; issue: string | null;
        output: Pick<ConversionOutput, 'sha256' | 'byteLength' | 'preset'>;
    };
}

/** Canonical parsing fixes the fingerprint's key order and disallows unrelated patch fields. */
export function parseConversionIntent(raw: unknown): ConversionIntent {
    const body = conversionRecord(raw);
    conversionExact(body, ['operationId', 'expectedRevision', 'sourceRevision', 'sourceEtag', 'sourceByteLength', 'album', 'output']);
    let album: ConversionAlbumApproval | null = null;
    if (body.album !== null) {
        const value = conversionRecord(body.album); conversionExact(value, ['id', 'revision', 'membershipRevision']);
        if (!conversionId(value.id) || !conversionCatalogRevision(value.revision) || !conversionMembershipRevision(value.membershipRevision)) return conversionFail(400, 'ADMIN_CONVERSION_INVALID_INPUT');
        album = { id: value.id, revision: value.revision, membershipRevision: value.membershipRevision };
    }
    const output = conversionRecord(body.output); conversionExact(output, ['sha256', 'byteLength', 'filename', 'preset']);
    if (!conversionOperationId(body.operationId) || !conversionCatalogRevision(body.expectedRevision) || !conversionSourceRevision(body.sourceRevision)
        || !conversionEtag(body.sourceEtag) || !positiveBytes(body.sourceByteLength) || !positiveBytes(output.byteLength)
        || typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(output.sha256) || output.preset !== CONVERSION_PRESET
        || typeof output.filename !== 'string' || output.filename.length < 5 || output.filename.length > 255 || !/\.mp3$/i.test(output.filename)
        || /[\\/:\u0000-\u001f\u007f-\u009f]/.test(output.filename) || output.filename !== output.filename.normalize('NFC')) return conversionFail(400, 'ADMIN_CONVERSION_INVALID_INPUT');
    return { operationId: body.operationId.toLowerCase(), expectedRevision: body.expectedRevision, sourceRevision: body.sourceRevision,
        sourceEtag: body.sourceEtag, sourceByteLength: body.sourceByteLength, album,
        output: { sha256: output.sha256, byteLength: output.byteLength, filename: output.filename, preset: CONVERSION_PRESET } };
}
