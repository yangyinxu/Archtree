import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useAdminText } from './AdminAccess';
import type { CatalogReview, ReviewDraft } from './catalogReviewApi';
import { longAlbum, recordEdits, withEdits, type ReviewEditorView, type ReviewEdits } from './catalogReviewEdits';
import { cleanupState, proposalCells, reviewEditor, toggleCleanup, type ProposalCell, type TitleProposalRow } from './catalogReviewProposal';
import { titlePosition } from './reviewLookupStatus';
import styles from './adminStyles';

type Field = 'discNumber' | 'trackNumber';

/**
 * The review page's table of numbers proposed from titles (owner rules: docs/business-rules.md, Catalog Visibility and
 * Administration, the proposal on open and its cleanup step; docs/features/admin-workbench.md, Numbers proposed from titles),
 * shown while some captured title starts with a position: each member's captured title (an edited or cleaned draft title after an
 * arrow) with its Disc (where captured) and Track Number inputs, each showing the draft value, else the proposal; the original
 * numbers and a text marker on each cell that fills an empty value or replaces a non-empty one (the original struck through) when
 * any original number is not empty, otherwise one note that every original number is empty; why each row that stops the proposal
 * does, listed and on its row; Track Numbers read from titles giving them alone marked for checking; and the optional title
 * cleanup, offered while the proposal is accepted. On a long Album one line sums up the members, discs and proposed positions,
 * rows with a flag, a replacing value or an edit (a number, or a title other than the cleanup's) stay open first and the others sit in one disclosure per disc, mounted while
 * folded; the input just edited keeps the focus when its row moves. Typed numbers are edits (`onEdit`, with the saved draft they
 * make); the cleanup's titles are edits too and are chosen in the update range (`onCleanup`, with their item keys and the slots
 * whose titles the cleanup wrote, which the page keeps and passes back as `cleaned`, so turning it off restores only those). It reports what
 * it derives (`onView`) on every change, also while it shows nothing, since the update range, the manual editor and the save read it.
 */
export function CatalogReviewProposalTable({ item, base, edits, cleaned, disabled, onEdit, onCleanup, onView }: { item: CatalogReview; base: ReviewDraft; edits: ReviewEdits;
  cleaned: readonly string[]; disabled: boolean; onEdit: (edits: ReviewEdits, draft: ReviewDraft) => void;
  onCleanup: (edits: ReviewEdits, draft: ReviewDraft, keys: string[], cleaned: string[]) => void;
  onView: (view: ReviewEditorView) => void }) {
  const t = useAdminText(), id = useId(), list = useRef<HTMLFieldSetElement>(null), focus = useRef<string | null>(null);
  const view = useMemo(() => reviewEditor(item.source, base, edits), [item.source, base, edits]), { proposal, shown } = view;
  useEffect(() => onView({ base, edits, shown, proposed: view.proposed, numbers: view.numbers }), [view]);
  // An edit that moves its row (a long Album keeps edited rows open first) remounts its input: the focus follows it by its key.
  useLayoutEffect(() => {
    const key = focus.current, input = key ? list.current?.querySelector<HTMLElement>(`[data-number="${key}"]`) : null;
    focus.current = null;
    if (input && document.activeElement !== input) input.focus();
  });
  if (proposal.form === null) return null;
  const sources = item.source.tracks, cells = proposalCells(proposal, sources, shown.tracks), long = longAlbum(sources.length);
  const column = sources.some(track => track.trackNumber !== null || (track.discNumber ?? null) !== null), cleanup = cleanupState(proposal, shown.tracks);
  const position = (slotId: string) => sources.findIndex(track => track.slotId === slotId) + 1;
  const flags = (row: TitleProposalRow) => row.flags.filter(flag => proposal.accepted || flag !== 'gap').map(flag => t(`catalog_review.proposal_flag_${flag}`));
  const shownTrack = (slotId: string) => shown.tracks.find(track => track.slotId === slotId)!;
  // A typed number, or a title other than the cleanup's own text, opens its row; the cleanup's titles alone fold with the rest.
  const edited = (row: TitleProposalRow) => { const own = edits.tracks?.[row.slotId] ?? {};
    return own.discNumber !== undefined || own.trackNumber !== undefined || (own.title !== undefined && own.title !== row.position?.rest); };
  const exception = (row: TitleProposalRow) => flags(row).length > 0 || edited(row) || Object.values(cells[row.slotId]).includes('overwrite');
  const disc = (row: TitleProposalRow) => shownTrack(row.slotId).discNumber ?? row.position?.discNumber ?? 1;
  const change = (slotId: string, field: Field, value: string) => {
    focus.current = `${slotId}:${field}`;
    const next = recordEdits(edits, shown, { ...shown, tracks: shown.tracks.map(track => track.slotId === slotId ? { ...track, [field]: value === '' ? null : Number(value) } : track) });
    onEdit(next, withEdits(base, next));
  };
  const rowView = (row: TitleProposalRow) => {
    const source = sources.find(track => track.slotId === row.slotId)!, track = shownTrack(row.slotId), at = position(row.slotId);
    const notes = [...flags(row), ...(proposal.form === 'track' && view.numbers[row.slotId]?.trackNumber !== undefined && edits.tracks?.[row.slotId]?.trackNumber === undefined
      ? [t('catalog_review.proposal_track_only')] : [])];
    const input = (field: Field, max: number, kind: ProposalCell | null) => <label className={styles.field}>
      {column && kind === 'fill' && <span className={styles.badge}>{t('catalog_review.proposal_fill')}</span>}
      {kind === 'overwrite' && <span className={styles.badge}>{t('catalog_review.proposal_overwrite')} <s>{source[field]}</s></span>}
      <input className={styles.input} style={{ width: '5.5rem' }} type="number" min={1} max={max} data-number={`${row.slotId}:${field}`} value={track[field] ?? ''}
        aria-label={t('catalog_review.number_label', { position: at, field: t(`field.${field}`) })} onChange={event => change(row.slotId, field, event.target.value)} /></label>;
    return <li key={row.slotId} className={styles.track}>
      <div style={{ flex: '1 1 12rem', minWidth: 0 }}><strong>{`${at} · ${row.title}`}</strong>
        {track.title !== row.title && <div>{`→ ${track.title}`}</div>}
        {column && <div className={styles.meta}>{t('catalog_review.proposal_original', { numbers: [...(source.discNumber === undefined ? [] : [source.discNumber]), source.trackNumber]
          .map(value => value ?? '—').join(' / ') })}</div>}
        {notes.length > 0 && <div className={styles.badges}>{notes.map(note => <span key={note} className={styles.badge}>{note}</span>)}</div>}</div>
      {cells[row.slotId].discNumber !== null && input('discNumber', 999, cells[row.slotId].discNumber)}{input('trackNumber', 9999, cells[row.slotId].trackNumber)}</li>;
  };
  const open = long ? proposal.rows.filter(exception) : proposal.rows, discs = new Map<number, TitleProposalRow[]>();
  if (long) for (const row of proposal.rows) if (!exception(row)) discs.set(disc(row), [...discs.get(disc(row)) ?? [], row]);
  const stopped = proposal.rows.filter(row => !proposal.accepted && flags(row).length);
  const first = proposal.rows[0], last = proposal.rows.at(-1)!;
  return <section aria-labelledby={`${id}-title`} className={styles.panel}>
    <h2 id={`${id}-title`}>{t('catalog_review.proposal_title')}</h2>
    {proposal.preselected && proposal.count > 0 && <p className={styles.muted}>{t('catalog_review.proposal_copy')}</p>}
    {!column && proposal.count > 0 && <p className={styles.meta}>{t('catalog_review.proposal_empty_originals')}</p>}
    {stopped.length > 0 && <><p>{t('catalog_review.proposal_stopped')}</p>
      <ul>{stopped.map(row => <li key={row.slotId}>{[`${position(row.slotId)} · ${row.title}`, ...flags(row)].join(' · ')}</li>)}</ul></>}
    {long && <p>{[t('catalog_review.proposal_long', { tracks: sources.length, discs: new Set(proposal.rows.map(disc)).size }),
      proposal.count > 0 && t('catalog_review.proposal_long_range', { first: titlePosition(first.title) ?? '', last: titlePosition(last.title) ?? '' })].filter(Boolean).join(' · ')}</p>}
    <fieldset ref={list} className={styles.editor} disabled={disabled}>
      {cleanup.offered && <label className={styles.check}><input type="checkbox" data-cleanup="" checked={cleanup.checked}
        onChange={event => { const next = toggleCleanup(proposal, base, edits, event.target.checked, cleaned);
          onCleanup(next.edits, withEdits(base, next.edits), next.keys, next.cleaned); }} />{t('catalog_review.proposal_cleanup')}</label>}
      {open.length > 0 && <ol className={styles.cards}>{open.map(rowView)}</ol>}
      {[...discs].map(([number, rows]) => <details key={number} className={styles.details}><summary>{t('catalog_review.proposal_disc', { disc: number, count: rows.length })}</summary>
        <ol className={styles.cards}>{rows.map(rowView)}</ol></details>)}
    </fieldset>
  </section>;
}
