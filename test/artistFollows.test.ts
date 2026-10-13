import assert from 'node:assert/strict';
import test from 'node:test';
import { isArtistFollowEnabled, supportsArtistFollowHome } from '../src/config/artistFollowRollout';
import { canonicalFollowArtistId } from '../src/services/artistFollowService';
import { followedReleaseWindow } from '../src/services/followedArtistReleasesService';
import { toPublicCarousel, toPublicExpandedPage } from '../src/services/publicPageService';

const id = '0000000000000000000000ab';
const reason = { code: 'followedArtist', artist: { id, name: 'Synthetic Artist', privateOwner: 'never returned' }, rawScore: 900 };
const visibility = { albumIds: new Set([id]), audioTrackIds: new Set<string>(), postIds: new Set<string>() };

test('Follow defaults off independently and negotiates only the exact version string', () => {
    for (const NODE_ENV of ['production', 'develop', 'test']) {
        assert.equal(isArtistFollowEnabled({ NODE_ENV }), false);
        assert.equal(isArtistFollowEnabled({ NODE_ENV, FINITUDE_SOCIAL_ENABLED: 'true', FINITUDE_PLAYLISTS_ENABLED: 'true' }), false);
    }
    assert.equal(isArtistFollowEnabled({ FINITUDE_ARTIST_FOLLOWS_ENABLED: ' TRUE ' }), true);
    for (const value of [undefined, null, 1, ['1'], '01', '1, 1', ' 1 ', '2']) assert.equal(supportsArtistFollowHome(value), false);
    assert.equal(supportsArtistFollowHome('1'), true);
    assert.equal(canonicalFollowArtistId(id.toUpperCase()), id);
    for (const value of ['', ` ${id}`, 123, {}, ['0000000000000000000000ab']]) assert.equal(canonicalFollowArtistId(value), null);
});

test('UTC calendar window is unchanged by time of day and spans leap day', () => {
    const first = followedReleaseWindow(new Date('2024-03-01T00:00:00Z'));
    assert.deepEqual(first, followedReleaseWindow(new Date('2024-03-01T23:59:59Z')));
    assert.equal(first.start.toISOString(), '2023-12-03T00:00:00.000Z');
    assert.equal(first.end.getTime() - first.start.getTime(), 89 * 86_400_000);
});

test('only generated Carousel item context permits allowlisted reasons and empty sections disappear', () => {
    const base = { _id: id, name: 'Followed', items: [{ contentType: 'album', contentId: id, order: 0, reason }] };
    const manual = toPublicCarousel({ ...base, mode: 'manual' }, visibility);
    assert.equal(JSON.stringify(manual).includes('reason'), false);
    const generated = { ...base, mode: 'personalized', personalizedConfig: { source: 'followedArtistReleases', limit: 12 } };
    assert.deepEqual((toPublicCarousel(generated, visibility).items as any[])[0].reason, { code: 'followedArtist', artist: { id, name: 'Synthetic Artist' } });
    const page = { slug: 'home', title: 'Home', items: [{ itemId: id, itemType: 'carousel', carouselId: id, order: 0 }] };
    assert.deepEqual(toPublicExpandedPage(page, [{ ...generated, items: [] }], [], visibility).items, []);
    assert.equal(toPublicExpandedPage(page, [{ ...base, mode: 'manual', items: [] }], [], visibility).items.length, 1);
});

test('generated projection omits missing or malformed reasons and canonicalizes public reason identities', () => {
    const base = { _id: id, name: 'Followed', mode: 'personalized', personalizedConfig: { source: 'followedArtistReleases', limit: 12 } };
    const page = { slug: 'home', title: 'Home', items: [{ itemId: id, itemType: 'carousel', carouselId: id, order: 0 }] };
    for (const invalidReason of [undefined, { code: 'unknown', artist: { id, name: 'Artist' } }, { code: 'followedArtist', artist: { id, name: ' ' } }, { code: 'followedArtist', artist: { id: [id], name: 'Artist' } }, { code: 'followedArtist', artist: { id: 'invalid', name: 'Artist' } }]) {
        const carousel = { ...base, items: [{ contentType: 'album', contentId: id, order: 0, reason: invalidReason }] };
        assert.deepEqual(toPublicCarousel(carousel, visibility).items, []);
        assert.deepEqual(toPublicExpandedPage(page, [carousel], [], visibility).items, []);
    }
    const normalized = toPublicCarousel({ ...base, items: [{ contentType: 'album', contentId: id, order: 0,
        reason: { code: 'followedArtist', artist: { id: ` ${id.toUpperCase()} `, name: ' Artist ' } }
    }] }, visibility).items as any[];
    assert.deepEqual(normalized[0].reason, { code: 'followedArtist', artist: { id, name: 'Artist' } });
});
