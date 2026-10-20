import { useId, useState } from 'react';
import { useAdminText } from './AdminAccess';
import type { ImportLookupView } from './importLookupApi';
import styles from './adminStyles';

/** A link in place of a name; the server refuses it too (ADMIN_IMPORT_LOOKUP_INVALID_NAME). */
const link = (text: string) => /:\/\/|^www\./i.test(text);

/**
 * The summary's name box: an Album or song name for metadata lookup, prefilled with the last submitted name or, after a
 * folder-name run, the folder name for editing. It accepts names only, keeps no history (no autocomplete and nothing stored) and
 * is not listener Search: it neither uses the search landmark nor restores global music search to the administration layout.
 */
export function LookupBox({ lookup, rootLabel, disabled, onSubmit }: { lookup: ImportLookupView | null; rootLabel: string; disabled: boolean; onSubmit: (kind: 'album' | 'song', text: string) => void }) {
  const t = useAdminText(), id = useId();
  const [kind, setKind] = useState<'album' | 'song'>(lookup?.input.submitted?.kind ?? 'album');
  const [text, setText] = useState(lookup?.input.submitted?.text ?? (lookup?.input.trigger === 'folder' ? rootLabel : ''));
  const [refused, setRefused] = useState(false);
  return <form className={styles.editor} noValidate onSubmit={event => {
    event.preventDefault();
    const name = text.trim();
    setRefused(link(name));
    if (name && !link(name)) onSubmit(kind, name);
  }}><fieldset disabled={disabled}><legend>{t('lookup.box')}</legend>
    {(['album', 'song'] as const).map(value => <label key={value} className={styles.check}><input type="radio" name={`${id}-kind`} checked={kind === value} onChange={() => setKind(value)} />{t(`lookup.kind_${value}`)}</label>)}
    <label className={styles.field}>{t('lookup.name')}<input type="text" value={text} maxLength={200} autoComplete="off" aria-invalid={refused} aria-describedby={refused ? `${id}-refused` : undefined}
      onChange={event => { setText(event.target.value); setRefused(false); }} /></label>
    {refused && <p id={`${id}-refused`} role="alert">{t('lookup.link_refused')}</p>}
    <div className={styles.actions}><button className={styles.button} type="submit" disabled={!text.trim()}>{t('lookup.submit')}</button></div>
  </fieldset></form>;
}
