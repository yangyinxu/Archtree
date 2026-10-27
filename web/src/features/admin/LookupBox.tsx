import { useEffect, useId, useRef, useState } from 'react';
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
 * search to the administration layout. While the review's run is queued, running or retrying (`active`), Look up first asks
 * whether to stop that run for the new name, since the server replaces an active run on submission; the box stays usable, as
 * automatic retries can last minutes, and any edit withdraws the question. A run that ends meanwhile leaves the question open, as
 * whether to look up the name now, so the submission is never dropped unseen. A review can fold it under Didn't find it? Look up
 * another name (`fold`), a disclosure that keeps the form mounted and reachable by keyboard: as it mounts, and later only while the
 * form is untouched (its values as mounted, no question open, the focus outside it), so a box the administrator may be using
 * never folds; it unfolds whenever `fold` turns false.
 */
export function LookupBox({ lookup, rootLabel, defaultText, mode, disabled, active, fold, onSubmit }: {
  lookup: { input: { trigger: string; submitted: { kind: 'album' | 'song'; text: string; artist?: string } | null } } | null; rootLabel: string;
  defaultText?: string; mode: 'import' | 'review'; disabled: boolean; active?: boolean;
  /** Fold the box under Didn't find it? Look up another name: as it mounts, and later only while the form is untouched. */
  fold?: boolean;
  onSubmit: (kind: 'album' | 'song', text: string, artist: string | null) => void;
}) {
  const t = useAdminText(), id = useId();
  const [kind, setKind] = useState<'album' | 'song'>(lookup?.input.submitted?.kind ?? 'album');
  const [text, setText] = useState(lookup?.input.submitted?.text ?? (lookup?.input.trigger === 'folder' ? rootLabel : defaultText ?? ''));
  const [artist, setArtist] = useState(lookup?.input.submitted?.artist ?? '');
  const [refused, setRefused] = useState({ name: false, artist: false });
  // The submission waiting for the administrator to confirm that it replaces the active run.
  const [confirming, setConfirming] = useState<Parameters<typeof onSubmit> | null>(null);
  const [folded, setFolded] = useState(Boolean(fold));
  const form = useRef<HTMLFormElement>(null), mounted = useRef({ kind, text, artist });
  useEffect(() => {
    const untouched = kind === mounted.current.kind && text === mounted.current.text && artist === mounted.current.artist && !confirming
      && !form.current?.contains(document.activeElement);
    if (!fold) setFolded(false);
    else if (untouched) setFolded(true);
    // Only a change of `fold` decides; editing the form never folds it.
  }, [fold]);
  const box = <form ref={form} className={styles.editor} noValidate onSubmit={event => {
    event.preventDefault();
    const name = text.trim(), credit = artist.trim(), next = { name: link(name), artist: link(credit) };
    setRefused(next);
    if (name && !next.name && !next.artist) { if (active) setConfirming([kind, name, credit || null]); else onSubmit(kind, name, credit || null); }
  }}><fieldset disabled={disabled}><legend>{t('lookup.box')}</legend>
    {(['album', 'song'] as const).map(value => <label key={value} className={styles.check}><input type="radio" name={`${id}-kind`} checked={kind === value} onChange={() => { setKind(value); setConfirming(null); }} />{t(`lookup.kind_${value}`)}</label>)}
    <div className={styles.date}>
      <label className={styles.field}>{t('lookup.name')}<input className={styles.input} type="text" value={text} maxLength={200} autoComplete="off" aria-invalid={refused.name}
        aria-describedby={refused.name ? `${id}-refused` : undefined} onChange={event => { setText(event.target.value); setRefused(state => ({ ...state, name: false })); setConfirming(null); }} /></label>
      <label className={styles.field}>{t('lookup.artist')}<input className={styles.input} type="text" value={artist} maxLength={200} autoComplete="off" aria-invalid={refused.artist}
        aria-describedby={[refused.artist && `${id}-refused`, `${id}-artist-hint`].filter(Boolean).join(' ')}
        onChange={event => { setArtist(event.target.value); setRefused(state => ({ ...state, artist: false })); setConfirming(null); }} /></label>
    </div>
    {(refused.name || refused.artist) && <p id={`${id}-refused`} role="alert">{t('lookup.link_refused')}</p>}
    <div className={styles.actions}><button className={styles.button} type="submit" disabled={!text.trim()}>{t('lookup.submit')}</button></div>
    {confirming && <><p role="alert">{t(active ? 'catalog_review.lookup_replace_copy' : 'catalog_review.lookup_replace_ended')}</p><div className={styles.actions}>
      <button className={styles.button} type="button" onClick={() => { setConfirming(null); onSubmit(...confirming); }}>{t(active ? 'catalog_review.lookup_replace_confirm' : 'catalog_review.lookup_replace_now')}</button>
      <button className={styles.button} type="button" onClick={() => setConfirming(null)}>{t('common.cancel')}</button></div></>}
    <p id={`${id}-artist-hint`} className={styles.muted}>{t(`lookup.artist_hint_${mode}`)}</p>
  </fieldset></form>;
  return folded ? <details className={styles.details}><summary>{t('catalog_review.lookup_try_another')}</summary>{box}</details> : box;
}
