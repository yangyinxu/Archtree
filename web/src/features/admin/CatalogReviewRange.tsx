import { lazy, Suspense, useEffect, useId, useMemo, type ComponentProps, type ComponentType } from 'react';
import { useAdminText } from './AdminAccess';
import type { CatalogReview, ReviewDraft } from './catalogReviewApi';
import type { ApplyChoice, ApplyItem } from './catalogReviewApplyModel';
import type * as Items from './CatalogReviewApplyItems';
import { longAlbum, withEdits, withProposedNumbers, type ReviewEditorDerived, type ReviewEditorView, type ReviewEdits } from './catalogReviewEdits';
import { reviewValueText } from './reviewValueText';
import { useReviewApplyModel } from './useReviewApplyModel';
import styles from './adminStyles';

/** Stands in for the value views when their chunk cannot load (a deploy replaced it); the choices beside them stay usable. */
function ItemsUnavailable() { const t = useAdminText(); return <p role="alert">{t('common.reload')}</p>; }
/** The read-only views the Update step shares with its confirmation, loaded as their own chunk. */
const view = <P extends object>(pick: (module: typeof Items) => ComponentType<P>) =>
  lazy<ComponentType<P>>(() => import('./CatalogReviewApplyItems').then(module => ({ default: pick(module) }), () => ({ default: ItemsUnavailable })));
const ApplyItemValues = view<ComponentProps<typeof Items.ApplyItemValues>>(module => module.ApplyItemValues);
const ApplyIdentityLines = view<ComponentProps<typeof Items.ApplyIdentityLines>>(module => module.ApplyIdentityLines);

/**
 * The review page's update range (owner rules: docs/business-rules.md, Catalog Visibility and Administration, applying an
 * existing-Album review; docs/features/admin-workbench.md, the update range): a disclosure whose summary counts the selected changes
 * (in items, since member lines are not fields) of the draft as edited, unsaved edits and the proposed numbers included
 * (catalogReviewApplyModel.ts on the editor's draft with the title proposal's defaults, `view` from the proposal table, else the
 * edits alone), and which opens to adjust them in groups: the numbers (one group per disc on a long Album), the Track titles, the
 * Album date, the Album title, and the Artist entries, label, member Credits and expected tracklist; each group's checkbox is mixed
 * while only some of its items are selected, and a nested disclosure lists each item with its original and new value, a value that
 * fills or replaces a catalog value marked so in text. An item a hold keeps out is a disabled box with its reason. Below, the
 * Artist and label records the selection owns and, while one needs an answer, a link to the identity rows; then members the
 * selected numbers would leave at one position or out of range. Choices carry their item's basis, so they survive saves
 * (`onChoose`). It reports the draft a save writes, the edits and the selected proposed numbers only, and the count (`onDerived`).
 */
export function CatalogReviewRange({ item, base, edits, view: shownView, choices, disabled, onChoose, onDerived }: { item: CatalogReview; base: ReviewDraft;
  edits: ReviewEdits; view: ReviewEditorView | null; choices: Readonly<Record<string, ApplyChoice>>; disabled: boolean;
  onChoose: (choices: Record<string, ApplyChoice>) => void; onDerived: (derived: ReviewEditorDerived) => void }) {
  const t = useAdminText(), id = useId();
  const shown = useMemo(() => shownView?.shown ?? withEdits(base, edits), [shownView, base, edits]);
  const { model, count } = useReviewApplyModel(item, choices, { draft: shown, proposed: shownView?.proposed });
  const selected = model.items.filter(entry => entry.selected).map(entry => entry.key), keys = selected.join(' ');
  const draft = useMemo(() => withProposedNumbers(base, edits, shownView?.numbers ?? {}, key => selected.includes(key)), [base, edits, shownView, keys]);
  useEffect(() => onDerived({ base, edits, draft, count }), [draft, count]);
  if (!model.items.length) return null;
  const name = (slotId: string) => { const index = shown.tracks.findIndex(track => track.slotId === slotId); return `${index + 1} · ${shown.tracks[index]?.title || '—'}`; };
  const hold = (entry: ApplyItem) => entry.hold === 'conflict' ? t('catalog_review.answer_conflict_first') : entry.hold === 'tracklist' ? t('catalog_review.number_with_tracklist')
    : entry.hold === 'numbers' ? t('catalog_review.title_needs_numbers') : t('catalog_review.off_row', { tracks: entry.offSlotIds.map(name).join(', ') });
  const choose = (entries: ApplyItem[], checked: boolean) => onChoose(Object.fromEntries(entries.map(entry => [entry.key, { checked, basis: entry.basis }])));
  const groups: [string, string, ApplyItem[]][] = [], plain = model.items.filter(entry => !entry.member);
  const add = (key: string, label: string, entries: ApplyItem[]) => { if (entries.length) groups.push([key, label, entries]); };
  const numbers = plain.filter(entry => entry.field === 'discNumber' || entry.field === 'trackNumber');
  if (longAlbum(shown.tracks.length)) {
    const disc = (entry: ApplyItem) => shown.tracks.find(track => track.slotId === entry.slotId)?.discNumber ?? 1;
    for (const number of [...new Set(numbers.map(disc))].sort((left, right) => left - right))
      add(`numbers:${number}`, t('catalog_review.range_numbers_disc', { disc: number }), numbers.filter(entry => disc(entry) === number));
  } else add('numbers', t('catalog_review.range_numbers'), numbers);
  const titles = plain.filter(entry => entry.scope === 'track' && entry.field === 'title');
  add('titles', t('catalog_review.range_titles', { count: titles.length }), titles);
  add('date', t('field.releaseDate'), plain.filter(entry => entry.field === 'releaseDate'));
  add('title', t('catalog_review.range_album_title'), plain.filter(entry => entry.scope === 'album' && entry.field === 'title'));
  add('credits', t('catalog_review.range_credits'), model.items.filter(entry => entry.member || ['artists', 'label', 'expectedTracklist'].includes(entry.field)));
  const compare = (value: Extract<ApplyItem['value'], { kind: 'value' }>) => value.baseline === null || value.baseline === ''
    ? <><span className={styles.badge}>{t('catalog_review.proposal_fill')}</span> {reviewValueText(value.value)}</>
    : <><span className={styles.badge}>{t('catalog_review.proposal_overwrite')}</span> <s>{reviewValueText(value.baseline)}</s> → {reviewValueText(value.value)}</>;
  return <details className={styles.details} id="catalog-review-range"><summary>{t('catalog_review.range_summary', { count })}</summary>
    {groups.map(([key, label, entries]) => {
      const open = entries.filter(entry => entry.hold === null), on = open.filter(entry => entry.selected).length;
      return <section key={key} className={styles.card} aria-label={label}>
        <label className={styles.check}><input type="checkbox" data-group={key} checked={on > 0 && on === open.length} disabled={disabled || !open.length}
          ref={input => { if (input) input.indeterminate = on > 0 && on < open.length; }} onChange={event => choose(open, event.target.checked)} />
          <strong>{label}</strong> <span className={styles.meta}>{t('catalog_review.range_group_count', { selected: on, total: entries.length })}</span></label>
        <details className={styles.details}><summary>{t('catalog_review.range_items')}</summary><ul className={styles.cards}>{entries.map(entry => <li key={entry.key}>
          <label className={styles.check}><input type="checkbox" data-field={entry.key} checked={entry.selected} disabled={disabled || entry.hold !== null}
            aria-describedby={entry.hold ? `${id}-${entry.key}` : undefined} onChange={event => choose([entry], event.target.checked)} />
            <span>{`${t(`field.${entry.field}`)} · ${entry.title || t('common.untitled')}`}
              {entry.value.kind === 'value' && <><br />{compare(entry.value)}</>}</span></label>
          {entry.hold && <p id={`${id}-${entry.key}`} className={styles.muted}>{hold(entry)}</p>}
          {entry.value.kind !== 'value' && <Suspense fallback={null}><ApplyItemValues item={entry} /></Suspense>}</li>)}</ul></details>
      </section>;
    })}
    {model.selection.identities.length > 0 && <Suspense fallback={null}><ApplyIdentityLines lines={model.selection.identities} /></Suspense>}
    {model.blocking.identities.length > 0 && <p>{t('catalog_review.identity_answers_first', { names: model.blocking.identities.join(', ') })}{' '}
      <a href="#catalog-review-identities">{t('catalog_review.range_identities_link')}</a></p>}
    {model.blocking.positions.map(block => <p key={block.reason} className={styles.error}>{t(`catalog_review.positions_${block.reason}`, { tracks: block.slotIds.map(name).join(', ') })}</p>)}
  </details>;
}
