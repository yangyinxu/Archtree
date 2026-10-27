/**
 * Pure reader of the position a saved Track title starts with ('1-01 ', '1.01.', '01.', '01 ', '01 - ') and of the Album guard
 * under which those positions count: every title has one, all in one form, and they are distinct and increase in Album order.
 * Track-title search planning (lookupTrackTitles.ts) removes them under that guard. The review page fills Disc and Track Numbers
 * from titles under a guard of its own, which is meant to accept exactly the table in
 * test/administration/lookupTitlePositions.test.ts. An existing-Album review's pairing also reads them, through
 * trackTitlePositions (lookupTrackTitles.ts), and the same positions of retained original filenames, as hints only to choose
 * among pairings (lookupReviewEvidence.ts, lookupSubset.ts); they become values only as the Disc and Track Numbers lookup writes
 * through such a pairing. Total on any input; nothing here makes a request.
 */

/** A title's leading position: its Disc Number (null when the title names none), its Track Number and the text after it. */
export type LeadingTitlePosition = { discNumber: number | null; trackNumber: number; rest: string };

const TEXT_LENGTH = 1024;
/**
 * A Disc Number (1-2 ASCII digits), `-` or `.`, a Track Number (1-3 digits), then `.` and any spaces, a spaced `.`, a spaced
 * hyphen or dash, or spaces. A space before other punctuation stays with the rest, so `01 ...Baby` keeps its dots.
 */
const discTrack = /^(\d{1,2})[-.](\d{1,3})(?:\.\s*|\s+\.\s+|\s+[-–—]\s+|\s+)(?=\S)/u;
/** A Track Number (1-3 ASCII digits), then the same separators. */
const trackOnly = /^(\d{1,3})(?:\.\s*|\s+\.\s+|\s+[-–—]\s+|\s+)(?=\S)/u;
/** A Disc Number, `-` or `.`, and a Track Number written with a leading zero, as a lone title's position must be. */
const paddedDiscTrack = /^\d{1,2}[-.]0\d/u;
/** A title as positions read it, whitespace collapsed and trimmed; null for a non-string or a title over 1024 characters. */
const positionText = (title: unknown) => typeof title === 'string' && title.length <= TEXT_LENGTH ? title.replace(/\s+/gu, ' ').trim() : null;

/**
 * The position a title starts with and the rest of it (whitespace collapsed and trimmed); null without one, with a number below 1,
 * for a non-string or a title over 1024 characters. A Disc and Track position is read first, so `1.01.Song` is Disc 1, Track 1.
 */
export function leadingTitlePosition(title: unknown): LeadingTitlePosition | null {
    const text = positionText(title);
    if (text === null) return null;
    const pair = discTrack.exec(text);
    if (pair) {
        const discNumber = Number(pair[1]), trackNumber = Number(pair[2]);
        return discNumber >= 1 && trackNumber >= 1 ? { discNumber, trackNumber, rest: text.slice(pair[0].length) } : null;
    }
    const single = trackOnly.exec(text), trackNumber = single ? Number(single[1]) : 0;
    return single && trackNumber >= 1 ? { discNumber: null, trackNumber, rest: text.slice(single[0].length) } : null;
}

/**
 * Every title's position in Album order, only when each title has one, all name a Disc Number or none does, and they strictly
 * increase by Disc Number (a missing one counting as 1), then Track Number; null otherwise, also for no titles or a non-array.
 * A lone title counts only with a Disc Number and a Track Number written with a leading zero (`1-01`, `1.01.`), so a single such
 * as `7 Rings`, `1.5 Seconds` or `1-2 Punch` keeps its number.
 */
export function leadingTitlePositions(titles: readonly unknown[]): LeadingTitlePosition[] | null {
    if (!Array.isArray(titles) || !titles.length) return null;
    if (titles.length === 1) {
        const position = leadingTitlePosition(titles[0]);
        return position && position.discNumber !== null && paddedDiscTrack.test(positionText(titles[0])!) ? [position] : null;
    }
    const positions: LeadingTitlePosition[] = [];
    for (const title of titles) {
        const position = leadingTitlePosition(title), last = positions[positions.length - 1];
        if (!position) return null;
        if (last) {
            if ((last.discNumber === null) !== (position.discNumber === null)) return null;
            const lastDisc = last.discNumber ?? 1, disc = position.discNumber ?? 1;
            if (lastDisc > disc || (lastDisc === disc && last.trackNumber >= position.trackNumber)) return null;
        }
        positions.push(position);
    }
    return positions;
}
