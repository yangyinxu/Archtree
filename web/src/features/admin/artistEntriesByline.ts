/**
 * Artist entry names joined by each entry's join phrase, or a comma without one; the last entry's phrase connects to nothing.
 * A standalone module so the catalog review route reads bylines without loading the import editor's patch helpers
 * (importDraftPatch.ts keeps the same rule for the import editor).
 */
export const entriesByline = (entries: readonly { name: string; joinPhrase: string | null }[]) =>
  entries.map((entry, index) => index === entries.length - 1 ? entry.name : `${entry.name}${entry.joinPhrase ?? ', '}`).join('');
