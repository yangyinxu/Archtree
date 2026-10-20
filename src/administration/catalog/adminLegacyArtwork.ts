import type { LookupAddress } from 'node:dns';
import type { request } from 'node:https';
import sharp from 'sharp';
import { legacyCatalogArtworkUrl } from './adminCatalogArtworkSource';
import { isPublicUnicastAddress, openPinnedHttps, readPinnedBody, withAbort, type PinnedHttpsResponse } from '../adminPinnedHttps';
import { createCoverArtVariantScheduler, scheduleCoverArtVariant, type CoverArtVariantScheduler } from '../../services/image/coverArtVariantScheduler';

const maximumBytes = 10 * 1024 * 1024;
const maximumPixels = 16_000_000;
const deadlineMs = 8000;
const maximumRedirects = 3;
const applicationUserAgent = 'Finitude/1.0 (administrator artwork preview; https://kashewt.com)';
// The regular media pool is broader: legacy downloads retain their own small process budget.
const legacyScheduler = createCoverArtVariantScheduler(2, 2, 16, 8);

/** Every DNS answer must be ordinary public unicast, including answers not selected for the socket. */
export const isPublicArtworkAddress = isPublicUnicastAddress;

export interface LegacyArtworkDependencies {
    lookup?: (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>;
    request?: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<PinnedHttpsResponse>;
    httpsRequest?: typeof request;
    schedule?: CoverArtVariantScheduler;
    clientKey?: string;
    transform?: (input: Buffer, contentType: string, signal: AbortSignal, timeoutSeconds: number) => Promise<Buffer>;
    /** Tests can shorten the shared DNS, response-body and raster-decoding deadline. */
    deadlineMs?: number;
}
const unavailable = () => new Error('ADMIN_CATALOG_ARTWORK_UNAVAILABLE');
const abortable = <T>(work: Promise<T>, signal: AbortSignal) => withAbort(work, signal, unavailable);

/** Holds the actual native promise until it settles; a destroyed stream alone does not cancel libvips. */
const transformLegacyArtwork = async (input: Buffer, contentType: string, signal: AbortSignal, timeoutSeconds: number) => {
    const image = sharp(input, { failOn: 'error', limitInputPixels: maximumPixels }).timeout({ seconds: timeoutSeconds });
    const abort = () => image.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
        const metadata = await image.metadata();
        const expectedFormat = contentType === 'image/jpeg' ? 'jpeg' : contentType.slice(6);
        if (metadata.format !== expectedFormat || (metadata.pages ?? 1) > 1) throw unavailable();
        signal.throwIfAborted();
        // Keep the native-work lease until Sharp actually settles, even after an abort.
        const output = await image.rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 85, effort: 4 }).toBuffer();
        signal.throwIfAborted();
        if (!output.length || output.length > maximumBytes) throw unavailable();
        return output;
    } finally { signal.removeEventListener('abort', abort); image.destroy(); }
};

/** Every bounded redirect repeats the same DNS/TLS checks without forwarding account credentials. */
export const loadLegacyCatalogArtwork = async (
    reference: string, parentSignal: AbortSignal, dependencies: LegacyArtworkDependencies = {}
): Promise<Buffer> => {
    const url = legacyCatalogArtworkUrl(reference);
    if (!url) throw unavailable();
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(dependencies.deadlineMs ?? deadlineMs)]);
    const deadline = Date.now() + (dependencies.deadlineMs ?? deadlineMs);
    signal.throwIfAborted();
    const clientKey = dependencies.clientKey ?? 'unknown';
    const scheduled = (dependencies.schedule ?? legacyScheduler)(clientKey, signal, async () => {
        // Hop 0 was validated above, before scheduling; every redirect destination repeats the URL rules.
        const { response } = await openPinnedHttps(url, signal, {
            destination: (target, hop) => hop === 0 ? target : legacyCatalogArtworkUrl(target.href),
            headers: { Accept: 'image/jpeg, image/png, image/webp, image/gif', 'User-Agent': applicationUserAgent },
            maximumRedirects, failure: unavailable
        }, { lookup: dependencies.lookup, request: dependencies.request, httpsRequest: dependencies.httpsRequest });
        const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (response.statusCode !== 200 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)
            || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            response.body.destroy(); throw unavailable();
        }
        const input = await abortable(readPinnedBody(response, signal, maximumBytes, unavailable), signal);
        signal.throwIfAborted();
        // The native lease is shared with public artwork and outlives an HTTP timeout if necessary.
        return scheduleCoverArtVariant(clientKey, signal, async () => {
            signal.throwIfAborted();
            const timeoutSeconds = Math.min(8, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
            const output = await (dependencies.transform ?? transformLegacyArtwork)(input, contentType, signal, timeoutSeconds);
            signal.throwIfAborted();
            return output;
        });
    });
    // An expired response returns promptly, while both resource schedulers retain the real task lease.
    return abortable(scheduled, signal);
};

/** Stable dependency seam keeps route tests isolated from real DNS, HTTPS and private artwork. */
export const legacyCatalogArtwork = { load: loadLegacyCatalogArtwork };
