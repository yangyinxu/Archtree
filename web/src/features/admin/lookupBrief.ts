import { z } from 'zod';
import type { Message } from './reviewLookupStatus';

/**
 * An Album completion's lookup brief as the server sends it on workbench cards and the Album page's eligibility read
 * (CatalogReviewLookupBrief, src/administration/lookup/catalogReviewLookupBrief.ts), and as the review page reads its own lookup
 * view (reviewLookupBrief.ts): enums and two bounded counts, never text.
 */
export const lookupBriefSchema = z.object({ state: z.enum(['queued', 'running', 'retrying', 'complete', 'failed']),
  outcome: z.enum(['active', 'applied', 'matched', 'possible', 'none', 'unavailable']), answers: z.number().int().nonnegative().max(407),
  next: z.enum(['retry', 'choose', 'numbers']).nullable(), releases: z.number().int().nonnegative().max(25) }).strict();
export type LookupBrief = z.infer<typeof lookupBriefSchema>;

/**
 * The brief in words: an admin text key and its variables, from the family `lookup_brief` (a workbench card's or a step's state)
 * or `open_lookup` (the Album page's whole open-completion note). No run reads as not run; a release applied from iTunes whose
 * MusicBrainz check the free retry offers says so. Never names AI or Luna.
 */
export function lookupBriefMessage(brief: LookupBrief | null | undefined, family: 'lookup_brief' | 'open_lookup' = 'lookup_brief'): Message {
  const say = (name: string, values?: Message['values']): Message => ({ key: `catalog_review.${family}_${name}`, values });
  if (!brief) return say('not_run');
  switch (brief.outcome) {
    case 'active': return say(brief.state);
    case 'applied': return brief.next === 'choose' ? say('applied_again') : brief.next === 'retry' ? say('applied_retry')
      : brief.answers ? say('applied_answers', { count: brief.answers }) : say('applied');
    case 'matched': return say(brief.next === 'choose' ? 'choose' : 'not_used');
    case 'possible': return say(brief.next === 'numbers' ? 'possible_numbers' : 'possible_choose', { count: brief.releases });
    case 'none': return say('no_match');
    default: return say(brief.next === 'retry' ? 'retry' : 'unavailable');
  }
}

/** Whether the lookup asks the administrator for something: an answer, a choice, numbers or the free retry. */
export const lookupBriefNeedsYou = (brief: LookupBrief | null | undefined) => Boolean(brief && (brief.answers > 0 || brief.next !== null));
/**
 * Whether the lookup path leads the completion: it asks for something (an answer, a choice of an offered or possible release,
 * numbers or the free retry), runs, or applied a release. A failed Luna AI run is then one quiet secondary line, never the thing
 * to handle.
 */
export const lookupBriefLeads = (brief: LookupBrief | null | undefined) => Boolean(brief && (lookupBriefNeedsYou(brief) || brief.outcome === 'active' || brief.outcome === 'applied'));
