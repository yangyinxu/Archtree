import type { ImportDraftV2, ImportSuggestionV2 } from './adminApi';

/**
 * Luna ticks on the Web: the summary keeps the administrator's toggles over the server's tick state, and the publication
 * confirmation sends the result (src/administration/import/adminImportLunaTicks.ts applies it). Pure. Owner rules:
 * docs/business-rules.md (Administrator Album Imports, Luna bullet).
 */
export type LunaTick = 'ticked' | 'unticked' | 'resolved' | 'conflict';
/** Workspace buffer of one import's tick toggles (suggestion ID → ticked), written by the summary and read by the confirmation. */
export const lunaTicksKey = (id: string) => `luna-ticks:${id}`;
/** The draft path a suggestion proposes a value for. */
export const suggestionPath = (suggestion: Pick<ImportSuggestionV2, 'scope' | 'slotId' | 'field'>) =>
  suggestion.scope === 'album' ? `album.${suggestion.field}` : `tracks.${suggestion.slotId}.${suggestion.field}`;

/**
 * Whether a pending suggestion is ticked: never when resolved, a conflict or its path changed in this approval, otherwise the
 * administrator's toggle, else the server's default (`ticked` for an empty value or one resting only on file tags).
 */
export const ticked = (suggestion: Pick<ImportSuggestionV2, 'id' | 'scope' | 'slotId' | 'field'>, tick: LunaTick | undefined, toggles: Readonly<Record<string, boolean>>, changed: ReadonlySet<string> = new Set()) =>
  tick !== undefined && tick !== 'resolved' && tick !== 'conflict' && !changed.has(suggestionPath(suggestion)) && (toggles[suggestion.id] ?? tick === 'ticked');

/**
 * The approval's `suggestionTicks`: every pending suggestion of the shown project, ticked or unticked as the confirmation shows
 * it (a resolved one is listed as unticked; the server accepts it either way).
 */
export function suggestionTicks(item: { analysis: { generation: number }; suggestions: readonly ImportSuggestionV2[] }, ticks: ReadonlyMap<string, LunaTick>, toggles: Readonly<Record<string, boolean>>, changed: ReadonlySet<string>) {
  const pending = item.suggestions.filter(suggestion => suggestion.decision === 'pending');
  const on = pending.filter(suggestion => ticked(suggestion, ticks.get(suggestion.id), toggles, changed)).map(suggestion => suggestion.id);
  return { generation: item.analysis.generation, ticked: on, unticked: pending.map(suggestion => suggestion.id).filter(id => !on.includes(id)) };
}

/** `draft` with each ticked suggestion's value written at its path, as the approval writes it. */
export function tickedDraft(draft: ImportDraftV2, suggestions: readonly ImportSuggestionV2[], ids: readonly string[]): ImportDraftV2 {
  const next = structuredClone(draft);
  for (const suggestion of suggestions) {
    if (!ids.includes(suggestion.id)) continue;
    const holder = (suggestion.scope === 'album' ? next.album : next.tracks.find(track => track.slotId === suggestion.slotId)) as Record<string, unknown> | undefined;
    if (holder) holder[suggestion.field] = structuredClone(suggestion.value);
  }
  return next;
}

/**
 * The saved draft with every pending suggestion's value written in: the server reads identity candidates for these too
 * (/duplicate-candidates), so the confirmation preselects a ticked title, entry or label as if it were applied.
 */
export const lunaProposals = (item: { draft: ImportDraftV2; suggestions: readonly ImportSuggestionV2[] }) =>
  tickedDraft(item.draft, item.suggestions, item.suggestions.filter(suggestion => suggestion.decision === 'pending').map(suggestion => suggestion.id));
