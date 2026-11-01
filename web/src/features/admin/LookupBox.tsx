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
 * share one row and the hint follows Look up, so Look up stays compact and comes before the proposed numbers. It accepts names only, keeps no history (no
 * autocomplete and nothing stored) and is not listener Search: it neither uses the search landmark nor restores global music
 * search to the administration layout. While the review's run is queued, running or retrying (`active`), Look up first asks
 * whether to stop that run for the new name, since the server replaces an active run on submission; the box stays usable, as
 * automatic retries can last minutes, and any edit withdraws the question. A run that ends meanwhile leaves the question open, as
 * whether to look up the name now, so the submission is never dropped unseen. A review can fold it under Didn't find it? Look up
 * another name (`fold`), a disclosure that keeps the form mounted and reachable by keyboard: as it mounts, and later only while the
 * form is untouched (its values as mounted, no question open, the focus outside it), so a box the administrator may be using
 * never folds; it unfolds whenever `fold` turns false.
 *
 * A review's box also prefills the Artist field with the Album's primary Artists (`defaultArtist`, their byline) unless a submitted
 * run named one. Submitted unchanged it is sent as none only where the server credits those very Artists itself
 * (`defaultArtistImplicit`: the draft's primary Artists are the names the review captured); otherwise, as any other text, it is
 * sent as typed, so a lookup never searches Artists other than the ones shown. Its submit says the lookup is free, and `hint` (a
 * completed run that found nothing to use) suggests trying the name without its subtitle, describing the name field.
 */
export function LookupBox({ lookup, rootLabel, defaultText, defaultArtist = '', defaultArtistImplicit = false, hint = false, mode, disabled, active, fold, onSubmit }: {
  lookup: { input: { trigger: string; submitted: { kind: 'album' | 'song'; text: string; artist?: string } | null } } | null; rootLabel: string;
  defaultText?: string; defaultArtist?: string;
  /** Whether the server searches `defaultArtist`'s Artists when no Artist name is sent, so an unchanged prefill is sent as none. */
  defaultArtistImplicit?: boolean;
  hint?: boolean; mode: 'import' | 'review'; disabled: boolean; active?: boolean;
  /** Fold the box under Didn't find it? Look up another name: as it mounts, and later only while the form is untouched. */
  fold?: boolean;
  onSubmit: (kind: 'album' | 'song', text: string, artist: string | null) => void;
}) {
  const t = useAdminText(), id = useId();
  const [kind, setKind] = useState<'album' | 'song'>(lookup?.input.submitted?.kind ?? 'album');
  const [text, setText] = useState(lookup?.input.submitted?.text ?? (lookup?.input.trigger === 'folder' ? rootLabel : defaultText ?? ''));
  const [artist, setArtist] = useState(lookup?.input.submitted?.artist ?? defaultArtist);
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
    // The prefilled primary Artists, where they are the server's own default, are sent as none.
    const name = text.trim(), typed = artist.trim(), credit = defaultArtistImplicit && typed === defaultArtist.trim() ? '' : typed, next = { name: link(name), artist: link(typed) };
    setRefused(next);
    if (name && !next.name && !next.artist) { if (active) setConfirming([kind, name, credit || null]); else onSubmit(kind, name, credit || null); }
  }}><fieldset disabled={disabled}><legend>{t('lookup.box')}</legend>
    {(['album', 'song'] as const).map(value => <label key={value} className={styles.check}><input type="radio" name={`${id}-kind`} checked={kind === value} onChange={() => { setKind(value); setConfirming(null); }} />{t(`lookup.kind_${value}`)}</label>)}
    <div className={styles.date}>
      <label className={styles.field}>{t('lookup.name')}<input className={styles.input} type="text" value={text} maxLength={200} autoComplete="off" aria-invalid={refused.name}
        aria-describedby={[refused.name && `${id}-refused`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined} onChange={event => { setText(event.target.value); setRefused(state => ({ ...state, name: false })); setConfirming(null); }} /></label>
      <label className={styles.field}>{t('lookup.artist')}<input className={styles.input} type="text" value={artist} maxLength={200} autoComplete="off" aria-invalid={refused.artist}
        aria-describedby={[refused.artist && `${id}-refused`, `${id}-artist-hint`].filter(Boolean).join(' ')}
        onChange={event => { setArtist(event.target.value); setRefused(state => ({ ...state, artist: false })); setConfirming(null); }} /></label>
    </div>
    {hint && <p id={`${id}-hint`} className={styles.muted}>{t('catalog_review.lookup_subtitle_hint')}</p>}
    {(refused.name || refused.artist) && <p id={`${id}-refused`} role="alert">{t('lookup.link_refused')}</p>}
    <div className={styles.actions}><button className={styles.button} type="submit" disabled={!text.trim()}>{t(mode === 'review' ? 'catalog_review.lookup_submit_free' : 'lookup.submit')}</button></div>
    {confirming && <><p role="alert">{t(active ? 'catalog_review.lookup_replace_copy' : 'catalog_review.lookup_replace_ended')}</p><div className={styles.actions}>
      <button className={styles.button} type="button" onClick={() => { setConfirming(null); onSubmit(...confirming); }}>{t(active ? 'catalog_review.lookup_replace_confirm' : 'catalog_review.lookup_replace_now')}</button>
      <button className={styles.button} type="button" onClick={() => setConfirming(null)}>{t('common.cancel')}</button></div></>}
    <p id={`${id}-artist-hint`} className={styles.muted}>{t(`lookup.artist_hint_${mode}`)}</p>
  </fieldset></form>;
  return folded ? <details className={styles.details}><summary>{t('catalog_review.lookup_try_another')}</summary>{box}</details> : box;
}
