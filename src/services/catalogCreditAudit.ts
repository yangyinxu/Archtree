import { normalizeCatalogCredits } from '../models/catalogCredit';

interface SubjectWindow {
    knownIds: ReadonlySet<string>;
    complete: boolean;
}

/** Deduplicates exact subject lookups across owners while charging one shared budget. */
export const planCreditSubjectLookups = (
    owners: ReadonlyArray<{ credits?: unknown }>,
    artists: SubjectWindow,
    organizations: SubjectWindow,
    remainingReferences: number
) => {
    const artistIds = new Set<string>();
    const organizationIds = new Set<string>();
    for (const owner of owners) {
        let credits: ReturnType<typeof normalizeCatalogCredits>;
        try { credits = normalizeCatalogCredits(owner.credits); } catch { continue; }
        for (const credit of credits) {
            const window = credit.subjectType === 'artist' ? artists : organizations;
            const targets = credit.subjectType === 'artist' ? artistIds : organizationIds;
            if (window.complete || window.knownIds.has(credit.subjectId) || targets.has(credit.subjectId)) continue;
            if (remainingReferences <= 0) continue;
            targets.add(credit.subjectId);
            remainingReferences -= 1;
        }
    }
    return { artistIds, organizationIds, remainingReferences };
};
