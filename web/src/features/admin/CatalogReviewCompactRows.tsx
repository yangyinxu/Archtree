import { useAdminText } from './AdminAccess';
import type { CatalogReview, ReviewField } from './catalogReviewApi';
import type { ApplyItem } from './catalogReviewApplyModel';
import styles from './adminStyles';

/** A long Album (as catalogReviewEdits.ts counts one): its uniform number fills and title changes are grouped into one line each. */
const LONG_ALBUM = 25;
/** One compact row: what it names (a Track's new title, an Album value or a grouped line) and what changes about it. */
type Row = { key: string; title: string; parts: string[] };
/** The rows that apply, in order. */
const present = (rows: (Row | false)[]) => rows.filter((row): row is Row => Boolean(row));

/**
 * The compact rows of an Album completion's update (docs/features/admin-workbench.md, the confirmation and the applied view): one
 * row per affected Track, its new title with its new Disc and Track Number and a title change, then one per Album value, then one
 * line for the members whose Credits change. `fields` and `members` are what the update writes and `item.draft` holds the new
 * values. Before the update (`done` false) the wording is neutral ("标题修改"); after it, each row says it was updated. On a long
 * Album, numbers that fill empty values (`items` gives each one's original value; without them, as on the applied view, the
 * review's captured source does) and title changes are grouped into one line each, while a number that replaces a stored value
 * keeps its own row.
 */
export function CatalogReviewCompactRows({ item, fields, members, items, done }: { item: CatalogReview; fields: readonly ReviewField[]; members: readonly string[];
  items?: readonly ApplyItem[]; done: boolean }) {
  const t = useAdminText(), tracks = item.draft.tracks, long = tracks.length >= LONG_ALBUM;
  const status = (key: 'title' | 'change') => t(key === 'title' ? (done ? 'catalog_review.compact_title_done' : 'catalog_review.compact_title')
    : done ? 'catalog_review.compact_done' : 'catalog_review.compact_change');
  const fieldsOf = (slotId: string) => new Set(fields.filter(value => value.scope === 'track' && value.slotId === slotId).map(value => value.field));
  // A number replaces a stored value when its item shows a non-empty original; without items, when the review's captured source
  // held one for a number the update wrote.
  const replaces = (slotId: string) => items ? items.some(entry => entry.slotId === slotId && (entry.field === 'discNumber' || entry.field === 'trackNumber')
    && entry.value.kind === 'value' && entry.value.baseline !== null && entry.value.baseline !== '')
    : (() => { const written = fieldsOf(slotId), stored = item.source.tracks.find(track => track.slotId === slotId);
      return Boolean(stored && (written.has('discNumber') && stored.discNumber != null || written.has('trackNumber') && stored.trackNumber !== null)); })();
  const rows: Row[] = [];
  let filled = 0, titled = 0;
  for (const track of tracks) {
    const changed = fieldsOf(track.slotId), numbers = changed.has('discNumber') || changed.has('trackNumber'), title = changed.has('title');
    if (!numbers && !title) continue;
    const grouped = long && numbers && !replaces(track.slotId);
    if (grouped) filled++;
    if (long && title) titled++;
    const parts = [numbers && !grouped ? ((track.discNumber ?? null) !== null ? t('catalog_review.compact_position', { disc: track.discNumber!, track: track.trackNumber ?? '—' })
      : t('catalog_review.compact_track', { track: track.trackNumber ?? '—' })) : null, title && !long ? status('title') : null].filter((part): part is string => Boolean(part));
    if (parts.length) rows.push({ key: track.slotId, title: track.title || '—', parts: numbers && !title && !long ? [...parts, ...done ? [status('change')] : []] : parts });
  }
  const album: Row[] = fields.filter(value => value.scope === 'album').map(value => ({ key: `album:${value.field}`,
    title: `${t('catalog_review.target_album')} · ${t(`field.${value.field}`)}`, parts: [status('change')] }));
  const groups = present([filled > 0 && { key: 'numbers', title: t(done ? 'catalog_review.compact_numbers_done' : 'catalog_review.compact_numbers', { count: filled }), parts: [] },
    titled > 0 && { key: 'titles', title: t(done ? 'catalog_review.compact_titles_done' : 'catalog_review.compact_titles', { count: titled }), parts: [] }]);
  const credits = present([members.length > 0 && { key: 'members', title: t('catalog_review.compact_members', { count: members.length }), parts: [status('change')] }]);
  return <ul className={styles.compact}>{[...groups, ...rows, ...album, ...credits].map(row => <li key={row.key}>
    <span>{row.title}</span>{row.parts.length > 0 && <span className={styles.meta}>{row.parts.join(' · ')}</span>}</li>)}</ul>;
}
