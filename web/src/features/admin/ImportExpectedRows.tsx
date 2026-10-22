import { useId } from 'react';
import { useAdminText } from './AdminAccess';
import type { ImportDraftV2 } from './adminNamingSchema';
import type { ImportDraftChange } from './importDraftPatch';
import { appendNumberingChanges, appendRowPlacements } from './importAppendRows';
import type { ImportAppendTracklist } from './importLookupApi';
import { approvalTrackOrder } from './importTrackOrder';
import styles from './adminStyles';

/**
 * The append target's expected tracklist as an append's shown files meet it: how many missing-file rows they fill, then each file
 * in approved order with its position, title (else filename), the row it fills or none, and its flags, which never hold Publish.
 * With `numbering` (the summary, never the confirmation) and a server proposal, a secondary button saves "Number from the Album's
 * expected tracklist" as one ordinary field save against the saved draft. Without `heading` it renders inside the confirmation's
 * own term. Loaded lazily by the summary and the confirmation, outside the import route's initial JavaScript.
 */
export function ImportExpectedRows({ tracklist, tracks, filenames, heading, numbering }: {
  tracklist: ImportAppendTracklist; tracks: readonly { slotId: string; title: string; discNumber: number | null; trackNumber: number | null }[];
  filenames: readonly { slotId: string; filename: string }[]; heading: boolean;
  numbering?: { saved: ImportDraftV2; disabled: boolean; onSave: (changes: ImportDraftChange[]) => void };
}) {
  const t = useAdminText(), id = useId(), ordered = approvalTrackOrder(tracks), placed = appendRowPlacements(tracklist, ordered);
  const name = (track: typeof ordered[number]) => track.title || filenames.find(file => file.slotId === track.slotId)?.filename || t('common.untitled');
  const content = <>
    <p>{t('append_rows.fills', { filled: placed.filledRows, missing: placed.missingRows })}</p>
    {ordered.length > 0 && <ol>{ordered.map((track, index) => {
      const { row, flags } = placed.files[index];
      return <li key={track.slotId}>{[t('publication.track_position', { disc: String(track.discNumber ?? 1), track: track.trackNumber === null ? '—' : String(track.trackNumber) }), name(track),
        row ? t('append_rows.row', { disc: String(row.discNumber), track: String(row.trackNumber), title: row.title }) : t('append_rows.no_row'),
        ...flags.map(flag => t(`append_rows.${flag}`, flag === 'duration' ? { seconds: tracklist.durationToleranceMs / 1000 } : undefined))].join(' · ')}</li>;
    })}</ol>}
    {numbering && tracklist.numbering.length > 0 && <>
      <p id={`${id}-number`} className={styles.muted}>{t('append_rows.number_help')}</p>
      <div className={styles.actions}><button type="button" className={styles.button} disabled={numbering.disabled} aria-describedby={`${id}-number`}
        onClick={() => numbering.onSave(appendNumberingChanges(tracklist, numbering.saved))}>{t('append_rows.number')}</button></div>
    </>}
  </>;
  return heading ? <section aria-labelledby={`${id}-rows`}><h3 id={`${id}-rows`}>{t('append_rows.title')}</h3>{content}</section> : content;
}
