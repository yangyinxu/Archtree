import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPageItemsHierarchy } from '../src/views/contentManager/pageItemsView';

test('renders each page item in configured order with presentation and name', () => {
    const html = renderPageItemsHierarchy(
        [{
            slug: 'library',
            title: 'Library',
            items: [
                { itemType: 'list', collectionId: 'list-id', order: 2 },
                { itemType: 'carousel', carouselId: 'carousel-id', order: 0 },
                { itemType: 'grid', collectionId: 'grid-id', order: 1 }
            ]
        }],
        [{ _id: 'carousel-id', name: 'Recently Played', mode: 'personalized' }],
        [
            { _id: 'grid-id', name: 'Downloaded Albums', mode: 'dynamic', dynamicSource: 'downloadedAlbums' },
            { _id: 'list-id', name: 'Downloaded Songs', mode: 'dynamic', dynamicSource: 'downloadedSongs' }
        ]
    );

    const carouselIndex = html.indexOf('Recently Played');
    const gridIndex = html.indexOf('Downloaded Albums');
    const listIndex = html.indexOf('Downloaded Songs');
    assert.ok(carouselIndex >= 0);
    assert.ok(carouselIndex < gridIndex);
    assert.ok(gridIndex < listIndex);
    assert.match(html, /Carousel/);
    assert.match(html, /Grid/);
    assert.match(html, /List/);
});

test('renders missing and unknown references instead of hiding them', () => {
    const html = renderPageItemsHierarchy(
        [{
            slug: 'home',
            title: '<Home>',
            items: [
                { itemType: 'carousel', carouselId: 'missing-carousel', order: 0 },
                { itemType: 'future', collectionId: '<missing>', order: 1 }
            ]
        }],
        [],
        []
    );

    assert.match(html, /Unavailable carousel/);
    assert.match(html, /Unsupported page item/);
    assert.equal(html.includes('<Home>'), false);
    assert.match(html, /&lt;Home&gt;/);
    assert.match(html, /&lt;missing&gt;/);
});
