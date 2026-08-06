import { escapeHtml } from '../html';

const identifier = (document: any) => String(document?._id ?? '');

const referenceLabel = (item: any) => {
    if (item?.itemType === 'grid') return 'Grid';
    if (item?.itemType === 'list') return 'List';
    if (item?.itemType === 'carousel' || item?.carouselId) return 'Carousel';
    return 'Unknown';
};

/** Shows every configured page item in persisted order, including broken references. */
export const renderPageItemsHierarchy = (
    pages: any[],
    carousels: any[],
    contentCollections: any[]
) => {
    if (pages.length === 0) {
        return '<h3>Pages</h3><p class="empty-linked-content">No pages yet.</p>';
    }

    const carouselsById = new Map(carousels.map((carousel) => [identifier(carousel), carousel]));
    const collectionsById = new Map(contentCollections.map((collection) => [identifier(collection), collection]));
    const pageCards = pages.map((page) => {
        const slug = String(page.slug ?? '');
        const title = String(page.title ?? (slug || 'Untitled page'));
        const items = Array.isArray(page.items)
            ? [...page.items].sort((left: any, right: any) =>
                Number(left.order ?? 0) - Number(right.order ?? 0)
            )
            : [];
        const renderedItems = items.map((item: any) => {
            const type = referenceLabel(item);
            if (type === 'Carousel') {
                const referenceId = String(item.carouselId ?? '');
                const carousel = carouselsById.get(referenceId);
                const name = carousel
                    ? String(carousel.name ?? 'Untitled carousel')
                    : 'Carousel not loaded on this inventory page';
                const mode = carousel?.mode === 'artist'
                    ? 'Artist'
                    : carousel?.mode === 'personalized' ? 'Personalized' : 'Manual';
                return `<li><span class="pill">Carousel</span> <strong>${escapeHtml(name)}</strong> <span class="item-meta">${escapeHtml(mode)} · <code>${escapeHtml(referenceId)}</code></span></li>`;
            }
            if (type === 'Grid' || type === 'List') {
                const referenceId = String(item.collectionId ?? '');
                const collection = collectionsById.get(referenceId);
                const name = collection
                    ? String(collection.name ?? `Untitled ${type.toLowerCase()}`)
                    : `${type} not loaded on this inventory page`;
                const mode = collection?.mode === 'dynamic' ? 'Dynamic' : 'Manual';
                const source = collection?.dynamicSource
                    ? ` · ${String(collection.dynamicSource)}`
                    : '';
                return `<li><span class="pill">${type}</span> <strong>${escapeHtml(name)}</strong> <span class="item-meta">${escapeHtml(mode + source)} · <code>${escapeHtml(referenceId)}</code></span></li>`;
            }

            const rawReference = String(item.collectionId ?? item.carouselId ?? 'Missing ID');
            return `<li><span class="pill pill--muted">Unknown</span> <strong>Unsupported page item</strong> <span class="item-meta"><code>${escapeHtml(rawReference)}</code></span></li>`;
        }).join('');
        const pageItems = renderedItems
            ? `<ol class="linked-content page-item-list">${renderedItems}</ol>`
            : '<p class="empty-linked-content">No page items configured.</p>';

        return `<div class="hierarchy-item"><strong>${escapeHtml(title)} [${escapeHtml(slug)}]</strong><span>${items.length} page item${items.length === 1 ? '' : 's'}</span>${pageItems}</div>`;
    }).join('');

    return `<h3>Pages</h3><div class="content-hierarchy">${pageCards}</div>`;
};
