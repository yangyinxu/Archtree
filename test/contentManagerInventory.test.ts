import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

import {
    renderAudioTracksPageForWeb,
    renderManagePageForWeb
} from '../src/controllers/contentController';
import { listCarousels } from '../src/controllers/pageController';
import { listContentCollections } from '../src/controllers/contentCollectionController';
import { Album } from '../src/models/album';
import { Artist } from '../src/models/artist';
import { AudioTrack } from '../src/models/audioTrack';
import { Carousel } from '../src/models/carousel';
import { ContentCollection } from '../src/models/contentCollection';
import { Page } from '../src/models/page';
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

test('Content Manager loads global inventory pages instead of filtering by createdBy', async () => {
    const originals = {
        artists: Artist.fetchAll,
        albums: Album.fetchAll,
        audioTracks: AudioTrack.fetchAll,
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
    (Album as any).fetchAll = async (limit: number, offset: number) => {
        calls.albums = { limit, offset };
        return [{ _id: 'album-1', title: 'Legacy Global Album', audioTrackIds: [], createdBy: 'legacy-owner' }];
    };
    (AudioTrack as any).fetchAll = async (limit: number, offset: number) => {
        calls.audioTracks = { limit, offset };
        return trackRecords;
    };
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
    let nextError: unknown;
    try {
        await renderManagePageForWeb(
            adminRequest({ artistsPage: '2' }),
            response,
            ((error?: unknown) => { nextError = error; }) as NextFunction
        );
    } finally {
        Artist.fetchAll = originals.artists;
        Album.fetchAll = originals.albums;
        AudioTrack.fetchAll = originals.audioTracks;
        Page.fetchAll = originals.pages;
        Carousel.fetchAll = originals.carousels;
        ContentCollection.fetchAll = originals.contentCollections;
        console.log = originalConsoleLog;
        if (previousBucket === undefined) delete process.env.S3_BUCKET_NAME;
        else process.env.S3_BUCKET_NAME = previousBucket;
    }

    assert.equal(nextError, undefined);
    assert.equal(capture.statusCode, 200);
    assert.deepEqual(calls.artists, {
        limit: managementInventoryPageSize + 1,
        offset: managementInventoryPageSize
    });
    for (const key of ['albums', 'audioTracks', 'pages', 'carousels', 'contentCollections']) {
        assert.deepEqual(calls[key], { limit: managementInventoryPageSize + 1, offset: 0 });
    }
    assert.match(capture.html, /Catalog Content/);
    assert.match(capture.html, /Legacy Global Artist/);
    assert.match(capture.html, /Legacy Global Album/);
    assert.match(capture.html, /Legacy Global Track/);
    assert.match(capture.html, /Global Home/);
    assert.match(capture.html, /Legacy Global Carousel/);
    assert.match(capture.html, /Legacy Global Grid/);
    assert.match(capture.html, /Previous Artists/);
    assert.match(capture.html, /Next Audio Tracks/);
    assert.doesNotMatch(capture.html, /My Content|My Artists|My Albums|My Carousels|My Audio Tracks/);
});

test('Audio Track inventory uses the global page and global administrator copy', async () => {
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
    assert.match(capture.html, /<h1[^>]*>Audio Tracks<\/h1>/);
    assert.match(capture.html, /Global catalog/);
    assert.match(capture.html, /Cross-owner Track/);
    assert.match(capture.html, /Previous Audio Tracks/);
    assert.match(capture.html, /Next Audio Tracks/);
    assert.doesNotMatch(capture.html, /My Audio Tracks/);
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
