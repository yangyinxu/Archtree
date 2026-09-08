import { ManagementInventoryPage } from './inventoryPagination';

export const inventoryQueryNames = {
    artists: 'artistsPage',
    organizations: 'organizationsPage',
    albums: 'albumsPage',
    audioTracks: 'audioTracksPage',
    pages: 'pagesPage',
    carousels: 'carouselsPage',
    contentCollections: 'contentCollectionsPage'
} as const;

export type InventoryKey = keyof typeof inventoryQueryNames;

type InventoryPaginationEntry = Omit<ManagementInventoryPage<unknown>, 'items'>;

export type InventoryPagination = Record<InventoryKey, InventoryPaginationEntry>;

export type ManagerView = 'overview' | 'catalog' | 'layout' | 'operations';

export type CatalogSection = InventoryKey;

const catalogSections: CatalogSection[] = [
    'artists',
    'organizations',
    'albums',
    'audioTracks',
    'pages',
    'carousels',
    'contentCollections'
];

/** Resolves one focused Catalog inventory while keeping URLs safe and deterministic. */
export const catalogSectionFromQuery = (value: unknown): CatalogSection => {
    const normalized = String(value ?? '').trim();
    return catalogSections.includes(normalized as CatalogSection)
        ? normalized as CatalogSection
        : 'artists';
};

export const catalogSectionForSelection = (selectionType: string): CatalogSection | null => {
    if (selectionType === 'artist') return 'artists';
    if (selectionType === 'organization') return 'organizations';
    if (selectionType === 'album') return 'albums';
    if (selectionType === 'audioTrack') return 'audioTracks';
    return null;
};

export const managerViewFromQuery = (value: unknown): ManagerView => {
    const normalized = String(value ?? '').trim();
    return normalized === 'catalog' || normalized === 'layout' || normalized === 'operations'
        ? normalized
        : 'overview';
};
