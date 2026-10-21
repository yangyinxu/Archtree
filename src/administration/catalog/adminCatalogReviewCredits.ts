/**
 * The Credits an applied existing-Album review writes, rebuilt from the Credits the review captured (owner rules: docs/business-rules.md,
 * Catalog Visibility and Administration). Selected Artist entries take the positions of the Credits they replace, in entry order;
 * extra entries follow the last of them, and they lead the list when it had none. Every other Credit keeps its subject, role and
 * relative order. A label replaces the subject of the first label Credit, or follows the last Artist Credit when there is none.
 * Join phrases follow the canonical Credit lifecycle (keepJoinPhrasesWithSuccessors), and an entry's own phrase is stored only
 * between two adjacent entries. Orders are renumbered by position. No I/O.
 */
import { createHash } from 'node:crypto';
import { keepJoinPhrasesWithSuccessors, normalizeCatalogCredits, normalizeStoredCatalogCredits, withoutJoinPhrase, type CatalogCredit } from '../../models/catalogCredit';
import type { ImportArtistEntry } from '../import/adminImportDraft';
import type { CatalogReviewCapturedCredit } from './adminCatalogReviewContract';

/** A captured stored list as the canonical Credit lifecycle reads it: stored order, and a join phrase only where one was stored. */
export const capturedCatalogCredits = (captured: readonly CatalogReviewCapturedCredit[]): CatalogCredit[] => captured.map((credit, order) => ({
    creditId: credit.creditId, subjectType: credit.subjectType, subjectId: credit.subjectId, role: credit.role, order, ...(credit.joinPhrase !== null ? { joinPhrase: credit.joinPhrase } : {})
}));

/** Whether two lists hold the same Credits with the same phrases at the same positions, as stored lists are read; unreadable is never the same. */
export function sameCredits(left: readonly CatalogCredit[], right: readonly CatalogCredit[]): boolean {
    try { return JSON.stringify(normalizeStoredCatalogCredits(left)) === JSON.stringify(normalizeStoredCatalogCredits(right)); } catch { return false; }
}

/** A deterministic Credit ID (the Credit ID format: 8 to 100 of `[A-Za-z0-9_-]`) for a Credit an apply creates, from its seed. */
export const reviewCreditId = (seed: unknown) => `review_${createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 40)}`;

/** The Credits an Album's entries replace: its primary and featured Artist Credits. */
export const albumReplaced = (credit: CatalogCredit) => credit.subjectType === 'artist' && (credit.role === 'primary' || credit.role === 'featured');
/** The Credits a member's entries replace: its primary and featured Artist Credits and its legacy unspecified Credits of the Artists they name. */
export const memberReplaced = (named: ReadonlySet<string>) => (credit: CatalogCredit) =>
    albumReplaced(credit) || (credit.subjectType === 'artist' && credit.role === 'legacyUnspecified' && named.has(credit.subjectId));

/** One selected entry with the Artist it resolved to and its Credit ID (a captured Credit's when the entry shows it). */
export type ReviewEntryCredit = { entry: ImportArtistEntry; subjectId: string; creditId: string };
/** What an apply changes in one owner's Credits: its Artist entries (and the Credits they replace) and/or the label. */
export type ReviewCreditChange = {
    entries?: { credits: readonly ReviewEntryCredit[]; replaced: (credit: CatalogCredit) => boolean };
    label?: { subjectId: string; creditId: string };
};

/**
 * Rebuilds `stored` with `change`: the entries first, then the label, then one pass of keepJoinPhrasesWithSuccessors against
 * `stored`, then each entry's own phrase where the next Credit is the next entry. An entry Credit that keeps a stored Credit's ID
 * starts from that Credit's phrase, so it keeps it while the Credit after it is unchanged; a new one starts without. A label whose
 * subject is already the first label Credit's leaves that Credit as it is. `validate` (default) normalizes the result for a
 * write and may throw CatalogCreditValidationError (over 50 Credits, a subject credited twice in one role); without it only the
 * orders are renumbered, so a confirmation can still show what would be written.
 */
export function rebuildReviewCredits(stored: readonly CatalogCredit[], change: ReviewCreditChange, options: { validate?: boolean } = {}): CatalogCredit[] {
    const storedPhrase = new Map(stored.map(credit => [credit.creditId, credit.joinPhrase] as const));
    let list: CatalogCredit[] = stored.map(credit => ({ ...credit }));
    const entryCredits = (change.entries?.credits ?? []).map((item): CatalogCredit => {
        const phrase = storedPhrase.get(item.creditId);
        return { creditId: item.creditId, subjectType: 'artist', subjectId: item.subjectId, role: item.entry.role, order: 0, ...(phrase !== undefined ? { joinPhrase: phrase } : {}) };
    });
    if (change.entries) {
        const { replaced } = change.entries, positions = stored.flatMap((credit, index) => replaced(credit) ? [index] : []), last = positions[positions.length - 1];
        const next: CatalogCredit[] = positions.length ? [] : [...entryCredits];
        stored.forEach((credit, index) => {
            const at = positions.indexOf(index);
            if (at === -1) { next.push({ ...credit }); return; }
            if (at < entryCredits.length) next.push(entryCredits[at]);
            if (index === last) next.push(...entryCredits.slice(positions.length));
        });
        list = next;
    }
    if (change.label) {
        const { subjectId, creditId } = change.label, index = list.findIndex(credit => credit.subjectType === 'organization' && credit.role === 'label');
        if (index >= 0 && list[index].subjectId !== subjectId) {
            const phrase = list[index].joinPhrase;
            list[index] = { creditId, subjectType: 'organization', subjectId, role: 'label', order: 0, ...(phrase !== undefined ? { joinPhrase: phrase } : {}) };
        } else if (index < 0) {
            let lastArtist = -1;
            list.forEach((credit, at) => { if (credit.subjectType === 'artist') lastArtist = at; });
            list.splice(lastArtist + 1, 0, { creditId, subjectType: 'organization', subjectId, role: 'label', order: 0 });
        }
    }
    list = keepJoinPhrasesWithSuccessors(stored, list);
    const entries = change.entries?.credits ?? [];
    entries.forEach((item, at) => {
        const index = list.findIndex(credit => credit.creditId === item.creditId);
        if (at + 1 >= entries.length || list[index + 1]?.creditId !== entries[at + 1].creditId) return;
        const phrase = item.entry.joinPhrase;
        list[index] = phrase === null ? withoutJoinPhrase(list[index]) : { ...withoutJoinPhrase(list[index]), joinPhrase: phrase };
    });
    return options.validate === false ? list.map((credit, order) => ({ ...credit, order })) : normalizeCatalogCredits(list);
}
