import { foldImportName, type ImportDraftV2 } from './adminImportDraft';
import { REVIEW_LOOKUP_LIMITS } from '../lookup/lookupReviewValues';

/**
 * iTunes localized names of import Artist entries (owner rule: Administrator Album Imports identity bullet): the groups of names one
 * iTunes result showed for its artist across storefronts, such as a romanized and a Japanese name, that metadata lookup found. Value
 * application keeps the groups holding a current Artist entry's name on the import document, a publication freezes them, and the
 * identity candidates list records named with another name of an entry's group (`localizedName`). They never keep a MusicBrainz ID
 * on a renamed entry (that reads `musicBrainzNames` only) and never reach Luna. Pure.
 */
export type ImportLocalizedNames = string[][];
/**
 * At most 21 groups (one per Artist entry, and one spare), of at most 4 names of at most 200 characters each. An existing-Album
 * review (`review`), whose members' entries name artists too, keeps one group per review identity instead (512 groups).
 */
export const IMPORT_LOCALIZED_NAME_LIMITS = Object.freeze({ groups: 21, names: 4, name: 200 });
/** Whose names groups are kept for: an import's Album entries, or also a review's member entries (`review`). */
type LocalizedOptions = { review?: boolean };
const groupBound = (options: LocalizedOptions) => options.review ? REVIEW_LOOKUP_LIMITS.identities : IMPORT_LOCALIZED_NAME_LIMITS.groups;

const invisible = /[\p{Cc}\p{Cf}\p{Cs}]/u;
/** A localized name as stored: NFC and trimmed, 1 to 200 characters, without control, invisible formatting or lone surrogate characters. */
export function cleanLocalizedName(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 4 * IMPORT_LOCALIZED_NAME_LIMITS.name) return null;
    const name = raw.normalize('NFC').trim();
    return name && name.length <= IMPORT_LOCALIZED_NAME_LIMITS.name && !invisible.test(name) ? name : null;
}
/** One group's clean names, distinct by fold, at most the per-group bound; null unless at least two remain. */
const cleanGroup = (raw: unknown): string[] | null => {
    if (!Array.isArray(raw)) return null;
    const names: string[] = [];
    for (const value of raw.slice(0, 4 * IMPORT_LOCALIZED_NAME_LIMITS.names)) {
        const name = cleanLocalizedName(value);
        if (name && names.length < IMPORT_LOCALIZED_NAME_LIMITS.names && !names.some(known => foldImportName(known) === foldImportName(name))) names.push(name);
    }
    return names.length >= 2 ? names : null;
};
const groupKey = (group: readonly string[]) => JSON.stringify(group.map(foldImportName).sort());
/** The valid groups of a stored or found value, in order, distinct, within the group bound; malformed input reads as none. */
const validGroups = (raw: unknown, options: LocalizedOptions = {}): string[][] => {
    const groups: string[][] = [], seen = new Set<string>(), bound = groupBound(options);
    for (const item of Array.isArray(raw) ? raw.slice(0, 4 * bound) : []) {
        const group = cleanGroup(item);
        if (!group || seen.has(groupKey(group)) || groups.length >= bound) continue;
        seen.add(groupKey(group)); groups.push(group);
    }
    return groups;
};

/**
 * The other names each name has through the stored groups, by folded name (the name itself and names folding equal to it excluded):
 * every name of every valid group, or with `names` only those names; a review's (`review`) within its group bound. Malformed input
 * reads as no names.
 */
export function importLocalizedNameMap(stored: unknown, names?: readonly string[], options: LocalizedOptions = {}): Map<string, string[]> {
    const wanted = names ? new Set(names.filter((name): name is string => typeof name === 'string').map(foldImportName)) : null, map = new Map<string, string[]>();
    for (const group of validGroups(stored, options)) {
        for (const name of group) {
            const folded = foldImportName(name);
            if (wanted && !wanted.has(folded)) continue;
            const others = map.get(folded) ?? [];
            for (const other of group) if (foldImportName(other) !== folded && !others.some(known => foldImportName(known) === foldImportName(other))) others.push(other);
            if (others.length) map.set(folded, others);
        }
    }
    return map;
}

/**
 * The stored groups merged with newly `found` ones (stored first), each distinct by its folded names, keeping only groups that hold
 * a current Artist entry's name (a label has no localized names: iTunes has no labels), within the bounds. A review (`review`) also
 * keeps groups holding a name its members' Artist entries carry, up to its identity bound. Pure.
 */
export function mergeImportLocalizedNames(stored: unknown, found: readonly (readonly string[])[], draft: ImportDraftV2, options: LocalizedOptions = {}): ImportLocalizedNames {
    const members = options.review ? (Array.isArray(draft.tracks) ? draft.tracks : []).flatMap(track => {
        const entries: unknown = track && typeof track === 'object' ? (track as { artists?: unknown }).artists : null;
        return Array.isArray(entries) ? entries : [];
    }) : [];
    const entries = new Set([...(Array.isArray(draft.album?.artists) ? draft.album.artists : []), ...members]
        .map(entry => entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string' ? foldImportName((entry as { name: string }).name) : null)
        .filter((name): name is string => name !== null));
    return validGroups([...validGroups(stored, options), ...validGroups(found, options)].filter(group => group.some(name => entries.has(foldImportName(name)))), options);
}
