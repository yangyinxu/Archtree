import { Suspense, useEffect } from 'react';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useAdminText } from './AdminAccess';
import { DeliveryTextBoundary, useAdminDeliveryText } from './adminPageText';
import { entriesByline } from './artistEntriesByline';
import type { ImportTrackArtists } from './importLookupApi';
import styles from './adminStyles';

/**
 * The track Artist entries of an import that publishes a new Album (their own lazy chunk): the summary's line under a track and the
 * publication confirmation's Track Artists block. Their words are release-packaged `web-admin` copy (`admin.track_artists.*`); runtime
 * administrator keys read through the same `t`. Owner rules: docs/business-rules.md (Administrator Album Imports).
 */
type Entries = ImportTrackArtists[number]['entries'];
const useTrackArtistText = () => useAdminDeliveryText(['track_artists.']);
/** Stands in for copy that cannot load: the page was updated, so it asks for a reload. */
function Reload() { const t = useAdminText(); return <p role="alert">{t('common.reload')}</p>; }
/** Each entry with its role, join phrase and, when given, what `mark` says about its identity. */
function EntryList({ entries, mark }: { entries: Entries; mark?: (identity: string) => string }) {
  const t = useTrackArtistText(), { t: shared } = useLocalization();
  return <ol>{entries.map(entry => <li key={entry.key}>{[entry.name, shared(`catalog.credit.${entry.role}` as MessageKey), entry.joinPhrase && t('publication.join_phrase', { phrase: entry.joinPhrase }),
    mark?.(entry.identity)].filter(Boolean).join(' · ')}</li>)}</ol>;
}

/**
 * Under a track of the summary's values: its own Artists when they differ from the Album's primary entries, or the mark that it takes
 * the Album's primary Artists because its track on the release has no usable credit. Nothing while the copy loads; a reload line when
 * it cannot.
 */
export function TrackArtistsNote(props: { entries?: Entries; inherits: boolean }) {
  return <DeliveryTextBoundary fallback={<Reload />}><Suspense fallback={null}><Note {...props} /></Suspense></DeliveryTextBoundary>;
}
function Note({ entries, inherits }: { entries?: Entries; inherits: boolean }) {
  const t = useTrackArtistText();
  if (!entries) return inherits ? <p className={styles.muted}>{t('track_artists.inherits')}</p> : null;
  return <><p className={styles.muted}>{t('track_artists.byline', { byline: entriesByline(entries) })}</p><EntryList entries={entries} /></>;
}

export interface TrackArtistsChecklistProps {
  /** The tracks the summary lists as differing, in draft order. */
  tracks: ImportTrackArtists;
  /** The confirmation's new tracks in approved order, by which the listed tracks are shown. */
  order: readonly { slotId: string; title: string; discNumber: number | null; trackNumber: number | null }[];
  filenames: readonly { slotId: string; filename: string }[];
  deselected: readonly string[]; onToggle: (slotId: string, selected: boolean) => void;
  /** The identity and MusicBrainz ID marks of an identity row (an Album entry's or a track-only identity's). */
  describe: (identity: string) => string;
  /** The byline of the shown draft's primary entries, which an unticked track publishes with. */
  albumByline: string;
  /** The shown Album entries differ from the saved ones the tracks were compared with: approval waits until they are saved or undone. */
  artistsChanged: boolean;
  /** Called with true once the block shows (its copy loaded) and false when it stops showing. */
  onReady: (ready: boolean) => void;
}
/**
 * The confirmation's Track Artists block: a short explanation, then each listed track with its position and title, ticked when the
 * dialog opens, and either its entries with their roles, join phrases and identity marks or, unticked, the Album's primary Artists it
 * publishes with. It reports ready only while it shows, so Approve waits for its copy; when the copy cannot load it shows a reload line
 * and never reports ready.
 */
export function TrackArtistsChecklist(props: TrackArtistsChecklistProps) {
  return <DeliveryTextBoundary fallback={<div><dd><Reload /></dd></div>}><Suspense fallback={null}><Checklist {...props} /></Suspense></DeliveryTextBoundary>;
}
function Checklist({ tracks, order, filenames, deselected, onToggle, describe, albumByline, artistsChanged, onReady }: TrackArtistsChecklistProps) {
  const t = useTrackArtistText();
  useEffect(() => { onReady(true); return () => onReady(false); }, []);
  return <div><dt>{t('track_artists.title')}</dt><dd><p className={styles.muted}>{t('track_artists.copy')}</p>
    {artistsChanged && <p role="note">{t('track_artists.save_artists_first')}</p>}
    <ul>{order.flatMap(track => {
      const entries = tracks.find(item => item.slotId === track.slotId)?.entries, selected = !deselected.includes(track.slotId);
      if (!entries) return [];
      const name = `${t('publication.track_position', { disc: String(track.discNumber ?? 1), track: track.trackNumber === null ? '—' : String(track.trackNumber) })} · ${track.title
        || filenames.find(file => file.slotId === track.slotId)?.filename || ''}`;
      return [<li key={track.slotId}><label className={styles.check}><input type="checkbox" checked={selected} onChange={event => onToggle(track.slotId, event.target.checked)} />
        {t('track_artists.use_own', { track: name })}</label>
        {selected ? <><p>{entriesByline(entries)}</p><EntryList entries={entries} mark={describe} /></> : <p className={styles.muted}>{t('track_artists.album_primary', { byline: albumByline })}</p>}</li>];
    })}</ul></dd></div>;
}


/** Independent track Credits that distinguish two import releases before either is chosen. */
export function TrackArtistProposals({ tracks, albumByline }: { tracks?: { discNumber: number; trackNumber: number; artists: { name: string; role: 'primary' | 'featured'; joinPhrase: string | null; musicBrainzId: string | null }[] }[]; albumByline: string }) {
  return <DeliveryTextBoundary fallback={<div><dd><Reload /></dd></div>}><Suspense fallback={null}><Proposals tracks={tracks} albumByline={albumByline} /></Suspense></DeliveryTextBoundary>;
}
function Proposals({ tracks = [], albumByline }: Parameters<typeof TrackArtistProposals>[0]) {
  const t = useTrackArtistText();
  return <div><dt>{t('track_artists.title')}</dt><dd>{!tracks.length ? t('track_artists.album_primary', { byline: albumByline }) : <ol>{tracks.map(track =>
    <li key={`${track.discNumber}:${track.trackNumber}`}>{t('publication.track_position', { disc: track.discNumber, track: track.trackNumber })} · {entriesByline(track.artists)}
      <ul>{track.artists.map((entry, index) => <li key={index}>{[entry.name, entry.musicBrainzId && t('lookup.musicbrainz_id', { id: entry.musicBrainzId })].filter(Boolean).join(' · ')}</li>)}</ul></li>)}</ol>}</dd></div>;
}
