import { MetadataLookupInputError, type LookupInputProblem } from './lookupContract';
import { MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS, MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS, normalizeMusicBrainzId } from '../../utils/musicBrainzId';

/**
 * Pure format checks for every identifier and term that metadata lookup may send or compare.
 * Anything that fails is never sent; callers drop it or refuse the lookup.
 */

/** Lowercase 8-4-4-4-12 hex UUID (the nil UUID refused); the shared check lives in src/utils/musicBrainzId.ts. */
export { normalizeMusicBrainzId };

export type NormalizedGtin = { digits: string; gtin14: string };

/** GTIN-8/12/13/14 with a valid mod-10 check digit; queries send `digits`, comparisons use `gtin14`. */
export const normalizeGtin = (value: unknown): NormalizedGtin | null => {
    if (typeof value !== 'string' || value.length > 64) return null;
    const digits = value.replace(/[\s-]/g, '');
    if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length) || /^0+$/.test(digits)) return null;
    let sum = 0;
    // Weights alternate 3, 1, … starting from the digit left of the check digit.
    for (let index = digits.length - 2, weight = 3; index >= 0; index--, weight = 4 - weight) sum += Number(digits[index]) * weight;
    if ((10 - (sum % 10)) % 10 !== Number(digits[digits.length - 1])) return null;
    return { digits, gtin14: digits.padStart(14, '0') };
};

/** ISRC without hyphens, uppercase: country, registrant, year and designation. */
export const normalizeIsrc = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length > 32) return null;
    const isrc = value.replace(/-/g, '').toUpperCase();
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null;
};

/** iTunes collection or track ID: 1 to 12 digits, or a positive safe integer. */
export const normalizeItunesId = (value: unknown): string | null => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 && value < 1e12 ? String(value) : null;
    return typeof value === 'string' && /^[1-9]\d{0,11}$/.test(value) ? value : null;
};

/** Cover Art Archive image IDs arrive as JSON numbers or digit strings; both become a string. */
export const normalizeCoverArtImageId = (value: unknown): string | null => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    return typeof value === 'string' && /^\d{1,20}$/.test(value) && !/^0+$/.test(value) ? value : null;
};

const controlOrFormat = /[\p{Cc}\p{Cf}]/u;
const loneSurrogate = /\p{Cs}/u;
const urlLike = /:\/\/|^www\.|^(?:https?|ftp|file|data|javascript|mailto):/i;

/** Lookup text is a name, never a link; control and format characters are refused on the raw value. */
export const lookupTermProblem = (value: unknown, max = 200): Exclude<LookupInputProblem, 'identifier'> | null => {
    if (typeof value !== 'string') return 'invalidText';
    // Refuses pathological input before any regular-expression work on it.
    if (value.length > 4 * max + 64) return 'tooLong';
    if (controlOrFormat.test(value) || loneSurrogate.test(value)) return 'invalidText';
    const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (!text) return 'empty';
    if (urlLike.test(text)) return 'url';
    return text.length > max ? 'tooLong' : null;
};

/** NFC, whitespace collapsed and trimmed; throws `MetadataLookupInputError` for any `lookupTermProblem`. */
export const cleanLookupTerm = (value: unknown, max = 200): string => {
    const problem = lookupTermProblem(value, max);
    if (problem) throw new MetadataLookupInputError(problem);
    return (value as string).normalize('NFC').replace(/\s+/gu, ' ').trim();
};

/** The best-known MusicBrainz special-purpose entities by name; every documented one is a placeholder (placeholderIds). */
export const MUSICBRAINZ_PLACEHOLDER_IDS = Object.freeze({
    variousArtists: '89ad4ac3-39f7-470e-963a-56509c546377',
    unknown: '125ec42a-7229-4250-afc5-e057484327fe',
    noLabel: '157afde4-4bf5-4039-8ad2-5a15acc85176'
});
/** Every documented special purpose artist and label (src/utils/musicBrainzId.ts): never written as credits or labels. */
const placeholderIds = new Set<string>([...MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS, ...MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS]);
const placeholderNames = new Set(['various artists', 'various', 'va', 'v.a.', 'unknown', 'unknown artist',
    '[unknown]', '[no label]', '[anonymous]', '[traditional]', '[data]', '[dialogue]', '[no artist]']);

/** True for placeholder credits such as Various Artists, [unknown] or [no label], by MBID or by name. */
export const isPlaceholderCredit = (name: unknown, mbid?: unknown): boolean => {
    const id = normalizeMusicBrainzId(mbid);
    if (id && placeholderIds.has(id)) return true;
    return typeof name === 'string' && placeholderNames.has(name.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase());
};
