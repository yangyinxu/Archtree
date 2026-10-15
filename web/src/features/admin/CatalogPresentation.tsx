import { Artwork } from '../../components/Artwork';
import type { useAdminText } from './AdminAccess';
import type { CatalogItem, CatalogKind } from './catalogApi';
import { reviewValueText } from './reviewValueText';
import catalogStyles from '../catalog/CatalogPages.module.css';

export const catalogLabels = { album: 'common.label.album', artist: 'common.label.artist', audioTrack: 'common.label.mediatrack', organization: 'common.label.organization' } as const;
export const catalogFallbacks = { album: 'content.title.untitled_album', artist: 'content.title.unknown_artist', audioTrack: 'content.title.untitled_track', organization: 'content.title.unknown_organization' } as const;
/** Trims presentation only; retained edit values and their mutation baseline stay intact. */
export const catalogName = (item: CatalogItem) => ('name' in item.fields ? item.fields.name : item.fields.title).trim();
/** Keeps return navigation in the same category, including error and recovery details. */
export const inventoryPath = (kind: CatalogKind) => `/admin/catalog${kind === 'album' ? '' : `?kind=${kind}`}`;
/** Saved metadata gives cards and details context without loading public listener data. */
export function catalogMetadata(item: CatalogItem, t: ReturnType<typeof useAdminText>, compact = false) {
  const date = 'releaseDate' in item.fields ? item.fields.releaseDate : null;
  return [t(`field.${item.visibility}`), item.kind === 'organization' ? t(`organization.${item.fields.organizationType}`) : null,
    date ? compact ? date.year : reviewValueText(date) : null,
    item.kind === 'audioTrack' && item.fields.trackNumber ? `${t('field.trackNumber')} ${item.fields.trackNumber}` : null].filter(Boolean).join(' · ');
}
/** Reuses listener artwork geometry with private sources; Organizations retain their name mark. */
export function CatalogArtwork({ item, viewerId, refresh, alt = '', detail = false }: { item: CatalogItem; viewerId: string; refresh: number; alt?: string; detail?: boolean }) {
  if (item.kind === 'organization') return <span aria-hidden="true" className={`${catalogStyles.organizationMark} ${detail ? catalogStyles.heroArtwork : ''}`}>{(Array.from(catalogName(item).trim())[0] || 'O').toUpperCase()}</span>;
  return <Artwork key={`${item.revision}:${refresh}`} alt={alt} kind={item.kind}
    className={detail ? item.kind === 'artist' ? catalogStyles.artistArtwork : catalogStyles.heroArtwork : undefined}
    loading={detail ? 'eager' : 'lazy'} fetchPriority={detail ? 'high' : undefined}
    src={item.coverUrl ? `${item.coverUrl}?viewer=${encodeURIComponent(viewerId)}` : null} />;
}
