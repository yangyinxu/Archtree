/**
 * Luna suggestion ticks of the Review and publish summary. A pending suggestion the editor shows is resolved when it already
 * equals the current value, a conflict when acceptance would be refused (its value changed since analysis and is not automatic,
 * or Artist entries changed at all), and otherwise ticked for an empty value or one resting only on file tags, unticked for any
 * other. A publication approval carries the tick state it showed (`suggestionTicks`) and applies it in its own transaction:
 * ticked suggestions are accepted, unticked ones rejected and resolved ones accepted, all or nothing. Owner rules:
 * docs/business-rules.md (Administrator Album Imports, Luna bullet; Administrator Metadata Lookup, next-step bullet).
 */
import { AdminImportError, exact, invalidImport, objectId, record } from './adminImportContract';
import { retainBoundDecisions, sameDraftValue, type ImportDraftOrigins, type ImportDraftV2, type ImportSuggestionV2 } from './adminImportDraft';
import { importSuggestionsV2View, legacyManifestView } from './adminImportDraftCompat';
import { acceptDraftV2Suggestion, suggestionPath, type AdminImportDocument } from './adminImportService';
import { LUNA_SUGGESTION_LIMIT } from './adminImportLuna';
import { draftValueAt, draftWithinSizeLimit, originOf } from './adminImportValueState';

export type LunaTick = 'ticked' | 'unticked' | 'resolved' | 'conflict';
/** One answer per Draft v2 suggestion path: four Album values and three per file. */
export const LUNA_TICK_LIMIT = LUNA_SUGGESTION_LIMIT;
const empty = (value: unknown) => value === '' || value === null || (Array.isArray(value) && value.length === 0);
const entry = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * Whether a suggested value already is the current one: Artist entries by name, role and join phrase in order and a label by name
 * (keys and IDs aside), anything else exactly.
 */
export function sameSuggestedValue(path: string, current: unknown, value: unknown): boolean {
    if (path === 'album.label') return (entry(current)?.name ?? null) === (entry(value)?.name ?? null);
    if (path !== 'album.artists') return sameDraftValue(current, value);
    if (!Array.isArray(current) || !Array.isArray(value) || current.length !== value.length) return false;
    return current.every((item, index) => {
        const left = entry(item), right = entry(value[index]);
        return Boolean(left && right) && left!.name === right!.name && left!.role === right!.role && (left!.joinPhrase ?? null) === (right!.joinPhrase ?? null);
    });
}

/** The pending suggestions of the current generation that the editor shows (as adminImportDetail lists them), in stored order. */
export function shownPendingSuggestions(doc: AdminImportDocument): ImportSuggestionV2[] {
    const slots = new Set(legacyManifestView(doc.manifest).files.map(file => file.slotId));
    return importSuggestionsV2View(doc.suggestions, doc.analysis.generation, slots, doc._id.toHexString()).filter(suggestion => suggestion.decision === 'pending');
}

/** One shown suggestion's tick state against `draft`; `tagPaths` are the automatic paths resting only on file tags. */
export function lunaTick(draft: ImportDraftV2, origins: ImportDraftOrigins | undefined, suggestion: ImportSuggestionV2, tagPaths: ReadonlySet<string>): LunaTick {
    const path = suggestionPath(suggestion); if (!path) return 'conflict';
    let current: unknown; try { current = draftValueAt(draft, path); } catch { return 'conflict'; }
    if (sameSuggestedValue(path, current, suggestion.value)) return 'resolved';
    // As acceptance does: an automatic value is replaced whatever its baseline, except Artist entries, which must be unchanged.
    const automatic = path !== 'album.artists' && originOf(origins, path) === 'automatic';
    if (!sameDraftValue(current, suggestion.baseline) && !automatic) return 'conflict';
    return empty(current) || tagPaths.has(path) ? 'ticked' : 'unticked';
}

/**
 * Bounds an approval's optional `suggestionTicks` `{generation, ticked, unticked}` before its intent is fingerprinted: a
 * generation and at most 304 distinct suggestion IDs in all.
 */
export function boundSuggestionTicks(raw: unknown): void {
    const value = record(raw); exact(value, ['generation', 'ticked', 'unticked']);
    if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0 || !Array.isArray(value.ticked) || !Array.isArray(value.unticked)) invalidImport();
    const ids = [...value.ticked as unknown[], ...value.unticked as unknown[]];
    if (ids.length > LUNA_TICK_LIMIT || ids.some(id => !objectId(id)) || new Set(ids).size !== ids.length) invalidImport();
}

/**
 * Inside the publish transaction, after the approval's changes are saved to `draft`: applies the tick state the confirmation
 * showed. Every shown pending suggestion that is not resolved must be listed as ticked or unticked (409
 * ADMIN_IMPORT_REVIEW_REQUIRED otherwise), every listed one must still be shown pending in the generation the body names (409
 * ADMIN_IMPORT_SUGGESTION_STALE), and a ticked conflict is 409 ADMIN_IMPORT_FIELD_CONFLICT. Without `suggestionTicks` (an
 * editor that predates ticks) an unresolved pending suggestion asks for a reload. Accepted values become the administrator's
 * own, and decisions no longer bound to their entry or label are dropped; a refusal aborts the transaction.
 */
export function applySuggestionTicks(doc: AdminImportDocument, draft: ImportDraftV2, raw: unknown): void {
    const shown = shownPendingSuggestions(doc), states = new Map(shown.map(item => [item.id, lunaTick(draft, doc.draftOrigins, item, new Set())]));
    const unresolved = shown.filter(item => states.get(item.id) !== 'resolved');
    let ticked = new Set<string>(), unticked = new Set<string>();
    if (raw === undefined) { if (unresolved.length) throw new AdminImportError(409, 'ADMIN_IMPORT_RELOAD_REQUIRED'); }
    else {
        const body = raw as { generation: number; ticked: string[]; unticked: string[] };
        ticked = new Set(body.ticked); unticked = new Set(body.unticked);
        const ids = new Set(shown.map(item => item.id));
        // Ticks bind the generation they were shown for; a confirmation that showed none binds nothing but the shown set below.
        if ((ticked.size + unticked.size > 0 && body.generation !== doc.analysis.generation) || [...ticked, ...unticked].some(id => !ids.has(id))) throw new AdminImportError(409, 'ADMIN_IMPORT_SUGGESTION_STALE');
        if (unresolved.some(item => !ticked.has(item.id) && !unticked.has(item.id))) throw new AdminImportError(409, 'ADMIN_IMPORT_REVIEW_REQUIRED');
    }
    const before = structuredClone(draft);
    for (const item of shown) {
        const stored = doc.suggestions.find(value => value.id === item.id && value.generation === doc.analysis.generation);
        if (!stored) continue;
        const state = states.get(item.id);
        if (state !== 'resolved' && ticked.has(item.id)) {
            if (state === 'conflict') throw new AdminImportError(409, 'ADMIN_IMPORT_FIELD_CONFLICT');
            acceptDraftV2Suggestion(doc, draft, stored);
        }
        stored.decision = state === 'resolved' || ticked.has(item.id) ? 'accepted' : 'rejected';
    }
    if (!draftWithinSizeLimit(before, draft)) invalidImport();
    doc.decisions = retainBoundDecisions(doc.decisions, draft);
}
