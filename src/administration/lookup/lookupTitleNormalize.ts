/**
 * Pure comparison of an existing-Album review's searched title with a release title, as the review's "same title" reads it: the
 * ending a run drops before searching removed first (a slash, `/` or `／`, then one of the primary Artist names or either part of a
 * decorated one: titleWithoutTrailingCredit, so `X/Name` and `Back in Black/AC/DC` lose it), then any other trailing credit (the
 * text after the last full-width `／`, or after an ASCII `/` with whitespace on both sides, when text follows it, so `Love/Hate`
 * and `Fate/Zero` keep theirs) when a letter or digit stays before it, then NFKC and lower case, the brackets 「」『』()[] as
 * spaces (NFKC folds the full-width round and square ones) and whitespace collapsed, and a leading or trailing primary Artist
 * name, or either part of a decorated one (lookupDecoratedNames.ts), removed when a space separates it. The review page's
 * normalized title reads the same, except that it reads a decorated name more loosely, drops a credit unless nothing would stay
 * before it and does not drop one after a slash without spaces. Not the planner's normalizedLookupTitle, which respells a search text for its fallbacks. Total on any input;
 * nothing here makes a request.
 */
import { decoratedNameParts, titleWithoutTrailingCredit } from './lookupDecoratedNames';

/** A title over this many characters is never compared (METADATA_LOOKUP_LIMITS.textLength); a name over 200 is never read. */
const TITLE_LENGTH = 1000, NAME_LENGTH = 200;
const brackets = /[「」『』()[\]]/gu;
/** NFKC and lower case, brackets as spaces, whitespace collapsed and trimmed. */
const comparable = (text: string) => text.normalize('NFKC').toLowerCase().replace(brackets, ' ').replace(/\s+/gu, ' ').trim();
/** A trailing credit: from the last full-width slash, or from an ASCII slash with whitespace on both sides, to a non-empty end. */
const trailingCredit = /\s*／[^／]+$|\s+\/\s+[^/]+$/u;

/**
 * A title as it is compared with `names` (the Album's primary Artist names); null for a non-string, a title over 1000 characters
 * or nothing left. A title that is only a credit, or only one of the names, keeps it.
 */
export function comparableLookupTitle(title: unknown, names: readonly unknown[]): string | null {
    if (typeof title !== 'string' || title.length > TITLE_LENGTH) return null;
    // The ending before one of the names goes first, as the run's search drops it; it keeps a letter or digit before it.
    const credited = titleWithoutTrailingCredit(title, Array.isArray(names) ? names : []) ?? title;
    const cut = credited.replace(trailingCredit, '');
    let value = comparable(/[\p{L}\p{N}]/u.test(cut) ? cut : credited);
    const parts = (Array.isArray(names) ? names : []).filter((name): name is string => typeof name === 'string' && name.length <= NAME_LENGTH)
        .flatMap(name => [name, ...(decoratedNameParts(name) ?? [])]).map(comparable).filter(Boolean);
    for (const part of parts) {
        if (value.startsWith(`${part} `)) value = value.slice(part.length + 1).trim();
        if (value.endsWith(` ${part}`)) value = value.slice(0, -part.length - 1).trim();
    }
    return value || null;
}

/** Whether two titles compare equal with `names`; never for a title that compares as null. */
export const sameLookupTitle = (left: unknown, right: unknown, names: readonly unknown[]): boolean => {
    const one = comparableLookupTitle(left, names);
    return one !== null && one === comparableLookupTitle(right, names);
};
