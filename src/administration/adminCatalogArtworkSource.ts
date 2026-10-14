import { isIP } from 'node:net';

export type AdminCatalogArtworkSource =
    | { kind: 'stored'; imageId: string; reference: string }
    | { kind: 'external'; url: string; reference: string };

/** Only database-owned HTTPS references can enter the private legacy-artwork proxy. */
export const legacyCatalogArtworkUrl = (value: unknown): URL | null => {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash
            || (url.port && url.port !== '443') || !url.hostname.includes('.')
            || isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.hostname.endsWith('.')) return null;
        return url;
    } catch { return null; }
};

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
