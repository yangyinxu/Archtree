import { useEffect, useRef, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminEndpointRequest } from './adminTransport';
import { catalogAlbumTracksSchema, type CatalogAlbumTrack } from './catalogAlbumTracksApi';
import styles from './adminStyles';

// Inline layout keeps this lazily loaded section out of the shared administrator stylesheet and class map.
const layout = {
  list: { listStyle: 'none', margin: '.75rem 0 0', padding: 0 },
  row: { display: 'grid', gridTemplateColumns: '2.25rem minmax(0, 1fr)', gap: '.75rem', alignItems: 'baseline', borderTop: '1px solid var(--color-border)', padding: '.7rem 0' },
  position: { color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums', textAlign: 'end' },
  title: { display: 'inline-block', fontWeight: 650, minHeight: '1.5rem', overflowWrap: 'anywhere' },
  link: { color: 'inherit', textDecoration: 'underline', textDecorationColor: 'var(--color-border-strong)', textUnderlineOffset: '.2em' },
  details: { color: 'var(--color-text-muted)', fontSize: '.8rem', margin: '.15rem 0 0', overflowWrap: 'anywhere' }
} satisfies Record<string, CSSProperties>;
const stateLabels = { pending: 'catalog.album_track_state_pending', failed: 'catalog.album_track_state_failed',
  deleting: 'catalog.album_track_state_deleting', unpublished: 'catalog.album_track_state_unpublished',
  unavailable: 'catalog.album_track_state_unavailable' } as const;

/**
 * Read-only member list of an Album page in the Album order. Ordering and editing stay on each MediaTrack's own catalog
 * page, which only a ready MediaTrack has; the header's Refresh (`refresh`) also rereads this list.
 */
export function CatalogAlbumTracks({ id, refresh }: { id: string; refresh: number }) {
  const t = useAdminText(), access = useAdminAccess(), { t: sharedText } = useLocalization();
  // A key apart from the Album snapshot's, which the editor cancels and resets around its own writes.
  const query = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'catalog-album-tracks', id],
    queryFn: ({ signal }) => adminEndpointRequest(`/catalog/album/${id}/tracks`, catalogAlbumTracksSchema.refine(value => value.albumId === id), { signal }),
    retry: false, gcTime: 0
  });
  const { refetch } = query, seen = useRef(refresh);
  // Only a later Refresh rereads; the mount read already runs, even when the page was refreshed before this mounted.
  useEffect(() => { if (refresh === seen.current) return; seen.current = refresh; void refetch(); }, [refresh, refetch]);
  const row = (track: CatalogAlbumTrack) => {
    if (track.state === 'missing') return <li key={track.id} style={layout.row}><span style={layout.position}>{track.position}</span>
      <div><span style={layout.title}>{t('catalog.album_track_missing')}</span><p style={layout.details}>{track.id}</p></div></li>;
    const title = track.title.trim() || sharedText('content.title.untitled_track');
    const details = [track.discNumber ? `${t('field.discNumber')} ${track.discNumber}` : null, track.trackNumber ? `${t('field.trackNumber')} ${track.trackNumber}` : null,
      track.duration, sharedText(track.mediaType === 'video' ? 'common.label.video' : 'common.label.audio')].filter(Boolean).join(' · ');
    return <li key={track.id} style={layout.row}><span style={layout.position}>{track.position}</span>
      <div>{track.state === 'ready' ? <Link style={{ ...layout.title, ...layout.link }} to={`/admin/catalog/audioTrack/${track.id}`}>{title}</Link> : <span style={layout.title}>{title}</span>}
        <p style={layout.details}>{details}</p>
        {(track.visibility === 'hidden' || track.state !== 'ready' || track.linkedElsewhere) && <div className={styles.badges}>
          {track.visibility === 'hidden' && <span className={styles.badge}>{t('field.hidden')}</span>}
          {track.state !== 'ready' && <span className={styles.badge}>{t(stateLabels[track.state])}</span>}
          {track.linkedElsewhere && <span className={styles.badge}>{t('catalog.album_track_linked_elsewhere')}</span>}</div>}
      </div></li>;
  };
  const data = query.data;
  return <section className={styles.panel} aria-labelledby="catalog-album-tracks">
    <header className={styles.sectionHeader}><h2 id="catalog-album-tracks">{t('catalog.album_tracks')}</h2></header>
    <p className={styles.muted}>{t(data?.order === 'legacyAlbumLinks' ? 'catalog.album_tracks_legacy' : 'catalog.album_tracks_copy')}</p>
    {query.isPending && <p role="status">{t('common.loading')}</p>}
    {query.isError && <div className={styles.error} role="alert"><p>{t('catalog.album_tracks_error')}</p>
      <button className={styles.button} type="button" disabled={query.isFetching} onClick={() => void refetch()}>{t('common.retry')}</button></div>}
    {/* An explicit role keeps the list and its item count for VoiceOver, which drops them from unmarked lists. */}
    {data && (data.tracks.length ? <ol role="list" style={layout.list}>{data.tracks.map(row)}</ol> : <p>{t('catalog.album_tracks_empty')}</p>)}
    {data?.skipped ? <p className={styles.muted}>{t('catalog.album_tracks_skipped', { count: data.skipped })}</p> : null}
    {data?.truncated && <p className={styles.muted}>{t('catalog.album_tracks_truncated', { count: data.tracks.length })}</p>}
  </section>;
}
