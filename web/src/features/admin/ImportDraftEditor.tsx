import type { ReactNode } from 'react';
import type { ImportDraft, ImportDetail, ImportDraftV2 } from './adminApi';
import { useAdminText } from './AdminAccess';
import styles from './adminStyles';

/**
 * Metadata editing is confined to this private draft; Album order remains derived from Disc and Track Numbers. A catalog review
 * edits its v1 draft with the Artist name read-only; an import passes `artists`, the Draft v2 entries and label fields
 * (ImportDraftV2Editor.tsx), in place of the Artist name. A Draft v2 track also edits its Disc Number; track edits keep every other value.
 */
export function ImportDraftEditor<T extends ImportDraft | ImportDraftV2>({ draft, filenames, disabled, onChange, artists, artistReadOnly = false, visibilityReadOnly = false, manageAlbumHref }: { draft: T; filenames: ImportDetail['manifest']['files']; disabled: boolean; onChange: (draft: T) => void; artists?: ReactNode; artistReadOnly?: boolean; visibilityReadOnly?: boolean; manageAlbumHref?: string }) {
  const t = useAdminText();
  const album = (patch: Record<string, unknown>) => onChange({ ...draft, album: { ...draft.album, ...patch } });
  const tracks = (slotId: string, patch: Record<string, unknown>) => onChange({ ...draft, tracks: draft.tracks.map(item => item.slotId === slotId ? { ...item, ...patch } : item) });
  const release = draft.album.releaseDate;
  return <fieldset className={styles.editor} disabled={disabled}>
    <label className={styles.field}>{t('field.title')}<input className={styles.input} value={draft.album.title} maxLength={300} onChange={event => album({ title: event.target.value })} /></label>
    {artists ?? <div className={styles.field}><label className={styles.field}>{t(artistReadOnly ? 'catalog_review.artist_read_only' : 'field.artistName')}<input className={styles.input} aria-label={t('field.artistName')} value={'artistName' in draft.album ? draft.album.artistName : ''} readOnly={artistReadOnly} maxLength={200} onChange={event => album({ artistName: event.target.value })} /></label>
      {artistReadOnly && manageAlbumHref && <Link className={styles.meta} to={manageAlbumHref}>{t('catalog_review.edit_artist')}</Link>}</div>}
    <fieldset className={styles.date}><legend>{t('field.releaseDate')}</legend>
      {(['year', 'month', 'day'] as const).map(part => <label className={styles.field} key={part}>{t(`field.${part}`)}<input className={styles.input} type="number" min={1} max={part === 'year' ? 9999 : part === 'month' ? 12 : 31}
        value={release?.[part] ?? ''} disabled={disabled || part !== 'year' && !release || part === 'day' && !release?.month}
        onChange={event => {
          const number = event.target.value === '' ? null : Number(event.target.value);
          if (part === 'year') album({ releaseDate: number === null ? null : { year: number, month: release?.month ?? null, day: release?.day ?? null } });
          else if (release) album({ releaseDate: { ...release, [part]: number, ...(part === 'month' && number === null ? { day: null } : {}) } });
        }} /></label>)}
    </fieldset>
    <div className={styles.field}><label className={styles.field}>{t('field.visibility')}<select className={styles.input} value={draft.album.visibility} disabled={disabled || visibilityReadOnly} onChange={event => album({ visibility: event.target.value as 'public' | 'hidden' })}>
      <option value="public">{t('field.public')}</option><option value="hidden">{t('field.hidden')}</option>
    </select></label>{visibilityReadOnly && manageAlbumHref && <Link className={styles.meta} to={manageAlbumHref}>{t('catalog_review.edit_visibility')}</Link>}</div>
    {draft.tracks.map((track, index) => <div className={styles.track} key={track.slotId}>
      <span title={filenames.find(file => file.slotId === track.slotId)?.relativePath}>{index + 1}</span>
      <label className={styles.field}><span className={styles.filename}>{filenames.find(file => file.slotId === track.slotId)?.relativePath}</span>{t('field.title')}<input className={styles.input} aria-label={`${index + 1} · ${t('field.title')}`} maxLength={300} value={track.title} onChange={event => tracks(track.slotId, { title: event.target.value })} /></label>
      {'discNumber' in track && <label className={styles.field}>{t('field.discNumber')}<input className={styles.input} aria-label={`${index + 1} · ${t('field.discNumber')}`} type="number" min={1} max={999} value={track.discNumber ?? ''} onChange={event => tracks(track.slotId, { discNumber: event.target.value === '' ? null : Number(event.target.value) })} /></label>}
      <label className={styles.field}>{t('field.trackNumber')}<input className={styles.input} aria-label={`${index + 1} · ${t('field.trackNumber')}`} type="number" min={1} max={9999} value={track.trackNumber ?? ''} onChange={event => tracks(track.slotId, { trackNumber: event.target.value === '' ? null : Number(event.target.value) })} /></label>
    </div>)}
  </fieldset>;
}
import { Link } from 'react-router';
