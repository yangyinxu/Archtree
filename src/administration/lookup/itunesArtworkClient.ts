import { strictHttpsUrl } from '../adminPinnedHttps';
import { maxCoverArtInputBytes } from '../../services/image/imageStorageService';
import { scheduleCoverArtVariant, type CoverArtVariantScheduler } from '../../services/image/coverArtVariantScheduler';
import { lookupArtworkTypes, validatedLookupArtwork, type CoverArtFrontOptions, type CoverArtFrontSize, type LookupArtwork } from './coverArtClient';
import { METADATA_LOOKUP_HOSTS, METADATA_LOOKUP_LIMITS, MetadataLookupInputError } from './lookupContract';
import { itunesArtworkAddress } from './iTunesSearchClient';
import { requestLookupBytes, type LookupClientDependencies } from './lookupSourceRequest';

/**
 * iTunes artwork for an iTunes-only candidate only (owner rule: Administrator Metadata Lookup artwork bullet). The candidate stores
 * the 100-pixel address the search answered, already checked against the fixed artwork hosts; the server rewrites only its last
 * path segment to the thumbnail size it needs (1200 px for a staged cover, 500 px for a preview) and fetches that exact address
 * through the `itunes` gate (one request at a time, 3 s apart) with the product-only User-Agent and no contact. A redirect may
 * only move to another fixed artwork host with the same path and no query. Validation and decoding are those of Cover Art Archive
 * artwork (validatedLookupArtwork); a 404 is no artwork, and the bytes are never cached.
 */
const thumbnailPath = /^(\/image\/thumb\/(?:[A-Za-z0-9._~%+-]+\/){1,24})\d{1,5}x\d{1,5}bb\.(?:jpg|png|webp)$/;

/** The fetch address of a stored iTunes artwork address at `size`, or null when it is not an allowlisted thumbnail address. */
export function itunesArtworkUrl(stored: unknown, size: CoverArtFrontSize): URL | null {
    if (size !== 500 && size !== 1200) return null;
    const address = itunesArtworkAddress(stored), url = address ? strictHttpsUrl(address) : null;
    if (!url || url.search || url.href.includes('?') || url.port) return null;
    const path = thumbnailPath.exec(url.pathname);
    if (!path || path[1].split('/').some(segment => segment === '.' || segment === '..')) return null;
    return new URL(`https://${url.hostname}${path[1]}${size}x${size}bb.jpg`);
}

/** Hop 0 is exactly `url`; a later hop may only reach a fixed artwork host at the same path, without a query. */
export const itunesArtworkDestination = (url: URL) => (next: URL, hop: number): URL | null => {
    const strict = strictHttpsUrl(next.href);
    if (!strict || strict.search || strict.href.includes('?') || strict.port) return null;
    if (hop === 0) return strict.href === url.href ? strict : null;
    return METADATA_LOOKUP_HOSTS.itunesArtwork.test(strict.hostname) && strict.pathname === url.pathname ? strict : null;
};

export interface ItunesArtworkClient {
    /**
     * The thumbnail of `size` of a stored iTunes artwork address, validated and completely decoded as Cover Art Archive artwork is,
     * or null for a 404. An address that cannot be rewritten is refused before anything is sent.
     */
    front(artworkUrl: string, size: CoverArtFrontSize, options: CoverArtFrontOptions): Promise<LookupArtwork | null>;
}

/** `schedule` defaults to the process-wide cover scheduler (tests inject their own). */
export const createItunesArtworkClient = (dependencies: LookupClientDependencies & { schedule?: CoverArtVariantScheduler }): ItunesArtworkClient => ({
    async front(artworkUrl, size, options) {
        const url = itunesArtworkUrl(artworkUrl, size);
        if (!url) throw new MetadataLookupInputError('identifier');
        const answer = await requestLookupBytes({
            source: 'itunes', url, destination: itunesArtworkDestination(url), accept: lookupArtworkTypes.join(', '), contentTypes: lookupArtworkTypes,
            maximumBytes: Math.min(METADATA_LOOKUP_LIMITS.artworkBytes, maxCoverArtInputBytes), deadlineMs: METADATA_LOOKUP_LIMITS.requestDeadlineMs.itunes,
            rateLimitStatuses: [403, 429, 503], emptyStatuses: [404]
        }, options, dependencies);
        if (!answer) return null;
        return validatedLookupArtwork(answer.body, answer.contentType, size, dependencies.schedule ?? scheduleCoverArtVariant, options.clientKey, options.signal, 'itunes');
    }
});
