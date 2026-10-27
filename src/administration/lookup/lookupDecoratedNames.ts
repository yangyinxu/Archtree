/**
 * Pure readers of decorated names: an artist tag or saved Artist name made of a name without Latin letters and its romanized form
 * ('ヰ世界情緒 -Isekaijoucho-', 'Name (Romanized)', 'Name（Romanized）'), and of a saved Album title that ends in a slash and one of
 * the Album's primary Artist names. Deterministic and total on any input; nothing here makes a request or reads a draft value.
 */
import { isPlaceholderCredit } from './lookupIdentifiers';

/** A name or title over this many characters is never read. */
const TEXT_LENGTH = 200;
/** After NFKC: a first part without brackets, then the romanized part in round brackets, with or without a space before them. */
const bracketForm = /^([^()]*[^()\s])\s*\(\s*([^()]*[^()\s])\s*\)$/u;
/** After NFKC: a first part without brackets, a space, then the romanized part between hyphens, with no space or hyphen inside. */
const dashForm = /^([^()]*\S)\s+-(?!\s)([^-]*[^-\s])-$/u;
const latinLetter = /\p{Script=Latin}/u;
/** A Latin letter, and only Latin letters, digits, spaces and . ' ’ - & ! besides. */
const romanized = (text: string) => latinLetter.test(text) && /^[\p{Script=Latin}\p{Nd}\p{Zs}.'’&!-]+$/u.test(text);
/** A letter, and no Latin letter. */
const unromanized = (text: string) => /\p{L}/u.test(text) && !latinLetter.test(text);

/**
 * The two parts of a decorated name, read after NFKC (full-width brackets and hyphens fold) with whitespace collapsed: the first
 * part (a letter and no Latin letter, no bracket) and the romanized part, in round brackets or between hyphens after a space;
 * null for any other name, a part that is a placeholder credit, a non-string or a name over 200 characters. A disambiguation
 * (`YUKI (JUDY AND MARY)`) or a name with a bracketed part in another script (`鹿目まどか (悠木碧)`) is never decorated.
 */
export function decoratedNameParts(name: unknown): readonly [string, string] | null {
    if (typeof name !== 'string' || name.length > TEXT_LENGTH) return null;
    const text = name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const match = bracketForm.exec(text) ?? dashForm.exec(text);
    if (!match) return null;
    const first = match[1].trim(), other = match[2].trim();
    return unromanized(first) && romanized(other) && !isPlaceholderCredit(first) && !isPlaceholderCredit(other) ? [first, other] : null;
}

/** Folded for comparing a title's ending with names: NFKC, lower case, whitespace collapsed and trimmed. */
const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

/**
 * A saved Album title without its trailing credit: the text before a slash (`/` or `／`) whose rest equals, folded, one of `names`
 * or either part of a decorated one, provided a letter or digit remains before it. The shortest such ending counts, so
 * `Back in Black/AC/DC` credited to AC/DC gives `Back in Black`; null when no such ending exists.
 */
export function titleWithoutTrailingCredit(title: unknown, names: readonly unknown[]): string | null {
    if (typeof title !== 'string' || title.length > TEXT_LENGTH || !Array.isArray(names)) return null;
    const folded = new Set(names.filter((name): name is string => typeof name === 'string' && name.length <= TEXT_LENGTH)
        .flatMap(name => [name, ...(decoratedNameParts(name) ?? [])]).map(fold).filter(Boolean));
    for (let at = title.length - 1; at > 0 && folded.size; at--) {
        if (title[at] !== '/' && title[at] !== '／') continue;
        const before = title.slice(0, at).trim();
        if (/[\p{L}\p{N}]/u.test(before) && folded.has(fold(title.slice(at + 1)))) return before;
    }
    return null;
}
