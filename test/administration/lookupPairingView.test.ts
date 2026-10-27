/**
 * The hand-pairing read of a review's lookup candidate without a database (lookupPairingView.ts): the release's rows, each member's
 * saved title, duration and numbers with the rows it may take, closest first, the row every maximum pairing gives it, and the
 * refusals. All names and identifiers are synthetic; the release has a live Album's two discs of stored lengths.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
// The database module loads first; importing adminImportService before it trips the index import cycle.
import '../../src/infrastructure/database';
import { AdminImportError } from '../../src/administration/import/adminImportContract';
import { originKey } from '../../src/administration/import/adminImportDraft';
import type { MusicBrainzRelease } from '../../src/administration/lookup/lookupContract';
import { catalogReviewPairingView } from '../../src/administration/lookup/lookupPairingView';
import type { MetadataLookupRecord } from '../../src/administration/lookup/metadataLookupRecord';
import { reviewLookupDocument, reviewSlot, storedCandidate, syntheticMbid, syntheticRelease, type ReviewMemberFixture } from '../support/catalogReviewLookupFixtures';

const discOne = [215_640, 382_746, 278_173, 202_400, 284_973, 204_600, 157_253, 310_013, 247_120, 329_720, 422_266, 571_720];
const discTwo = [234_773, 214_946, 338_160, 243_306, 232_066, 675_160, 349_880, 336_946];
const releaseId = syntheticMbid(77);
const live = (media = [discOne, discTwo].map(lengths => ({ tracks: lengths.map(lengthMs => ({ lengthMs })) }))) => syntheticRelease(releaseId, media, { title: 'Synthetic Live' });
const key = `musicbrainz:${releaseId}`;
const members = (first: Partial<ReviewMemberFixture> = {}): ReviewMemberFixture[] => [
    { durationMs: 215_659, title: 'Synthetic opening (Live)', ...first }, { durationMs: 382_752, title: 'Synthetic second song (Live)' }];
const record = (release: MusicBrainzRelease, extra: Partial<MetadataLookupRecord> = {}) =>
    ({ run: 3, state: 'complete', candidates: [storedCandidate(release)], ...extra }) as unknown as MetadataLookupRecord;
const refused = (status: number, code: string) => (error: unknown) => error instanceof AdminImportError && error.status === status && error.code === code;

test('the pairing read lists the release\'s rows and each member\'s saved title, duration, numbers and tracks within the tolerance, with no identifier but the key it was asked for', () => {
    const view = catalogReviewPairingView(reviewLookupDocument({ members: members() }), record(live()), key);
    assert.deepEqual(view, {
        run: 3, revision: 2,
        rows: [...discOne.map((durationMs, index) => ({ disc: 1, track: index + 1, title: `Synthetic Track ${index + 1}`, durationMs })),
            ...discTwo.map((durationMs, index) => ({ disc: 2, track: index + 1, title: `Synthetic Track ${index + 1}`, durationMs }))],
        members: [
            { slotId: reviewSlot(0), title: 'Synthetic opening (Live)', durationMs: 215_659, saved: { disc: null, track: null }, discSavable: true,
                options: [{ disc: 1, track: 1, deltaMs: 19 }, { disc: 2, track: 2, deltaMs: 713 }], forced: null },
            { slotId: reviewSlot(1), title: 'Synthetic second song (Live)', durationMs: 382_752, saved: { disc: null, track: null }, discSavable: true,
                options: [{ disc: 1, track: 2, deltaMs: 6 }], forced: { disc: 1, track: 2 } }
        ]
    });
    const text = JSON.stringify(view);
    for (const id of [releaseId, syntheticMbid(1), ...Array.from({ length: 12 }, (_unused, index) => syntheticMbid(900 + index))]) assert.ok(!text.includes(id), id);
});

test('a saved own number constrains the options while a number lookup wrote does not, and both show as saved', () => {
    const own = catalogReviewPairingView(reviewLookupDocument({ members: members({ trackNumber: 2 }) }), record(live()), key);
    assert.deepEqual(own.members[0], { slotId: reviewSlot(0), title: 'Synthetic opening (Live)', durationMs: 215_659, saved: { disc: null, track: 2 }, discSavable: true,
        options: [{ disc: 2, track: 2, deltaMs: 713 }], forced: { disc: 2, track: 2 } });
    const written = catalogReviewPairingView(reviewLookupDocument({ members: members({ trackNumber: 2 }),
        origins: { [originKey(`tracks.${reviewSlot(0)}.trackNumber`)]: 'automatic' } }), record(live()), key);
    assert.deepEqual(written.members[0].options, [{ disc: 1, track: 1, deltaMs: 19 }, { disc: 2, track: 2, deltaMs: 713 }]);
    assert.deepEqual([written.members[0].saved, written.members[0].forced], [{ disc: null, track: 2 }, null]);
});

test('a member without a captured duration may take every row', () => {
    const view = catalogReviewPairingView(reviewLookupDocument({ members: members({ durationMs: null }) }), record(live()), key);
    assert.equal(view.members[0].durationMs, null);
    assert.deepEqual(view.members[0].options, view.rows.map(row => ({ disc: row.disc, track: row.track, deltaMs: null })));
    assert.equal(view.members[0].options.length, 20);
});

test('a member of a review captured before Disc Numbers were captured cannot save one, while its options and the other members stay as they are', () => {
    const doc = reviewLookupDocument({ members: members() }), source = doc.catalogSource as { tracks: Record<string, unknown>[] };
    delete source.tracks[0].discNumber;
    const view = catalogReviewPairingView(doc, record(live()), key);
    assert.deepEqual(view.members.map(member => member.discSavable), [false, true]);
    assert.deepEqual(view.members[0].options, [{ disc: 1, track: 1, deltaMs: 19 }, { disc: 2, track: 2, deltaMs: 713 }]);
});

test('the pairing read refuses another format, a run without the candidate and a candidate whose rows cannot be read', () => {
    const doc = reviewLookupDocument({ members: members() }), notFound = refused(404, 'ADMIN_CATALOG_REVIEW_NOT_FOUND');
    assert.throws(() => catalogReviewPairingView({ ...doc, draftVersion: 2 }, record(live()), key), notFound);
    assert.throws(() => catalogReviewPairingView(doc, null, key), notFound);
    assert.throws(() => catalogReviewPairingView(doc, record(live(), { state: 'running' }), key), notFound);
    assert.throws(() => catalogReviewPairingView(doc, record(live()), `musicbrainz:${syntheticMbid(78)}`), notFound);
    assert.throws(() => catalogReviewPairingView(doc, record(live(), { candidates: undefined }), key), notFound, 'a projection that found no such candidate');
    const incomplete = refused(409, 'ADMIN_IMPORT_LOOKUP_CANDIDATE_INCOMPLETE');
    assert.throws(() => catalogReviewPairingView(doc, record(live(), { candidates: [storedCandidate(live(), 'failed')] }), key), incomplete);
    const merged = storedCandidate(live());
    assert.throws(() => catalogReviewPairingView(doc, record(live(), { candidates: [{ ...merged, release: { ...merged.release!, releaseId: syntheticMbid(79) } }] }), key), incomplete);
    assert.throws(() => catalogReviewPairingView(doc, record(live([{ format: 'DVD-Video', tracks: [{ lengthMs: 215_640 }, { lengthMs: 382_746 }] }])), key), incomplete);
    assert.throws(() => catalogReviewPairingView(doc, record(live([{ tracks: Array.from({ length: 150 }, () => ({ lengthMs: 200_000 })) }])), key), incomplete);
});
