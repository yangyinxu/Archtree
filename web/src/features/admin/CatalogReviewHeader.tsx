import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { Artwork } from '../../components/Artwork';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminEndpointRequest } from './adminTransport';
import { entriesByline } from './artistEntriesByline';
import { catalogResponse } from './catalogApi';
import type { CatalogReview } from './catalogReviewApi';
import { CatalogArtwork } from './CatalogPresentation';
import catalogStyles from '../catalog/CatalogPages.module.css';
import styles from './adminStyles';

/**
 * The review page's header (docs/features/admin-workbench.md, the review page's layout), its own chunk: the Album's current artwork
 * from the catalog Album read the Album page uses (`GET /catalog/album/:id`, under AdminCatalogEditor's query key, so either page
 * reuses the other's read), with the artwork placeholder while that read is pending, fails or finds none; the captured Album title
 * as stored (a trailing credit is never stripped); the draft's primary Artist names; and how many local tracks the review captured.
 * `children` are the page's own header actions. It is a compact Album hero, its cover beside the title at every width (a small one
 * on a phone), so the lookup status below stays in the first screen above the sticky action bar. A cover is presentation only: a
 * read this bundle cannot parse shows the placeholder and asks for no reload, and an Album no longer available is not read.
 */
export function CatalogReviewHeader({ item, children }: { item: CatalogReview; children?: ReactNode }) {
  const t = useAdminText(), { t: shared } = useLocalization(), access = useAdminAccess(), { id, title } = item.source.album;
  const query = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'catalog', 'album', id],
    queryFn: async ({ signal }) => {
      const parsed = catalogResponse.safeParse(await adminEndpointRequest(`/catalog/album/${id}`, z.unknown(), { signal }));
      if (!parsed.success || parsed.data.item.kind !== 'album' || parsed.data.item.id !== id) throw new Error('Unreadable Album artwork');
      return parsed.data;
    },
    retry: false, gcTime: 0, enabled: item.sourceStatus !== 'unavailable'
  });
  const alt = shared('content.album.cover_alt', { title }), byline = entriesByline(item.draft.album.artists.filter(entry => entry.role === 'primary'));
  return <header className={`${catalogStyles.hero} ${styles.reviewHero}`} style={{ marginBottom: '1rem' }}>
    {query.data ? <CatalogArtwork item={query.data.item} viewerId={access.viewerId} refresh={0} detail alt={alt} />
      : <Artwork kind="album" alt={alt} className={catalogStyles.heroArtwork} />}
    <div className={catalogStyles.heroCopy}><p className={catalogStyles.eyebrow}>{t('catalog_review.title')}</p>
      <h1 style={{ fontSize: 'clamp(1.5rem, 3.2vw, 2.5rem)', maxWidth: 'none', lineHeight: 1.1, overflowWrap: 'anywhere' }}>{title || t('catalog_review.title')}</h1>
      <p className={catalogStyles.metadata}>{byline && <><strong>{byline}</strong> · </>}{t('catalog_review.local_tracks', { count: item.source.tracks.length })}</p>
      {children}</div>
  </header>;
}
