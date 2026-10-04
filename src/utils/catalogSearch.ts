import { escapeRegex } from './search';

/** A bounded, rebuildable candidate index; the original regex still decides matches. */
export const catalogSearchVersion = 1;
export const catalogSearchMaximumTextLength = 512;
export const catalogSearchCollections = {
    artists: 'name', organizations: 'name', albums: 'title', audioTracks: 'title'
} as const;
export type SearchCollection = keyof typeof catalogSearchCollections;

const ascii = (value: string) => /^[\x00-\x7f]*$/.test(value);
const grams = (value: string, length: number) => [...new Set(
    Array.from({ length: Math.max(0, value.length - length + 1) }, (_, index) => value.slice(index, index + length))
)];

/** Unicode/oversized sources keep the exact Mongo regex path rather than guessing case folding. */
export const catalogSearchProjection = (value: unknown) => {
    if (typeof value !== 'string' || value.length > catalogSearchMaximumTextLength || !ascii(value)) {
        return { catalogSearchVersion: 0, catalogSearchGrams: [] as string[] };
    }
    const normalized = value.toLowerCase();
    return {
        catalogSearchVersion,
        catalogSearchGrams: [1, 2, 3].flatMap(length => grams(normalized, length))
    };
};

/** Source metadata and its candidate projection must commit in the same document write. */
export const withCatalogSearchUpdate = (update: Record<string, unknown>, field: 'name' | 'title'): Record<string, unknown> => {
    const clean = { ...update };
    delete clean.catalogSearchVersion;
    delete clean.catalogSearchGrams;
    return Object.prototype.hasOwnProperty.call(clean, field)
        ? { ...clean, ...catalogSearchProjection(clean[field]) } : clean;
};

/** Missing/unsupported projections remain searchable throughout a rolling backfill. */
export const catalogSearchFilter = (
    field: 'name' | 'title', query: string,
    enabled = process.env.CATALOG_SEARCH_INDEX_ENABLED === 'true'
): Record<string, unknown> => {
    const exact = { [field]: { $regex: escapeRegex(query), $options: 'i' } };
    if (!enabled || !query || query.length > 100 || !ascii(query)) return exact;
    const candidates = grams(query.toLowerCase(), Math.min(3, query.length));
    return {
        ...exact,
        $or: [
            { catalogSearchVersion: { $ne: catalogSearchVersion } },
            { catalogSearchVersion, catalogSearchGrams: { $all: candidates } }
        ]
    };
};
