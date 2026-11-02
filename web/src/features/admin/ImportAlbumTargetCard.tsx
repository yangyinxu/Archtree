import { Suspense, useEffect, useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { z } from 'zod';
import { Artwork } from '../../components/Artwork';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { DeliveryTextBoundary, useAlbumImportText } from './adminPageText';
import { adminRequest } from './adminTransport';
import { adminWorkspace } from './adminWorkspace';
import styles from './adminStyles';

const id = z.string().regex(/^[a-f0-9]{24}$/);
/** The most members an Album may list for an import to append to (the server's ADMIN_IMPORT_LIMITS.appendTargetMembers). */
const APPEND_TARGET_MEMBERS = 5000;
/** GET /imports/album-targets/:albumId: why files cannot be added to the Album, if so, and what its card shows. */
export const albumTargetSchema = z.object({
  albumId: id, refusal: z.enum(['unavailable', 'unreadable', 'primaryRequired', 'primaryNotReady', 'tooLarge']).nullable(),
  album: z.object({ title: z.string().max(300), primaryArtists: z.array(z.string().max(200)).max(50), coverUrl: z.string().nullable(),
    missingRows: z.number().int().min(0).max(100).nullable() }).strict().nullable()
}).strict().refine(value => (value.album === null) === (value.refusal === 'unavailable' || value.refusal === 'unreadable')
  && (value.album?.coverUrl == null || value.album.coverUrl === `/api/admin/v1/catalog/album/${value.albumId}/artwork`), 'Invalid Album target');
const reasons = { unavailable: 'album_import.unavailable', unreadable: 'album_import.unreadable', primaryRequired: 'album_import.no_primary',
  primaryNotReady: 'album_import.primary_not_ready', tooLarge: 'album_import.too_large' } as const;
/** The selection the create page keeps belongs to this target ('' for a new Album); see AdminCreateImportPage. */
export const CREATE_TARGET_KEY = 'create-target';

/**
 * The heading and Target Album card of New import opened for an Album (`?album=<id>`): it reads that Album and reports it as
 * eligible (`onEligible(albumId)`) only while files can be added to it, else null. An Album that cannot take files (not found or
 * not ready, an unreadable title or visibility, no primary Artist Credit, a primary Artist that is not ready, too many members)
 * shows that reason instead of the card, with links back to the Album and to a new Album upload, which keeps the chosen files; a
 * malformed ID reads as unavailable without a request. `recheck` reads the Album again after a refused create (`refused`); while
 * it reads, and when it still finds the Album eligible, the card says the create was refused. Its copy is release-packaged, so it
 * suspends until the selected locale's pack is loaded; a pack that cannot load asks for a reload and Create stays disabled.
 */
export function ImportAlbumTargetCard(props: TargetProps) {
  return <DeliveryTextBoundary fallback={<CopyUnavailable />}><Suspense fallback={<Loading />}><TargetCard {...props} /></Suspense></DeliveryTextBoundary>;
}
type TargetProps = { albumId: string; recheck: number; refused: boolean; onEligible: (albumId: string | null) => void };
function CopyUnavailable() { const t = useAdminText(); return <p role="alert">{t('common.reload')}</p>; }
function Loading() { const t = useAdminText(); return <p role="status">{t('common.loading')}</p>; }
function TargetCard({ albumId, recheck, refused, onEligible }: TargetProps) {
  const t = useAlbumImportText(), access = useAdminAccess(), heading = useId(), valid = id.safeParse(albumId).success;
  const query = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'album-target', albumId],
    queryFn: ({ signal }) => adminRequest(`/album-targets/${albumId}`, albumTargetSchema.refine(value => value.albumId === albumId), { signal }),
    retry: false, gcTime: 0, enabled: valid
  });
  const { refetch } = query, data = query.data, album = data?.album ?? null;
  useEffect(() => { onEligible(data?.refusal === null ? albumId : null); }, [data, albumId]);
  useEffect(() => { if (recheck && valid) void refetch(); }, [recheck]);
  const refusal = valid ? data?.refusal ?? null : 'unavailable';
  return <>
    {valid && <Link className={styles.back} to={`/admin/catalog/album/${albumId}`}>{t('album_import.back')}</Link>}
    <h1 className={styles.title}>{t('album_import.title')}</h1>
    {valid && (query.isPending || refused && query.isFetching) && <p role="status">{t('common.loading')}</p>}
    {query.isError && <div role="alert"><p>{t('album_import.read_error')}</p>
      <button type="button" className={styles.button} disabled={query.isFetching} onClick={() => { void refetch(); }}>{t('common.retry')}</button></div>}
    {refusal && <div role="alert"><p>{t(reasons[refusal], refusal === 'tooLarge' ? { max: APPEND_TARGET_MEMBERS } : undefined)}</p>
      <div className={styles.actions}><Link className={styles.link} to="/admin/imports/new" onClick={() => adminWorkspace.retain(CREATE_TARGET_KEY, '', access)}>{t('workbench.new')}</Link></div></div>}
    {!refusal && refused && !query.isFetching && album && <p role="alert">{t('album_import.create_refused')}</p>}
    {!refusal && album && <>
      <p className={styles.muted}>{t('album_import.intro')}</p>
      <section className={styles.card} aria-labelledby={heading}>
        <h2 id={heading}>{t('album_import.target')}</h2>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div style={{ width: '5rem', flex: 'none' }}><Artwork kind="album" alt="" src={album.coverUrl ? `${album.coverUrl}?viewer=${encodeURIComponent(access.viewerId)}` : null} /></div>
          <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}><p><strong>{album.title}</strong></p>
            {album.primaryArtists.length > 0 && <p>{album.primaryArtists.join(', ')}</p>}
            {album.missingRows !== null && <p>{t('album_import.no_file_rows', { count: album.missingRows })}</p>}</div>
        </div>
      </section>
      <p className={styles.muted}>{t('album_import.append_note')}</p>
      <p className={styles.muted}>{t('album_import.lookup_note')}</p>
    </>}
  </>;
}
