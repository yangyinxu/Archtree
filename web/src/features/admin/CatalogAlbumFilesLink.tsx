import { Suspense } from 'react';
import { Link } from 'react-router';
import { DeliveryTextBoundary, useAlbumImportText } from './adminPageText';
import styles from './adminStyles';

/**
 * "Add files to this Album" (the Album page hero) or, beside the expected tracklist summary, "Upload missing files": both open
 * New import for this Album. Its copy is release-packaged: nothing shows while it loads, and a pack that cannot load leaves the
 * link out while the Album page keeps working.
 */
export function CatalogAlbumFilesLink({ id, missing = false }: { id: string; missing?: boolean }) {
  return <DeliveryTextBoundary><Suspense fallback={null}><FilesLink id={id} missing={missing} /></Suspense></DeliveryTextBoundary>;
}
function FilesLink({ id, missing }: { id: string; missing: boolean }) {
  const t = useAlbumImportText();
  return <Link className={styles.link} to={`/admin/imports/new?album=${id}`}>{t(missing ? 'album_import.upload_missing' : 'album_import.add')}</Link>;
}
