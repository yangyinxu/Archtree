import assert from 'node:assert/strict';
import test from 'node:test';

import audioRoutes from '../src/routes/content/audioRoutes';
import catalogRoutes from '../src/routes/content/catalogRoutes';
import compositionRoutes from '../src/routes/content/compositionRoutes';
import contentManagerRoutes from '../src/routes/content/contentManagerRoutes';
import feedRoutes from '../src/routes/feedRoutes';
import adminRoutes from '../src/routes/adminRoutes';

interface RouteLayer {
    name: string;
    route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ name: string }>;
    };
}

interface InspectableRouter {
    stack: RouteLayer[];
}

const stackFor = (router: unknown) => (router as InspectableRouter).stack;

const routeFor = (router: unknown, method: string, path: string) => {
    const layer = stackFor(router).find((candidate) =>
        candidate.route?.path === path && candidate.route.methods[method.toLowerCase()]
    );
    assert.ok(layer?.route, `missing ${method.toUpperCase()} ${path}`);
    return layer.route;
};

const handlerNames = (router: unknown, method: string, path: string) =>
    routeFor(router, method, path).stack.map((layer) => layer.name);

const assertAdminRoute = (router: unknown, method: string, path: string) => {
    assert.deepEqual(
        handlerNames(router, method, path).slice(0, 2),
        ['requireAuth', 'requireAdmin'],
        `${method.toUpperCase()} ${path} must authenticate and authorize before other work`
    );
};

test('Content Manager applies its Web admin guards before every route handler', () => {
    const stack = stackFor(contentManagerRoutes);
    const firstRouteIndex = stack.findIndex((layer) => Boolean(layer.route));
    assert.ok(firstRouteIndex >= 2);
    assert.deepEqual(
        stack.slice(0, firstRouteIndex).map((layer) => layer.name),
        ['requireAuthForWeb', 'requireAdminForWeb']
    );
    assert.equal(
        stack
            .slice(firstRouteIndex)
            .flatMap((layer) => layer.route?.stack ?? [])
            .some((layer) => layer.name === 'requireAuthForWeb'),
        false,
        'route-level auth would run too late for the router-wide upload boundary'
    );
});

test('catalog and audio mutations authorize admins before upload middleware', () => {
    for (const [method, path] of [
        ['post', '/album'],
        ['put', '/album/:albumId'],
        ['delete', '/album/:albumId'],
        ['post', '/artist'],
        ['put', '/artist/:artistId'],
        ['delete', '/artist/:artistId']
    ]) {
        assertAdminRoute(catalogRoutes, method, path);
    }
    for (const [method, path] of [
        ['post', '/audioTrack'],
        ['put', '/audioTrack/:audioTrackId'],
        ['post', '/audioTrack/:audioTrackId/upload'],
        ['delete', '/audioTrack/:audioTrackId']
    ]) {
        assertAdminRoute(audioRoutes, method, path);
    }

    assert.equal(handlerNames(catalogRoutes, 'get', '/albums').includes('requireAdmin'), false);
    assert.deepEqual(
        handlerNames(audioRoutes, 'get', '/audioTrack/download/:audioTrackId').slice(0, 1),
        ['requireAuth'],
        'ordinary users retain authenticated downloads'
    );
    assert.equal(
        handlerNames(audioRoutes, 'get', '/audioTrack/download/:audioTrackId').includes('requireAdmin'),
        false
    );
});

test('composition management reads and every shared-content mutation require admins', () => {
    for (const [method, path] of [
        ['post', '/pages'],
        ['post', '/pages/:slug/items/carousel'],
        ['delete', '/pages/:slug/items/carousel/:carouselId'],
        ['post', '/pages/:slug/items/reorder'],
        ['post', '/pages/:slug/items/collection'],
        ['delete', '/pages/:slug/items/collection/:collectionId'],
        ['get', '/carousels'],
        ['post', '/carousels'],
        ['put', '/carousels/:carouselId/artist-config'],
        ['put', '/carousels/:carouselId/personalized-config'],
        ['patch', '/carousels/:carouselId/name'],
        ['post', '/carousels/:carouselId/items'],
        ['post', '/carousels/:carouselId/items/reorder'],
        ['post', '/carousels/:sourceCarouselId/items/move'],
        ['delete', '/carousels/:carouselId'],
        ['get', '/content-collections'],
        ['post', '/content-collections'],
        ['post', '/content-collections/:collectionId/items'],
        ['post', '/content-collections/:collectionId/items/reorder'],
        ['delete', '/content-collections/:collectionId']
    ]) {
        assertAdminRoute(compositionRoutes, method, path);
    }

    assert.equal(handlerNames(compositionRoutes, 'get', '/pages').includes('requireAdmin'), false);
    assert.equal(
        handlerNames(compositionRoutes, 'get', '/pages/:slug(library)/expanded').includes('requireAdmin'),
        false,
        'the personal library projection remains available to ordinary users'
    );
});

test('feed reads stay public while post mutations require admins', () => {
    assertAdminRoute(feedRoutes, 'post', '/post');
    assertAdminRoute(feedRoutes, 'delete', '/post');
    assert.equal(handlerNames(feedRoutes, 'get', '/post').includes('requireAdmin'), false);
    assert.equal(handlerNames(feedRoutes, 'get', '/posts').includes('requireAdmin'), false);
});

test('audio publication recovery is an explicitly guarded admin mutation', () => {
    assertAdminRoute(adminRoutes, 'post', '/audio-storage/publication-retry');
});
