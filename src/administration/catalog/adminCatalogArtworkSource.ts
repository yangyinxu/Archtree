import { strictHttpsUrl } from '../adminPinnedHttps';

export type AdminCatalogArtworkSource =
    | { kind: 'stored'; imageId: string; reference: string }
    | { kind: 'external'; url: string; reference: string };

/**
 * Only database-owned HTTPS references can enter the private legacy-artwork proxy. The rules are the
 * shared outbound ones, so the proxy and metadata lookup can never drift apart.
 */
export const legacyCatalogArtworkUrl = strictHttpsUrl;

/** An explicit image identity takes precedence; malformed identities never unlock a URL fallback. */
export const adminCatalogArtworkSource = (doc: Record<string, unknown>): AdminCatalogArtworkSource | null => {
    if (doc.coverArtId !== undefined && doc.coverArtId !== null && doc.coverArtId !== '') {
        const imageId = String(doc.coverArtId);
        return /^[0-9a-f]{24}$/.test(imageId) ? { kind: 'stored', imageId, reference: `id:${imageId}` } : null;
    }
    const reference = doc.coverArtUrl;
    if (typeof reference !== 'string') return null;
    const image = /^\/content\/images\/([0-9a-f]{24})$/.exec(reference);
    if (image) return { kind: 'stored', imageId: image[1], reference: `url:${reference}` };
    const url = legacyCatalogArtworkUrl(reference);
    return url ? { kind: 'external', url: url.href, reference } : null;
};
