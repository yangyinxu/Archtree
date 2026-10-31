import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useAdminText } from './AdminAccess';
import type { CatalogReview } from './catalogReviewApi';
import type { ApplyChoice, ProposedValues } from './catalogReviewApplyModel';
import type { CatalogReviewApplyCount as Count } from './CatalogReviewApply';
import { LunaStatus, useReviewBrief } from './catalogReviewBrief';
import { lookupBriefMessage, type LookupBrief } from './lookupBrief';
import type { Message } from './reviewLookupStatus';
import styles from './adminStyles';

export { CatalogReviewApplied } from './CatalogReviewApplied';

/** The Update original Album step's count, loaded with that step's chunk (it carries the step's model); one that cannot load counts nothing. */
const ApplyCount = lazy<ComponentType<ComponentProps<typeof Count>>>(() => import('./CatalogReviewApply')
  .then(module => ({ default: module.CatalogReviewApplyCount }), () => ({ default: () => null })));

/**
 * The first step's state: the brief's, naming the release applied (unless the free retry would check it again) and counting
 * possible releases alone, since the second step says what they need.
 */
function findMessage(brief: LookupBrief | null, title: string | null): Message {
  if (brief?.outcome === 'applied' && brief.next !== 'retry' && title) return { key: 'catalog_review.step_find_applied', values: { title } };
  if (brief?.outcome === 'matched' && brief.next === 'choose') return { key: 'catalog_review.step_find_matching' };
  if (brief?.outcome === 'possible') return { key: 'catalog_review.step_find_possible', values: { count: brief.releases } };
  return lookupBriefMessage(brief);
}

/**
 * The three steps of an Album completion above its lookup summary (owner rules: docs/business-rules.md, Catalog Visibility and
 * Administration, existing-Album reviews): find a release, answer questions, update the original Album, each with its state, the
 * first linking to the lookup summary and the second to its first open answer, its identity rows or the summary. A review
 * captured for lookup shows no state until its lookup read lands. The second step counts the lookup answers as the summary, the
 * workbench card and the Album page do, and the records to choose beside them. While it asks for Disc and Track Numbers or a release
 * choice, the third step only says that the update follows it and offers no button, so the page shows one next step. Once no
 * lookup step is left (no active run, Disc and Track Numbers, choice or free retry), nothing is left to answer, Luna AI is not
 * queued or running and the Update step's
 * selection is ready to apply (CatalogReviewApplyCount), a polite line says so and Review changes to apply, with that step's
 * count, is the primary button; it is also primary, without a count, when that step lists changes none of which is selected
 * (manual values), and a plain one otherwise while it lists changes. When the last answer makes the changes ready and leaves the
 * focus on the page or in a folded section, the focus moves to that button. An applied completion offers what was updated
 * instead, and Luna AI's status once Luna AI was used. It reads the review's brief (useReviewBrief) and the Update step's count (in
 * that step's chunk, with the title proposal's defaults), so its count is that step's. The chunk also holds an applied completion's list of what was updated
 * (CatalogReviewApplied.tsx); the Luna AI controls are their own chunk (CatalogReviewLuna.tsx).
 */
export function CatalogReviewSteps({ item, choices, proposed, stage, dirty, onNavigate }: { item: CatalogReview; choices: Readonly<Record<string, ApplyChoice>>;
  proposed?: ProposedValues; stage: 'draft' | 'review' | 'apply'; dirty: boolean; onNavigate: (stage: 'draft' | 'apply') => void }) {
  const t = useAdminText(), { locale } = useLocalization(), { captured, read, lookup, brief } = useReviewBrief(item);
  const [counted, setCounted] = useState<{ count: number; items: number; identityAnswers: number; ready: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null), waited = useRef(false);
  const release = lookup?.candidates.find(candidate => candidate.key === lookup.applied?.candidateKey)?.title ?? null;
  const applied = item.state === 'applied', active = ['queued', 'running'].includes(item.analysis.state), pending = captured && !applied && !read.data;
  const answers = brief?.answers ?? 0, records = counted?.identityAnswers ?? 0, count = counted?.count ?? 0, listed = counted?.items ?? 0;
  const when = (value: string) => new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const say = (message: Message) => t(message.key, message.values);
  const choose = brief?.outcome === 'matched' && brief.next === 'choose', counts = answers > 0 && !choose && brief?.next !== 'numbers';
  const find = pending || (applied && !brief) ? null : say(findMessage(brief, release));
  const answer = pending || applied || brief?.outcome === 'active' ? null : brief?.next === 'numbers' ? t('catalog_review.step_answers_numbers') : choose ? t('catalog_review.step_answers_choose')
    : answers || records ? [counts && t('catalog_review.step_answers_count', { count: answers }), records && t('catalog_review.step_answers_identity', { count: records })].filter(Boolean).join(' · ')
      : brief?.next === 'choose' ? t('catalog_review.step_answers_choose') : t('catalog_review.step_answers_none');
  // While the second step asks for numbers or a release choice, the update waits for it; otherwise the Update step's own count of
  // selected changes (manual values are listed there unselected).
  const numbers = brief?.next === 'numbers', waits = !applied && !pending && (numbers || choose || (brief?.next === 'choose' && !(answers || records)));
  const update = applied ? t('catalog_review.step_update_done', { date: when(item.applied!.at) }) : pending ? null
    : waits ? t(numbers ? 'catalog_review.step_update_after_numbers' : 'catalog_review.step_update_after_choose') : counted === null ? null
    : count > 0 ? t('catalog_review.step_update_count', { count }) : listed > 0 ? t('catalog_review.step_update_unselected', { count: listed }) : t('catalog_review.step_update_none');
  const clear = !applied && !pending && counted !== null && brief?.outcome !== 'active' && !brief?.next && answers + records === 0 && !active && item.capabilities.apply;
  const ready = clear && counted!.ready, primary = ready || (clear && count === 0 && listed > 0);
  // Something was left to answer here; once the last answer makes the changes ready, a focus it left behind moves to their step.
  useEffect(() => {
    if (!pending && (answers + records > 0 || brief?.next)) waited.current = true;
    const focus = document.activeElement;
    if (ready && waited.current && button.current && (!focus || focus === document.body || focus.closest('details:not([open])'))) { waited.current = false; button.current.focus(); }
  });
  const cell = (label: string, value: string | null, link: string | null) => <div><dt>{label}</dt>
    <dd>{value === null ? '—' : link ? <a href={`#${link}`}>{value}</a> : value}</dd></div>;
  return <>
    {item.state === 'reviewing' && <Suspense fallback={null}><ApplyCount item={item} choices={choices} proposed={proposed} onCount={setCounted} /></Suspense>}
    {/* At least 11rem per step: three columns from about 768 px, one step per row on a phone. */}
    <div role="group" aria-label={t('catalog_review.steps_label')}><dl className={styles.statusRow} style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(11rem,1fr))' }}>
      {cell(t('catalog_review.step_find'), find, applied ? null : 'catalog-review-lookup')}
      {cell(t('catalog_review.step_answer'), answer, applied ? null : counts ? 'catalog-review-answers' : records ? 'catalog-review-identities' : 'catalog-review-lookup')}
      {cell(t('catalog_review.step_update'), update, null)}</dl></div>
    {applied && item.analysis.generation > 0 && <LunaStatus item={item} />}
    {stage === 'draft' && ready && <p role="status">{t('catalog_review.steps_ready')}</p>}
    {stage === 'draft' && !applied && listed > 0 && !waits && <div className={styles.actions}><button ref={button} type="button" className={primary ? `${styles.button} ${styles.primary}` : styles.button}
      disabled={dirty} onClick={() => onNavigate('apply')}>{count > 0 ? t('catalog_review.view_changes', { count }) : t('catalog_review.view_changes_plain')}</button></div>}
    {applied && stage !== 'apply' && <div className={styles.actions}><button type="button" className={styles.button} onClick={() => onNavigate('apply')}>{t('catalog_review.applied_title')}</button></div>}
  </>;
}
