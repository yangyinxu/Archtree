import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

import {
    renderAudioTracksPageForWeb,
    renderManagePageForWeb,
    searchContentWeb
} from '../src/controllers/contentController';
import { listCarousels } from '../src/controllers/pageController';
import { listContentCollections } from '../src/controllers/contentCollectionController';
import { Album } from '../src/models/album';
import { Artist } from '../src/models/artist';
import { AudioTrack } from '../src/models/audioTrack';
import { Carousel } from '../src/models/carousel';
import { ContentCollection } from '../src/models/contentCollection';
import { Page } from '../src/models/page';
import { Organization } from '../src/models/organization';
import { maxAudioBatchFiles } from '../src/middleware/audioUpload';
import {
    managementInventoryOffset,
    managementInventoryPageSize,
    maximumManagementInventoryPage,
    normalizeManagementInventoryPage,
    toManagementInventoryPage
} from '../src/views/contentManager/inventoryPagination';

const adminRequest = (query: Record<string, unknown> = {}) => ({
    auth: { userId: 'admin-id', email: 'admin@example.com', role: 'admin' },
    query
}) as unknown as Request;

const responseCapture = () => {
    const capture: { statusCode: number; html: string } = { statusCode: 200, html: '' };
    const response = {
        status(statusCode: number) {
            capture.statusCode = statusCode;
            return response;
        },
        send(html: string) {
            capture.html = html;
            return response;
        },
        redirect() {
            throw new Error('Admin inventory unexpectedly redirected.');
        }
    } as unknown as Response;
    return { capture, response };
};

test('normalizes management inventory pages and detects limit-plus-one pagination', () => {
    assert.equal(normalizeManagementInventoryPage(undefined), 1);
    assert.equal(normalizeManagementInventoryPage('-2'), 1);
    assert.equal(normalizeManagementInventoryPage('2.9'), 2);
    assert.equal(normalizeManagementInventoryPage('999999'), maximumManagementInventoryPage);
    assert.equal(managementInventoryOffset(2), managementInventoryPageSize);

    const page = toManagementInventoryPage(
        Array.from({ length: managementInventoryPageSize + 1 }, (_, index) => index),
        2
    );
    assert.equal(page.items.length, managementInventoryPageSize);
    assert.equal(page.hasPrevious, true);
    assert.equal(page.hasNext, true);
    assert.equal(toManagementInventoryPage(
        Array.from({ length: managementInventoryPageSize + 1 }, (_, index) => index),
        maximumManagementInventoryPage
    ).hasNext, false);
});

test('Content Manager loads global inventory into focused Catalog sections', async () => {
    const originals = {
        artists: Artist.fetchAll,
        artistById: Artist.findById,
        artistSearch: Artist.searchByName,
        organizations: Organization.fetchAll,
        organizationById: Organization.findById,
        organizationSearch: Organization.searchByName,
        albums: Album.fetchAll,
        albumSearch: Album.searchByTitle,
        audioTracks: AudioTrack.fetchAll,
        audioTrackById: AudioTrack.findById,
        audioTrackSearch: AudioTrack.searchByTitle,
        pages: Page.fetchAll,
        carousels: Carousel.fetchAll,
        contentCollections: ContentCollection.fetchAll
    };
    const calls: Record<string, { limit: number; offset: number }> = {};
    const trackRecords = Array.from({ length: managementInventoryPageSize + 1 }, (_, index) => ({
        _id: `track-${index}`,
        title: index === 0 ? 'Legacy Global Track' : `Track ${index}`,
        uploadStatus: 'ready',
        createdBy: 'legacy-owner'
    }));
    const previousBucket = process.env.S3_BUCKET_NAME;
    const originalConsoleLog = console.log;
    delete process.env.S3_BUCKET_NAME;
    console.log = () => undefined;

    (Artist as any).fetchAll = async (limit: number, offset: number) => {
        calls.artists = { limit, offset };
        return [{ _id: 'artist-1', name: 'Legacy Global Artist', albumIds: [], createdBy: 'legacy-owner' }];
    };
    (Artist as any).findById = async (id: string) => id === 'artist-1'
        ? { _id: 'artist-1', name: 'Legacy Global Artist', albumIds: [], createdBy: 'legacy-owner' }
        : null;
    (Artist as any).searchByName = async () => [{ _id: 'artist-2', name: 'Search Result Artist' }];
    (Organization as any).fetchAll = async (limit: number, offset: number) => {
        calls.organizations = { limit, offset };
        return [{
            _id: 'organization-1',
            name: 'Global Publisher',
            organizationType: 'publisher',
            createdBy: 'legacy-owner'
        }];
    };
    (Organization as any).findById = async (id: string) => id === 'organization-1'
        ? {
            _id: 'organization-1',
            name: 'Global Publisher',
            organizationType: 'publisher',
            description: 'Selected institutional credit owner.'
        }
        : null;
    (Organization as any).searchByName = async () => [];
    (Album as any).fetchAll = async (limit: number, offset: number) => {
        calls.albums = { limit, offset };
        return [{ _id: 'album-1', title: 'Legacy Global Album', audioTrackIds: ['track-0'], createdBy: 'legacy-owner' }];
    };
    (Album as any).searchByTitle = async () => [];
    (AudioTrack as any).fetchAll = async (limit: number, offset: number) => {
        calls.audioTracks = { limit, offset };
        return trackRecords;
    };
    (AudioTrack as any).findById = async (id: string) => id === '000000000000000000000001'
        ? {
            _id: id,
            title: 'Selected Video MediaTrack',
            mediaType: 'video',
            uploadStatus: 'ready',
            publicationStatus: 'ready',
            artistIds: [],
            genres: []
        }
        : null;
    (AudioTrack as any).searchByTitle = async () => [];
    (Page as any).fetchAll = async (limit: number, offset: number) => {
        calls.pages = { limit, offset };
        return [{ _id: 'page-1', slug: 'home', title: 'Global Home', items: [], createdBy: 'legacy-owner' }];
    };
    (Carousel as any).fetchAll = async (limit: number, offset: number) => {
        calls.carousels = { limit, offset };
        return [{ _id: 'carousel-1', name: 'Legacy Global Carousel', mode: 'manual', items: [], createdBy: 'legacy-owner' }];
    };
    (ContentCollection as any).fetchAll = async (limit: number, offset: number) => {
        calls.contentCollections = { limit, offset };
        return [{
            _id: 'collection-1',
            name: 'Legacy Global Grid',
            presentation: 'grid',
            mode: 'manual',
            items: [],
            createdBy: 'legacy-owner'
        }];
    };

    const { capture, response } = responseCapture();
    const albumsPage = responseCapture();
    const mediaTracksPage = responseCapture();
    const pagesPage = responseCapture();
    const searchPage = responseCapture();
    const operationsPage = responseCapture();
    const selectedArtistPage = responseCapture();
    const selectedOrganizationPage = responseCapture();
    const selectedMediaTrackPage = responseCapture();
    let nextError: unknown;
    try {
        await renderManagePageForWeb(
            adminRequest({ artistsPage: '2' }),
            response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
        await renderManagePageForWeb(
            adminRequest({ view: 'catalog', catalogType: 'albums', artistsPage: '2' }),
            albumsPage.response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
        await renderManagePageForWeb(
            adminRequest({ view: 'catalog', catalogType: 'audioTracks', artistsPage: '2' }),
            mediaTracksPage.response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
        await renderManagePageForWeb(
            adminRequest({ view: 'catalog', catalogType: 'pages', artistsPage: '2' }),
            pagesPage.response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
        await searchContentWeb(
            adminRequest({ q: 'Search Result', catalogType: 'artists', artistsPage: '2' }),
            searchPage.response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
        await renderManagePageForWeb(
            adminRequest({ view: 'operations', artistsPage: '2', prefillType: 'artist', prefillId: 'invalid' }),
            operationsPage.response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
        await renderManagePageForWeb(
            adminRequest({ view: 'catalog', artistsPage: '2', prefillType: 'artist', prefillId: 'artist-1' }),
            selectedArtistPage.response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
        await renderManagePageForWeb(
            adminRequest({
                view: 'catalog',
                prefillType: 'organization',
                prefillId: 'organization-1'
            }),
            selectedOrganizationPage.response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
        await renderManagePageForWeb(
            adminRequest({
                view: 'catalog',
                artistsPage: '2',
                prefillType: 'audioTrack',
                prefillId: '000000000000000000000001'
            }),
            selectedMediaTrackPage.response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
    } finally {
        Artist.fetchAll = originals.artists;
        Artist.findById = originals.artistById;
        Artist.searchByName = originals.artistSearch;
        Organization.fetchAll = originals.organizations;
        Organization.findById = originals.organizationById;
        Organization.searchByName = originals.organizationSearch;
        Album.fetchAll = originals.albums;
        Album.searchByTitle = originals.albumSearch;
        AudioTrack.fetchAll = originals.audioTracks;
        AudioTrack.findById = originals.audioTrackById;
        AudioTrack.searchByTitle = originals.audioTrackSearch;
        Page.fetchAll = originals.pages;
        Carousel.fetchAll = originals.carousels;
        ContentCollection.fetchAll = originals.contentCollections;
        console.log = originalConsoleLog;
        if (previousBucket === undefined) delete process.env.S3_BUCKET_NAME;
        else process.env.S3_BUCKET_NAME = previousBucket;
    }

    assert.equal(nextError, undefined);
    assert.equal(capture.statusCode, 200);
    assert.match(capture.html, /href="\/assets\/content-manager\.css"/);
    assert.match(capture.html, /content-manager-base\.css[\s\S]*content-manager\.css/);
    assert.doesNotMatch(capture.html, /<style>/);
    assert.match(capture.html, /<body class="manager-page manager-view-overview/);
    const managerHeader = capture.html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0] ?? '';
    assert.match(managerHeader, /<details class="manager-account" id="manager-account-menu">/);
    assert.match(managerHeader, /<summary><i class="ph ph-user-circle"[^>]*><\/i>Admin account<\/summary>/);
    assert.match(managerHeader, /ph ph-tree-structure/);
    assert.match(managerHeader, /admin@example\.com/);
    assert.match(managerHeader, /action="\/auth\/logout-web"/);
    assert.doesNotMatch(managerHeader, /MediaTracks|Audit Audio Storage|Audit Image Storage|>Home<|header-actions/);
    assert.deepEqual(calls.artists, {
        limit: managementInventoryPageSize + 1,
        offset: managementInventoryPageSize
    });
    for (const key of ['organizations', 'albums', 'audioTracks', 'pages', 'carousels', 'contentCollections']) {
        assert.deepEqual(calls[key], { limit: managementInventoryPageSize + 1, offset: 0 });
    }
    assert.match(capture.html, /id="catalog-content"/);
    assert.match(capture.html, /aria-label="Catalog content types"/);
    assert.match(capture.html, /catalogType=artists/);
    assert.match(capture.html, /catalogType=contentCollections/);
    assert.match(capture.html, /manager-view-overview/);
    assert.match(capture.html, /Set up an Artist release/);
    assert.match(capture.html, /Overview/);
    assert.match(capture.html, /ph ph-house-simple/);
    assert.match(capture.html, /ph ph-gear-six/);
    assert.match(capture.html, /Page Layout/);
    assert.match(capture.html, /Operations/);
    assert.match(capture.html, /Legacy Global Artist/);
    assert.match(capture.html, /id="inventory-artists"/);
    assert.doesNotMatch(capture.html, /id="inventory-albums"/);
    assert.doesNotMatch(capture.html, /Unified Search|id="catalog-search-results-title"/);
    assert.match(capture.html, /<details class="card catalog-tool-group surface-catalog" id="create">/);
    assert.match(capture.html, /id="open-by-id"/);
    assert.match(albumsPage.capture.html, /id="inventory-albums"/);
    assert.match(albumsPage.capture.html, /Legacy Global Album/);
    assert.match(albumsPage.capture.html, /<details class="linked-content-disclosure"><summary>1 linked MediaTrack<\/summary>/);
    assert.doesNotMatch(albumsPage.capture.html, /id="inventory-artists"/);
    assert.match(albumsPage.capture.html, /<strong>Create Album<\/strong>/);
    assert.match(mediaTracksPage.capture.html, /id="inventory-audioTracks"/);
    assert.match(mediaTracksPage.capture.html, /Legacy Global Track/);
    assert.match(mediaTracksPage.capture.html, /Next MediaTracks/);
    assert.match(pagesPage.capture.html, /id="inventory-pages"/);
    assert.match(pagesPage.capture.html, /Global Home/);
    assert.match(pagesPage.capture.html, /Manage Page Layout/);
    assert.doesNotMatch(pagesPage.capture.html, /id="create"/);
    assert.doesNotMatch(pagesPage.capture.html, /id="open-by-id"/);
    assert.match(searchPage.capture.html, /Matches for “Search Result”/);
    assert.match(searchPage.capture.html, /Search Result Artist/);
    assert.equal((searchPage.capture.html.match(/<section class="catalog-search-result-group">/g) ?? []).length, 1);
    assert.doesNotMatch(searchPage.capture.html, /<li>None<\/li>/);
    assert.match(capture.html, /Global Publisher/);
    assert.match(capture.html, /Legacy Global Carousel/);
    assert.match(capture.html, /Legacy Global Grid/);
    assert.match(capture.html, /Current structure/);
    assert.match(capture.html, /Page settings and placement/);
    assert.match(capture.html, /Create and configure Carousels/);
    assert.match(capture.html, /Previous Artists/);
    assert.match(capture.html, /name="mediaFile" accept="audio\/\*,video\/mp4"/);
    assert.match(capture.html, new RegExp(`Select up to ${maxAudioBatchFiles} files`));
    assert.match(capture.html, new RegExp(`data-max-files="${maxAudioBatchFiles}"`));
    assert.match(capture.html, /Files are uploaded one at a time/);
    assert.doesNotMatch(capture.html, /My Content|My Artists|My Albums|My Carousels|My MediaTracks/);
    assert.match(operationsPage.capture.html, /manager-view-operations/);
    assert.match(operationsPage.capture.html, /id="system-operations"/);
    assert.match(operationsPage.capture.html, /System operations/);
    assert.match(operationsPage.capture.html, /href="\/content\/manage\/audio-tracks"/);
    assert.match(operationsPage.capture.html, /href="\/admin\/audio-storage\/reconciliation"/);
    assert.match(operationsPage.capture.html, /href="\/admin\/image-storage\/reconciliation"/);
    assert.match(operationsPage.capture.html, /Recent Artist release setups/);
    assert.match(selectedArtistPage.capture.html, /manager-selection-artist/);
    assert.match(selectedArtistPage.capture.html, /id="selected-object"/);
    assert.match(selectedArtistPage.capture.html, /Legacy Global Artist/);
    assert.match(selectedArtistPage.capture.html, /data-copy-id="artist-1"/);
    assert.match(selectedArtistPage.capture.html, /id="catalog-object-workspaces"/);
    assert.doesNotMatch(selectedArtistPage.capture.html, /id="catalog-inventory"/);
    assert.ok(
        selectedArtistPage.capture.html.indexOf('id="catalog-content"')
            < selectedArtistPage.capture.html.indexOf('id="selected-object"')
    );
    assert.match(selectedArtistPage.capture.html, /Back to Artists/);
    assert.match(selectedOrganizationPage.capture.html, /manager-selection-organization/);
    assert.match(selectedOrganizationPage.capture.html, /Selected Organization/);
    assert.match(selectedOrganizationPage.capture.html, /Update Organization details/);
    assert.doesNotMatch(selectedOrganizationPage.capture.html, /action="\/content\/manage\/organization\/create"/);
    assert.doesNotMatch(selectedOrganizationPage.capture.html, /id="catalog-inventory"/);
    assert.match(selectedMediaTrackPage.capture.html, /Selected Video MediaTrack/);
    assert.match(selectedMediaTrackPage.capture.html, /Current kind: <strong>Video<\/strong>/);
    assert.match(selectedMediaTrackPage.capture.html, />Replace with Audio<\/button>/);
    assert.match(selectedMediaTrackPage.capture.html, />Replace with Video<\/button>/);
    assert.doesNotMatch(selectedMediaTrackPage.capture.html, /Delete Video|Audio\/Video|cover-only/);
});

test('MediaTrack inventory uses the global page and global administrator copy', async () => {
    const originalFetchAll = AudioTrack.fetchAll;
    let requested: { limit: number; offset: number } | undefined;
    (AudioTrack as any).fetchAll = async (limit: number, offset: number) => {
        requested = { limit, offset };
        return Array.from({ length: managementInventoryPageSize + 1 }, (_, index) => ({
            _id: `global-${index}`,
            title: index === 0 ? 'Cross-owner Track' : `Track ${index}`,
            uploadStatus: 'ready',
            createdBy: 'legacy-owner'
        }));
    };
    const { capture, response } = responseCapture();
    let nextError: unknown;
    try {
        await renderAudioTracksPageForWeb(
            adminRequest({ page: '2' }),
            response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
    } finally {
        AudioTrack.fetchAll = originalFetchAll;
    }

    assert.equal(nextError, undefined);
    assert.deepEqual(requested, {
        limit: managementInventoryPageSize + 1,
        offset: managementInventoryPageSize
    });
    assert.match(capture.html, /<h1[^>]*>MediaTracks<\/h1>/);
    assert.match(capture.html, /<body class="inventory-page">/);
    assert.match(capture.html, /class="site-header operations-header"/);
    assert.match(capture.html, /ph ph-tree-structure/);
    assert.match(capture.html, /ph ph-upload-simple/);
    assert.match(capture.html, /Global catalog/);
    assert.match(capture.html, /Cross-owner Track/);
    assert.match(capture.html, /id="track-status-filter"/);
    assert.match(capture.html, /id="track-album-filter"/);
    assert.match(capture.html, /data-status="ready"/);
    assert.match(capture.html, /data-album="unassigned"/);
    assert.match(capture.html, /data-copy-id="global-0"/);
    assert.match(capture.html, /Previous MediaTracks/);
    assert.match(capture.html, /Next MediaTracks/);
    assert.doesNotMatch(capture.html, /My MediaTracks/);
});

test('admin composition inventory APIs paginate global records without viewer personalization', async () => {
    const originalCarouselFetchAll = Carousel.fetchAll;
    const originalCollectionFetchAll = ContentCollection.fetchAll;
    const calls: Record<string, unknown[]> = {};
    (Carousel as any).fetchAll = async (...args: unknown[]) => {
        calls.carousels = args;
        return [{ _id: 'cross-owner-carousel', createdBy: 'legacy-owner' }];
    };
    (ContentCollection as any).fetchAll = async (...args: unknown[]) => {
        calls.collections = args;
        return [{ _id: 'cross-owner-collection', createdBy: 'legacy-owner' }];
    };
    const capture = () => {
        const result: { body?: any } = {};
        const response = {
            status() { return response; },
            json(body: unknown) { result.body = body; return response; }
        } as unknown as Response;
        return { result, response };
    };

    try {
        const carouselResponse = capture();
        await listCarousels(
            adminRequest({ limit: '25.9', offset: '50.8' }),
            carouselResponse.response,
            (() => undefined) as NextFunction
        );
        const collectionResponse = capture();
        await listContentCollections(
            adminRequest({ limit: '30', offset: '60' }),
            collectionResponse.response,
            (() => undefined) as NextFunction
        );
        assert.deepEqual(calls.carousels, [25, 50]);
        assert.deepEqual(calls.collections, [30, 60]);
        assert.equal(calls.carousels?.length, 2, 'admin recents must not personalize definitions');
        assert.equal(carouselResponse.result.body.carousels[0]._id, 'cross-owner-carousel');
        assert.equal(collectionResponse.result.body.contentCollections[0]._id, 'cross-owner-collection');
    } finally {
        Carousel.fetchAll = originalCarouselFetchAll;
        ContentCollection.fetchAll = originalCollectionFetchAll;
    }
});
