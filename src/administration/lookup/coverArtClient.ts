import { strictHttpsUrl } from '../adminPinnedHttps';
import { METADATA_LOOKUP_HOSTS, METADATA_LOOKUP_LIMITS, MetadataLookupInputError, type CoverArtListing } from './lookupContract';
import { normalizeCoverArtImageId, normalizeMusicBrainzId } from './lookupIdentifiers';
import { LookupShapeError, array, boolean, integer, object, oneOf, string, validateLookupShape } from './lookupResponseShape';
import { requestLookupJson, type LookupCallOptions, type LookupClientDependencies } from './lookupSourceRequest';

/**
 * Cover Art Archive listing client. The listing redirects through archive.org to a storage node,
 * so each hop is allowlisted by host and bound to the requested release's MBID. Only image
 * identities, flags, types and available sizes are returned, never a URL.
 */
const requireMbid = (value: unknown) => {
    const id = normalizeMusicBrainzId(value);
    if (!id) throw new MetadataLookupInputError('identifier');
    return id;
};

export const coverArtListingUrl = (releaseId: string) => new URL(`https://${METADATA_LOOKUP_HOSTS.coverArtArchive}/release/${requireMbid(releaseId)}`);

/** Hop 0 is the archive listing; later hops may only reach archive.org or a storage node for the same MBID. */
export const coverArtDestination = (releaseId: string) => {
    const id = requireMbid(releaseId);
    const storagePath = new RegExp(`^/\\d+/items/mbid-${id}/index\\.json$`);
    return (url: URL, hop: number): URL | null => {
        const strict = strictHttpsUrl(url.href);
        if (!strict || strict.search) return null;
        const { hostname, pathname } = strict;
        if (hostname === METADATA_LOOKUP_HOSTS.coverArtArchive && (pathname === `/release/${id}` || pathname === `/release/${id}/`)) return strict;
        if (hop === 0) return null;
        if (hostname === METADATA_LOOKUP_HOSTS.archive && pathname === `/download/mbid-${id}/index.json`) return strict;
        if (METADATA_LOOKUP_HOSTS.archiveStorage.test(hostname) && storagePath.test(pathname)) return strict;
        return null;
    };
};

const knownTypes = new Set(['Front', 'Back', 'Booklet', 'Medium', 'Obi', 'Spine', 'Track', 'Tray', 'Sticker', 'Poster', 'Liner',
    'Watermark', 'Raw/Unedited', 'Matrix/Runout', 'Top', 'Bottom', 'Panel', 'Other']);
const thumbnail = string(2048, { optional: true });
/** Allowlisted listing shape; the recorder trims fixtures with it. */
export const coverArtShape = object({
    images: array(object({
        id: oneOf(integer(1, Number.MAX_SAFE_INTEGER), string(20, { pattern: /^\d{1,20}$/ })),
        front: boolean(), back: boolean(), approved: boolean(),
        types: array(string(64), 30),
        thumbnails: object({ 250: thumbnail, 500: thumbnail, 1200: thumbnail }, { optional: true })
    }), 200),
    release: string(2048)
});

type RawImage = { id: number | string; front: boolean; back: boolean; approved: boolean; types: string[]; thumbnails?: Record<string, string> };

/** The listing must name the requested release; unknown image types are dropped. */
export const parseCoverArtListing = (json: unknown, releaseId: string): CoverArtListing => {
    const id = requireMbid(releaseId);
    const raw = validateLookupShape<{ images: RawImage[]; release: string }>(coverArtShape, json);
    if (raw.release !== `https://musicbrainz.org/release/${id}` && raw.release !== `http://musicbrainz.org/release/${id}`) throw new LookupShapeError();
    return {
        releaseId: id,
        images: raw.images.map(image => {
            const imageId = normalizeCoverArtImageId(image.id);
            if (!imageId) throw new LookupShapeError();
            const sizes = ([250, 500, 1200] as const).filter(size => image.thumbnails?.[size] !== undefined);
            return { imageId, front: image.front, back: image.back, approved: image.approved, types: image.types.filter(type => knownTypes.has(type)), sizes };
        })
    };
};

export interface CoverArtClient {
    /** Null when the release has no Cover Art Archive listing (404). */
    listRelease(releaseId: string, options: LookupCallOptions): Promise<CoverArtListing | null>;
}

export const createCoverArtClient = (dependencies: LookupClientDependencies): CoverArtClient => ({
    async listRelease(releaseId, options) {
        const url = coverArtListingUrl(releaseId);
        return requestLookupJson<CoverArtListing | null>({
            source: 'coverartarchive', url, destination: coverArtDestination(releaseId), accept: 'application/json',
            contentTypes: ['application/json'], maximumBytes: METADATA_LOOKUP_LIMITS.coverArtBytes,
            deadlineMs: METADATA_LOOKUP_LIMITS.requestDeadlineMs.coverartarchive, rateLimitStatuses: [429, 503],
            emptyStatuses: [404], emptyValue: null, parse: json => parseCoverArtListing(json, releaseId)
        }, options, dependencies);
    }
});
