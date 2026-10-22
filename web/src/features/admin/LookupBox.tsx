import { useId, useState } from 'react';
import { useAdminText } from './AdminAccess';
import styles from './adminStyles';

/** A link in place of a name; the server refuses it too (ADMIN_IMPORT_LOOKUP_INVALID_NAME). */
const link = (text: string) => /:\/\/|^www\./i.test(text);

/**
 * The summary's name box: an Album or song name for metadata lookup, prefilled with the last submitted name or, after a
 * folder-name run, the folder name for editing; otherwise with `defaultText` (an existing-Album review's saved Album title). An
 * optional Artist name beside it, prefilled from the last submitted run, credits that run's searches in place of the files' tags
 * (`import`) or the Album's primary Artists (`review`); an empty one is sent as none, and an Artist alone never looks up. Both
 * share one row and the hint follows Look up, so Look up stays in the first screen. It accepts names only, keeps no history (no
 * autocomplete and nothing stored) and is not listener Search: it neither uses the search landmark nor restores global music
 * search to the administration layout.
 */
export function LookupBox({ lookup, rootLabel, defaultText, mode, disabled, onSubmit }: {
  lookup: { input: { trigger: string; submitted: { kind: 'album' | 'song'; text: string; artist?: string } | null } } | null; rootLabel: string;
  defaultText?: string; mode: 'import' | 'review'; disabled: boolean;
  onSubmit: (kind: 'album' | 'song', text: string, artist: string | null) => void;
}) {
  const t = useAdminText(), id = useId();
  const [kind, setKind] = useState<'album' | 'song'>(lookup?.input.submitted?.kind ?? 'album');
  const [text, setText] = useState(lookup?.input.submitted?.text ?? (lookup?.input.trigger === 'folder' ? rootLabel : defaultText ?? ''));
  const [artist, setArtist] = useState(lookup?.input.submitted?.artist ?? '');
  const [refused, setRefused] = useState({ name: false, artist: false });
  return <form className={styles.editor} noValidate onSubmit={event => {
    event.preventDefault();
    const name = text.trim(), credit = artist.trim(), next = { name: link(name), artist: link(credit) };
    setRefused(next);
    if (name && !next.name && !next.artist) onSubmit(kind, name, credit || null);
  }}><fieldset disabled={disabled}><legend>{t('lookup.box')}</legend>
    {(['album', 'song'] as const).map(value => <label key={value} className={styles.check}><input type="radio" name={`${id}-kind`} checked={kind === value} onChange={() => setKind(value)} />{t(`lookup.kind_${value}`)}</label>)}
    <div className={styles.date}>
      <label className={styles.field}>{t('lookup.name')}<input className={styles.input} type="text" value={text} maxLength={200} autoComplete="off" aria-invalid={refused.name}
        aria-describedby={refused.name ? `${id}-refused` : undefined} onChange={event => { setText(event.target.value); setRefused(state => ({ ...state, name: false })); }} /></label>
      <label className={styles.field}>{t('lookup.artist')}<input className={styles.input} type="text" value={artist} maxLength={200} autoComplete="off" aria-invalid={refused.artist}
        aria-describedby={[refused.artist && `${id}-refused`, `${id}-artist-hint`].filter(Boolean).join(' ')}
        onChange={event => { setArtist(event.target.value); setRefused(state => ({ ...state, artist: false })); }} /></label>
    </div>
    {(refused.name || refused.artist) && <p id={`${id}-refused`} role="alert">{t('lookup.link_refused')}</p>}
    <div className={styles.actions}><button className={styles.button} type="submit" disabled={!text.trim()}>{t('lookup.submit')}</button></div>
    <p id={`${id}-artist-hint`} className={styles.muted}>{t(`lookup.artist_hint_${mode}`)}</p>
  </fieldset></form>;
}
