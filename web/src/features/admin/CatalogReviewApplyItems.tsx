import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useAdminText } from './AdminAccess';
import { entriesByline } from './artistEntriesByline';
import type { CatalogReview } from './catalogReviewApi';
import type { ApplyIdentityLine, ApplyItem, ApplyValue } from './catalogReviewApplyModel';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

/**
 * The read-only parts of an existing-Album review's Update original Album step that its confirmation repeats frozen: an item's
 * saved and new values, the identities applying reuses or creates, and the note on Album Credits never copied to tracks. Kept apart
 * from the step's model and reads, so the confirmation's chunk carries neither.
 */

type Credits = Extract<ApplyValue, { kind: 'credits' }>['current'];
/** A track as the review lists it: its position in the draft and its title. */
export const reviewTrackName = (item: CatalogReview, slotId: string) => {
  const index = item.draft.tracks.findIndex(track => track.slotId === slotId);
  return `${index + 1} · ${item.draft.tracks[index]?.title || '—'}`;
};

/** An item's saved and new values; Credits as their byline, then other roles by name and role. */
export function ApplyItemValues({ item }: { item: ApplyItem }) {
  const t = useAdminText(), { t: shared } = useLocalization(), value = item.value;
  const credits = (list: Credits) => [entriesByline(list.filter(credit => credit.subjectType === 'artist' && (credit.role === 'primary' || credit.role === 'featured'))),
    ...list.filter(credit => credit.subjectType !== 'artist' || (credit.role !== 'primary' && credit.role !== 'featured'))
      .map(credit => `${credit.name} · ${credit.role === 'legacyUnspecified' ? t('catalog.unspecified') : shared(`catalog.credit.${credit.role}` as MessageKey)}`)].filter(Boolean).join('; ') || '—';
  const rows = (rows: number, noFile: number) => t('catalog_review.expected_rows', { rows, noFile });
  const [before, after] = value.kind === 'value' ? [reviewValueText(value.baseline), reviewValueText(value.value)]
    : value.kind === 'tracklist' ? [value.keptRows === null ? t('catalog.album_expected_none') : rows(value.keptRows, value.keptNoFile), rows(value.rows, value.noFile)]
      : [credits(value.current), credits(value.next)];
  return <>
    <div className={styles.diff}><div><strong>{t('catalog_review.original_value')}</strong><pre>{before}</pre></div>
      <div><strong>{t('catalog_review.saved_value')}</strong><pre>{after}</pre></div></div>
    {value.kind === 'member' && value.removed.length > 0 && <p>{t('catalog_review.credits_removed', { credits: value.removed.map(credit => credit.name).join(', ') })}</p>}
    {value.kind === 'member' && value.attribution && <p>{t('catalog_review.attribution_change', {
      from: t(value.attribution.from === 'unknown' ? 'catalog.unknown' : value.attribution.from === 'documented' ? 'catalog.documented' : 'catalog_review.attribution_none'),
      to: t('catalog.documented') })}</p>}
    {(value.kind === 'credits' || value.kind === 'member') && value.idsOnly && <p className={styles.muted}>{t('catalog_review.ids_only')}</p>}
  </>;
}

/** The label of an item: what it updates, on which target, and which field. */
export function useApplyItemLabel() {
  const t = useAdminText();
  return (item: ApplyItem) => t('catalog_review.select_field', { type: t(`catalog_review.target_${item.scope}`), target: item.title || t('common.untitled'), field: t(`field.${item.field}`) });
}

/** A confirmation renders the selected frozen values, never a refreshed live project. */
export function ApplyItemSummary({ item }: { item: ApplyItem }) {
  const label = useApplyItemLabel();
  return <article className={styles.card}><h3>{label(item)}</h3><ApplyItemValues item={item} /></article>;
}

/** Album Credits are never copied to tracks; the tracks still crediting an Artist the Album no longer credits are named. */
export function ApplyAlbumNote({ item, namingReplaced }: { item: CatalogReview; namingReplaced: string[] }) {
  const t = useAdminText();
  return <div className={styles.notice}><p>{t('catalog_review.album_credits_not_copied')}</p>
    {namingReplaced.length > 0 && <p>{t('catalog_review.members_naming_replaced', { tracks: namingReplaced.map(slotId => reviewTrackName(item, slotId)).join(', ') })}</p>}</div>;
}

/** The Artists and label Organization applying reuses or creates, each MusicBrainz ID it records or replaces, and those still undecided. */
export function ApplyIdentityLines({ lines }: { lines: ApplyIdentityLine[] }) {
  const t = useAdminText();
  const hidden = (record: { hidden: boolean }) => record.hidden ? ` · ${t('catalog_review.identity_visibility', { visibility: t('field.hidden') })}` : '';
  const outcome = (line: ApplyIdentityLine) => line.outcome === 'reuse' ? `${t('catalog_review.identity_bound', { name: line.records[0].name })}${hidden(line.records[0])}`
    : line.outcome === 'create' ? `${t('catalog_review.identity_creates', { name: line.records[0].name })}${hidden(line.records[0])}`
      : line.outcome === 'conflicting' ? `${t('catalog_review.identity_conflicting')} ${line.records.map(record => `${record.name}${hidden(record)}`).join(', ')}` : '';
  return <section className={styles.card}><h3>{t('catalog_review.identities_title')}</h3><ul>{lines.map(line => <li key={line.handle}>
    <strong>{line.scope === 'label' ? `${t('duplicates.label')} · ${line.name}` : line.name}</strong>
    {[outcome(line), (line.outcome === 'undecided' || line.needsAnswer) && t('catalog_review.needs_decision'), line.idWrite && (line.idWrite.replaces === null
      ? t('catalog_review.identity_records_id', { id: line.idWrite.musicBrainzId })
      : t('duplicates.replace_id', { name: line.idWrite.record ?? line.name, previous: line.idWrite.replaces, id: line.idWrite.musicBrainzId }))]
      .filter(Boolean).map(text => <p key={String(text)}>{text}</p>)}</li>)}</ul></section>;
}
