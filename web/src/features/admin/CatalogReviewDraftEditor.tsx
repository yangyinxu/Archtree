import { Link } from 'react-router';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useAdminText } from './AdminAccess';
import type { CatalogReview, ReviewDraft } from './catalogReviewApi';
import { entriesByline } from './artistEntriesByline';
import styles from './adminStyles';

type Track = ReviewDraft['tracks'][number];

/**
 * The private review draft editor. The Album title and date and each Track's title, Disc Number (only on a track whose source
 * captured one) and Track Number are editable; Album order stays derived from Disc and Track Numbers. The ordered Artist entries
 * with their join phrases, the label, visibility and the review-only values (expected tracklist, each Track's Artist entries) are
 * read-only context: every change returns the whole draft with them untouched, and the page saves only the changed editable
 * values (reviewDraftChanges). A review created before Credits were captured (no source track captured
 * a Disc Number) holds only its earlier Artist name, which may not be any Credit of the Album: it shows that name alone, never
 * as a Credits list.
 */
export function CatalogReviewDraftEditor({ draft, source, filenames, disabled, manageAlbumHref, onChange }: {
  draft: ReviewDraft; source: CatalogReview['source']; filenames: ReadonlyArray<{ slotId: string; relativePath: string }>;
  disabled: boolean; manageAlbumHref: string; onChange: (draft: ReviewDraft) => void;
}) {
  const t = useAdminText(), { t: sharedText } = useLocalization();
  const album = (patch: Partial<Pick<ReviewDraft['album'], 'title' | 'releaseDate'>>) => onChange({ ...draft, album: { ...draft.album, ...patch } });
  const track = (slotId: string, patch: Partial<Omit<Track, 'slotId'>>) => onChange({ ...draft, tracks: draft.tracks.map(item => item.slotId === slotId ? { ...item, ...patch } : item) });
  const number = (value: string) => value === '' ? null : Number(value);
  const captured = new Set(source.tracks.filter(item => item.discNumber !== undefined).map(item => item.slotId));
  const legacy = source.tracks.length > 0 && captured.size === 0;
  const { artists, label, releaseDate: release } = draft.album;
  return <fieldset className={styles.editor} disabled={disabled}>
    <label className={styles.field}>{t('field.title')}<input className={styles.input} value={draft.album.title} maxLength={300} onChange={event => album({ title: event.target.value })} /></label>
    <div className={styles.field}><label className={styles.field}>{t('catalog_review.artist_read_only')}<input className={styles.input} aria-label={t('field.artistName')} value={entriesByline(artists)} readOnly /></label>
      {legacy && <p className={styles.meta}>{t('catalog_review.manage_copy')}</p>}
      {!legacy && artists.length > 0 && <ol className={styles.files} aria-label={t('catalog.credits')}>{artists.map(entry => <li key={entry.key}>
        {entry.name} · {sharedText(`catalog.credit.${entry.role}` as MessageKey)}{entry.joinPhrase !== null && <> · {t('catalog.join_phrase_value', { phrase: entry.joinPhrase })}</>}
      </li>)}</ol>}
      <Link className={styles.meta} to={manageAlbumHref}>{t('catalog_review.edit_artist')}</Link></div>
    {label && <label className={styles.field}>{t('organization.label')}<input className={styles.input} value={label.name} readOnly /></label>}
    <fieldset className={styles.date}><legend>{t('field.releaseDate')}</legend>
      {(['year', 'month', 'day'] as const).map(part => <label className={styles.field} key={part}>{t(`field.${part}`)}<input className={styles.input} type="number" min={1} max={part === 'year' ? 9999 : part === 'month' ? 12 : 31}
        value={release?.[part] ?? ''} disabled={disabled || part !== 'year' && !release || part === 'day' && !release?.month}
        onChange={event => {
          const value = number(event.target.value);
          if (part === 'year') album({ releaseDate: value === null ? null : { year: value, month: release?.month ?? null, day: release?.day ?? null } });
          else if (release) album({ releaseDate: { ...release, [part]: value, ...(part === 'month' && value === null ? { day: null } : {}) } });
        }} /></label>)}
    </fieldset>
    <div className={styles.field}><label className={styles.field}>{t('field.visibility')}<select className={styles.input} value={draft.album.visibility} disabled>
      <option value="public">{t('field.public')}</option><option value="hidden">{t('field.hidden')}</option>
    </select></label><Link className={styles.meta} to={manageAlbumHref}>{t('catalog_review.edit_visibility')}</Link></div>
    {draft.tracks.map((item, index) => {
      const path = filenames.find(file => file.slotId === item.slotId)?.relativePath;
      return <div className={styles.track} key={item.slotId}>
        <span title={path}>{index + 1}</span>
        <label className={styles.field}><span className={styles.filename}>{path}</span>{t('field.title')}<input className={styles.input} aria-label={`${index + 1} · ${t('field.title')}`} maxLength={300} value={item.title} onChange={event => track(item.slotId, { title: event.target.value })} /></label>
        {captured.has(item.slotId) && <label className={styles.field}>{t('field.discNumber')}<input className={styles.input} aria-label={`${index + 1} · ${t('field.discNumber')}`} type="number" min={1} max={999} value={item.discNumber ?? ''} onChange={event => track(item.slotId, { discNumber: number(event.target.value) })} /></label>}
        <label className={styles.field}>{t('field.trackNumber')}<input className={styles.input} aria-label={`${index + 1} · ${t('field.trackNumber')}`} type="number" min={1} max={9999} value={item.trackNumber ?? ''} onChange={event => track(item.slotId, { trackNumber: number(event.target.value) })} /></label>
      </div>;
    })}
  </fieldset>;
}
