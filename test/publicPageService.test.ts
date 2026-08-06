import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PublicContentVisibility,
    toPublicExpandedPage,
    toPublicPage
} from '../src/services/publicPageService';

const albumId = '64b000000000000000000001';
const readyTrackId = '64b000000000000000000002';
const pendingTrackId = '64b000000000000000000003';
const postId = '64b000000000000000000004';
const carouselId = '64b000000000000000000005';
const collectionId = '64b000000000000000000006';

const visibility: PublicContentVisibility = {
    albumIds: new Set([albumId]),
    audioTrackIds: new Set([readyTrackId]),
    postIds: new Set([postId])
};

test('public Page projection strips mutation provenance and invalid references', () => {
    const page = toPublicPage({
        _id: '64b000000000000000000099',
        slug: 'home',
        title: 'Home',
        createdBy: 'private-owner',
        updatedBy: 'private-editor',
        items: [
            { itemType: 'carousel', carouselId, order: 4, internal: true },
            { itemType: 'list', collectionId, order: 2 },
            { itemType: 'carousel', carouselId: 'invalid', order: 1 }
        ]
    });

    assert.deepEqual(page, {
        slug: 'home',
        title: 'Home',
        items: [
            { itemType: 'list', collectionId, order: 0 },
            { itemType: 'carousel', carouselId, order: 1 }
        ]
    });
});

test('expanded public Page removes dangling and non-ready section items', () => {
    const page = {
        slug: 'home',
        title: 'Home',
        items: [
            { itemType: 'carousel', carouselId, order: 0 },
            { itemType: 'grid', collectionId, order: 1 },
            {
                itemType: 'carousel',
                carouselId: '64b000000000000000000007',
                order: 2
            }
        ]
    };
    const expanded = toPublicExpandedPage(page, [{
        _id: carouselId,
        name: 'Featured',
        mode: 'manual',
        createdBy: 'private-owner',
        items: [
            { contentType: 'audioTrack', contentId: pendingTrackId, order: 0 },
            { contentType: 'album', contentId: albumId, order: 1 },
            { contentType: 'audioTrack', contentId: readyTrackId, order: 2 },
            { contentType: 'post', contentId: postId, order: 3 }
        ]
    }], [{
        _id: collectionId,
        name: 'Songs',
        presentation: 'list',
        mode: 'manual',
        contentType: 'audioTrack',
        updatedBy: 'private-editor',
        items: [
            { contentType: 'audioTrack', contentId: pendingTrackId, order: 0 },
            { contentType: 'audioTrack', contentId: readyTrackId, order: 1 }
        ]
    }], visibility);

    assert.equal(expanded.items.length, 2);
    assert.deepEqual(expanded.items[0].carousel.items, [
        { contentType: 'album', contentId: albumId, order: 0 },
        { contentType: 'audioTrack', contentId: readyTrackId, order: 1 },
        { contentType: 'post', contentId: postId, order: 2 }
    ]);
    assert.deepEqual(expanded.items[1].contentCollection.items, [
        { contentType: 'audioTrack', contentId: readyTrackId, order: 0 }
    ]);
    assert.equal(JSON.stringify(expanded).includes('private-owner'), false);
    assert.equal(JSON.stringify(expanded).includes('private-editor'), false);
    assert.equal(JSON.stringify(expanded).includes(pendingTrackId), false);
});
