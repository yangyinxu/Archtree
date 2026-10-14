import type { ImportDraft, ImportDetail } from './adminApi';
import { useAdminText } from './AdminAccess';
import styles from './adminStyles';

/** Metadata editing is confined to this private draft; Album order remains derived from track numbers. */
export function ImportDraftEditor({ draft, filenames, disabled, onChange }: { draft: ImportDraft; filenames: ImportDetail['manifest']['files']; disabled: boolean; onChange: (draft: ImportDraft) => void }) {
  const t = useAdminText();
  const album = (change: Partial<ImportDraft['album']>) => onChange({ ...draft, album: { ...draft.album, ...change } });
  const release = draft.album.releaseDate;
  return <fieldset className={styles.editor} disabled={disabled}>
    <label className={styles.field}>{t('field.title')}<input className={styles.input} value={draft.album.title} maxLength={300} onChange={event => album({ title: event.target.value })} /></label>
    <label className={styles.field}>{t('field.artistName')}<input className={styles.input} value={draft.album.artistName} maxLength={200} onChange={event => album({ artistName: event.target.value })} /></label>
    <fieldset className={styles.date}><legend>{t('field.releaseDate')}</legend>
      {(['year', 'month', 'day'] as const).map(part => <label className={styles.field} key={part}>{t(`field.${part}`)}<input className={styles.input} type="number" min={1} max={part === 'year' ? 9999 : part === 'month' ? 12 : 31}
        value={release?.[part] ?? ''} disabled={disabled || part !== 'year' && !release || part === 'day' && !release?.month}
        onChange={event => {
          const number = event.target.value === '' ? null : Number(event.target.value);
          if (part === 'year') album({ releaseDate: number === null ? null : { year: number, month: release?.month ?? null, day: release?.day ?? null } });
          else if (release) album({ releaseDate: { ...release, [part]: number, ...(part === 'month' && number === null ? { day: null } : {}) } });
        }} /></label>)}
    </fieldset>
    <label className={styles.field}>{t('field.visibility')}<select className={styles.input} value={draft.album.visibility} onChange={event => album({ visibility: event.target.value as 'public' | 'hidden' })}>
      <option value="hidden">{t('field.hidden')}</option><option value="public">{t('field.public')}</option>
    </select></label>
    {draft.tracks.map((track, index) => <div className={styles.track} key={track.slotId}>
      <span title={filenames.find(file => file.slotId === track.slotId)?.relativePath}>{index + 1}</span>
      <label className={styles.field}><span className={styles.filename}>{filenames.find(file => file.slotId === track.slotId)?.relativePath}</span>{t('field.title')}<input className={styles.input} aria-label={`${index + 1} · ${t('field.title')}`} maxLength={300} value={track.title} onChange={event => onChange({ ...draft, tracks: draft.tracks.map(item => item.slotId === track.slotId ? { ...item, title: event.target.value } : item) })} /></label>
      <label className={styles.field}>{t('field.trackNumber')}<input className={styles.input} aria-label={`${index + 1} · ${t('field.trackNumber')}`} type="number" min={1} max={9999} value={track.trackNumber ?? ''} onChange={event => onChange({ ...draft, tracks: draft.tracks.map(item => item.slotId === track.slotId ? { ...item, trackNumber: event.target.value === '' ? null : Number(event.target.value) } : item) })} /></label>
    </div>)}
  </fieldset>;
}
