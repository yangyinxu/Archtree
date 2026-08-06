import assert from 'node:assert/strict';
import test from 'node:test';

import {
    deleteAlbum,
    postAlbum,
    updateAlbum
} from '../src/controllers/albumController';
import {
    deleteArtist,
    postArtist,
    updateArtist
} from '../src/controllers/artistController';
import {
    deleteAudioTrack,
    postAudioTrack,
    updateAudioTrack,
    uploadAudioTrackFile
} from '../src/controllers/audioTrackController';
import {
    addContentCollectionItem,
    attachContentCollectionToPage,
    createContentCollection,
    deleteContentCollection,
    listContentCollections,
    removeContentCollectionFromPage,
    reorderContentCollectionItems
} from '../src/controllers/contentCollectionController';
import {
    bulkUploadAudioTracksWeb,
    createAlbumWeb,
    createArtistWeb,
    createAudioTrackWeb,
    deleteAlbumAudioTracksWeb,
    deleteAlbumWeb,
    deleteArtistWeb,
    deleteAudioTrackWeb,
    linkAlbumToArtistWeb,
    linkTrackToAlbumWeb,
    linkTrackToArtistWeb,
    renderAudioTracksPageForWeb,
    renderManagePageForWeb,
    searchContentWeb,
    updateAlbumWeb,
    updateArtistWeb,
    updateAudioTrackWeb,
    uploadAudioTrackWeb
} from '../src/controllers/contentController';
import { createPost, deletePost } from '../src/controllers/feedController';
import {
    addCarouselItem,
    addCarouselItemWeb,
    attachCarouselToPage,
    attachCarouselToPageWeb,
    createCarousel,
    createCarouselWeb,
    createOrUpdatePageWeb,
    deleteCarousel,
    deleteCarouselWeb,
    detachCarouselFromPageWeb,
    listCarousels,
    moveCarouselItemBetweenCarousels,
    moveCarouselItemBetweenCarouselsWeb,
    removeCarouselFromPage,
    renameManualCarousel,
    renameManualCarouselWeb,
    reorderCarouselItems,
    reorderCarouselItemsWeb,
    reorderPageItems,
    reorderPageItemsWeb,
    updateArtistCarousel,
    updateArtistCarouselWeb,
    updatePersonalizedCarousel,
    updatePersonalizedCarouselWeb,
    upsertPage
} from '../src/controllers/pageController';

type Controller = (req: any, res: any, next: any) => unknown;

const apiControllers: Array<[string, Controller]> = [
    ['create Artist', postArtist],
    ['update Artist', updateArtist],
    ['delete Artist', deleteArtist],
    ['create Album', postAlbum],
    ['update Album', updateAlbum],
    ['delete Album', deleteAlbum],
    ['create Soundtrack', postAudioTrack],
    ['update Soundtrack', updateAudioTrack],
    ['delete Soundtrack', deleteAudioTrack],
    ['upload Soundtrack audio', uploadAudioTrackFile],
    ['create Grid/List', createContentCollection],
    ['list management Grid/List definitions', listContentCollections],
    ['attach Grid/List', attachContentCollectionToPage],
    ['detach Grid/List', removeContentCollectionFromPage],
    ['add Grid/List item', addContentCollectionItem],
    ['reorder Grid/List items', reorderContentCollectionItems],
    ['delete Grid/List', deleteContentCollection],
    ['create Feed Post', createPost],
    ['delete Feed Post', deletePost],
    ['upsert Page', upsertPage],
    ['create Carousel', createCarousel],
    ['update Artist Carousel', updateArtistCarousel],
    ['update personalized Carousel', updatePersonalizedCarousel],
    ['rename manual Carousel', renameManualCarousel],
    ['list management Carousels', listCarousels],
    ['attach Carousel to Page', attachCarouselToPage],
    ['detach Carousel from Page', removeCarouselFromPage],
    ['reorder Page items', reorderPageItems],
    ['add Carousel item', addCarouselItem],
    ['reorder Carousel items', reorderCarouselItems],
    ['move Carousel item', moveCarouselItemBetweenCarousels],
    ['delete Carousel', deleteCarousel]
];

const webControllers: Array<[string, Controller]> = [
    ['render Soundtrack inventory', renderAudioTracksPageForWeb],
    ['render Content Manager', renderManagePageForWeb],
    ['search Content Manager', searchContentWeb],
    ['create Artist', createArtistWeb],
    ['update Artist', updateArtistWeb],
    ['delete Artist', deleteArtistWeb],
    ['create Album', createAlbumWeb],
    ['update Album', updateAlbumWeb],
    ['delete Album', deleteAlbumWeb],
    ['create Soundtrack', createAudioTrackWeb],
    ['update Soundtrack', updateAudioTrackWeb],
    ['delete Soundtrack', deleteAudioTrackWeb],
    ['delete album Soundtracks', deleteAlbumAudioTracksWeb],
    ['upload Soundtrack audio', uploadAudioTrackWeb],
    ['bulk upload Soundtracks', bulkUploadAudioTracksWeb],
    ['link Soundtrack to Album', linkTrackToAlbumWeb],
    ['link Album to Artist', linkAlbumToArtistWeb],
    ['link Soundtrack to Artist', linkTrackToArtistWeb],
    ['upsert Page', createOrUpdatePageWeb],
    ['create Carousel', createCarouselWeb],
    ['update Artist Carousel', updateArtistCarouselWeb],
    ['update personalized Carousel', updatePersonalizedCarouselWeb],
    ['rename manual Carousel', renameManualCarouselWeb],
    ['attach Carousel to Page', attachCarouselToPageWeb],
    ['reorder Page items', reorderPageItemsWeb],
    ['detach Carousel from Page', detachCarouselFromPageWeb],
    ['add Carousel item', addCarouselItemWeb],
    ['reorder Carousel items', reorderCarouselItemsWeb],
    ['move Carousel items', moveCarouselItemBetweenCarouselsWeb],
    ['delete Carousel', deleteCarouselWeb]
];

const requestForRole = (role: string) => ({
    auth: {
        userId: 'legacy-content-provenance-user',
        email: 'listener@example.com',
        role
    },
    body: {},
    params: {},
    query: {},
    headers: {},
    get: () => undefined
});

const captureResponse = () => {
    const capture: { statusCode?: number; body?: unknown; contentType?: string } = {};
    const response = {
        status(statusCode: number) {
            capture.statusCode = statusCode;
            return this;
        },
        json(body: unknown) {
            capture.body = body;
            return this;
        },
        type(contentType: string) {
            capture.contentType = contentType;
            return this;
        },
        send(body: unknown) {
            capture.body = body;
            return this;
        },
        redirect(...args: unknown[]) {
            capture.body = args;
            return this;
        }
    };
    return { capture, response };
};

const unexpectedNext = (error?: unknown) => {
    throw error ?? new Error('Controller unexpectedly called next().');
};

test('shared API controllers reject user and legacy creator roles before content access', async () => {
    for (const role of ['user', 'creator']) {
        for (const [label, controller] of apiControllers) {
            const { capture, response } = captureResponse();
            await controller(requestForRole(role), response, unexpectedNext);
            assert.equal(capture.statusCode, 403, `${role} could ${label}`);
            assert.deepEqual(
                capture.body,
                { message: 'Administrator access is required.' },
                `${label} returned stale owner/creator language`
            );
        }
    }
});

test('Content Manager controllers independently reject non-admin roles', async () => {
    for (const role of ['user', 'creator']) {
        for (const [label, controller] of webControllers) {
            const { capture, response } = captureResponse();
            await controller(requestForRole(role), response, unexpectedNext);
            assert.equal(capture.statusCode, 403, `${role} could ${label}`);
            assert.equal(capture.contentType, 'text/plain');
            assert.equal(capture.body, 'Administrator access is required.');
        }
    }
});
