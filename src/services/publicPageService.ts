export interface PublicContentVisibility {
    albumIds: ReadonlySet<string>;
    audioTrackIds: ReadonlySet<string>;
    postIds: ReadonlySet<string>;
}

const objectIdPattern = /^[0-9a-fA-F]{24}$/;
const maximumPageItems = 100;
const maximumSectionItems = 500;
const asObjectId = (value: unknown) => {
    const id = String(value ?? '').trim();
    return objectIdPattern.test(id) ? id : null;
};
const normalizedOrder = (value: unknown, fallback: number) => {
    const order = Number(value);
    return Number.isFinite(order) ? Math.max(0, Math.floor(order)) : fallback;
};

const sortedItems = (items: unknown, limit: number) => (
    Array.isArray(items) ? [...items] : []
).sort((left: any, right: any) =>
    normalizedOrder(left?.order, 0) - normalizedOrder(right?.order, 0)
).slice(0, limit);

/** Allowlists public page references without exposing Page provenance or audit fields. */
export const toPublicPage = (page: any) => ({
    slug: String(page?.slug ?? ''),
    title: String(page?.title ?? '').trim(),
    items: sortedItems(page?.items, maximumPageItems).flatMap((item: any): Array<Record<string, unknown>> => {
        if (item?.itemType === 'carousel') {
            const carouselId = asObjectId(item.carouselId);
            return carouselId ? [{ itemType: 'carousel', carouselId }] : [];
        }
        if (item?.itemType === 'grid' || item?.itemType === 'list') {
            const collectionId = asObjectId(item.collectionId);
            return collectionId
                ? [{ itemType: item.itemType, collectionId }]
                : [];
        }
        return [];
    }).map((item, order) => ({ ...item, order }))
});

const isVisibleContent = (
    contentType: unknown,
    contentId: string,
    visibility: PublicContentVisibility
) => contentType === 'album'
    ? visibility.albumIds.has(contentId)
    : contentType === 'audioTrack'
        ? visibility.audioTrackIds.has(contentId)
        : contentType === 'post' && visibility.postIds.has(contentId);

/** Removes dangling and non-ready references, then returns stable contiguous order. */
export const toPublicContentRefs = (
    items: unknown,
    visibility: PublicContentVisibility,
    allowedTypes: ReadonlySet<string> = new Set(['post', 'album', 'audioTrack'])
) => sortedItems(items, maximumSectionItems).flatMap((item: any) => {
    const contentType = String(item?.contentType ?? '');
    const contentId = asObjectId(item?.contentId);
    if (!contentId || !allowedTypes.has(contentType)
        || !isVisibleContent(contentType, contentId, visibility)) {
        return [];
    }
    return [{ contentType, contentId }];
}).map((item, order) => ({ ...item, order }));

const publicArtistConfig = (value: any) => {
    const artistId = asObjectId(value?.artistId);
    const contentType = value?.contentType === 'album'
        ? 'album'
        : value?.contentType === 'audioTrack' ? 'audioTrack' : null;
    if (!artistId || !contentType) return null;
    const requestedLimit = Number(value?.limit ?? 20);
    return {
        artistId,
        contentType,
        sort: value?.sort === 'titleAsc' ? 'titleAsc' : 'releaseDateDesc',
        limit: Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 20, 100))
    };
};

const publicPersonalizedConfig = (value: any) => {
    const source = value?.source === 'recentlySaved'
        ? 'recentlySaved'
        : value?.source === 'recentlyPlayed' ? 'recentlyPlayed' : null;
    if (!source) return null;
    const requestedLimit = Number(value?.limit ?? 20);
    return {
        source,
        limit: Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 20, 20))
    };
};

/** Projects one resolved Carousel to the public iOS/Web composition contract. */
export const toPublicCarousel = (carousel: any, visibility: PublicContentVisibility) => {
    const id = asObjectId(carousel?._id);
    const mode = carousel?.mode === 'artist'
        ? 'artist'
        : carousel?.mode === 'personalized' ? 'personalized' : 'manual';
    const projected: Record<string, unknown> = {
        ...(id ? { _id: id } : {}),
        name: String(carousel?.name ?? '').trim(),
        items: toPublicContentRefs(carousel?.items, visibility),
        mode
    };
    if (mode === 'artist') projected.artistConfig = publicArtistConfig(carousel?.artistConfig);
    if (mode === 'personalized') {
        projected.personalizedConfig = publicPersonalizedConfig(carousel?.personalizedConfig);
    }
    return projected;
};

/** Projects one Grid/List definition without provenance or mutation audit fields. */
export const toPublicContentCollection = (
    collection: any,
    visibility: PublicContentVisibility
) => {
    const id = asObjectId(collection?._id);
    const presentation = collection?.presentation === 'grid' ? 'grid' : 'list';
    const mode = collection?.mode === 'dynamic' ? 'dynamic' : 'manual';
    const contentType = collection?.contentType === 'audioTrack' ? 'audioTrack' : 'album';
    const dynamicSource = collection?.dynamicSource === 'downloadedAlbums'
        ? 'downloadedAlbums'
        : collection?.dynamicSource === 'downloadedSongs' ? 'downloadedSongs' : null;
    return {
        ...(id ? { _id: id } : {}),
        name: String(collection?.name ?? '').trim(),
        presentation,
        mode,
        contentType,
        dynamicSource,
        items: mode === 'manual'
            ? toPublicContentRefs(collection?.items, visibility, new Set([contentType]))
            : []
    };
};

/** Expands only existing page sections and strips all internal composition fields. */
export const toPublicExpandedPage = (
    page: any,
    carousels: any[],
    contentCollections: any[],
    visibility: PublicContentVisibility
) => {
    const carouselsById = new Map(carousels.map((carousel) => [String(carousel?._id ?? ''), carousel]));
    const collectionsById = new Map(contentCollections.map((collection) => [
        String(collection?._id ?? ''),
        collection
    ]));
    const publicPage = toPublicPage(page);
    const items = publicPage.items.flatMap((item: any): Array<Record<string, unknown>> => {
        if (item.itemType === 'carousel') {
            const carousel = carouselsById.get(item.carouselId);
            return carousel ? [{
                itemType: 'carousel',
                carouselId: item.carouselId,
                carousel: toPublicCarousel(carousel, visibility)
            }] : [];
        }
        const collection = collectionsById.get(item.collectionId);
        return collection ? [{
            itemType: item.itemType,
            collectionId: item.collectionId,
            contentCollection: toPublicContentCollection(collection, visibility)
        }] : [];
    }).map((item, order) => ({ ...item, order }));
    return { ...publicPage, items };
};
