/**
 * The lookup request bodies imports and existing-Album reviews share: a choice is a run and a candidate key (or none); answers are
 * 1 to 305 on an import's lookup value paths, or 1 to 406 on a review's, which also include its expected tracklist and member
 * Artist entries. Anything else is invalid input before any project is read. All identifiers are synthetic.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
// The database module loads first; importing the request module before it trips the index import cycle.
import '../../src/infrastructure/database';
import { AdminImportError } from '../../src/administration/import/adminImportContract';
import { parseLookupAnswers, parseLookupChoice } from '../../src/administration/lookup/metadataLookupRequests';

const slot = '0000000b-0000-4000-a000-000000000001';
const candidateKey = 'musicbrainz:0000000f-0000-4000-8000-000000000001';
const body = (extra: Record<string, unknown> = {}) => ({ operationId: randomUUID(), expectedRevision: 3, run: 1, candidateKey, ...extra });
const invalid = (error: unknown) => error instanceof AdminImportError && error.status === 400 && error.code === 'ADMIN_IMPORT_INVALID_INPUT';
const answer = (path: string, base: unknown = null) => ({ path, answer: 'mine', base });

test('a choice body is exactly a run and a candidate key, or none', () => {
    for (const choice of [body(), body({ candidateKey: null })]) {
        assert.deepEqual(parseLookupChoice(choice), { body: choice, run: 1, candidateKey: choice.candidateKey });
    }
    for (const raw of [body({ run: 0 }), body({ candidateKey: 'release:1' }), { ...body(), extra: true }, (({ candidateKey: _key, ...rest }) => rest)(body()), null]) {
        assert.throws(() => parseLookupChoice(raw), invalid, JSON.stringify(raw)?.slice(0, 80));
    }
});

test('answers take an import\'s value paths up to 305, and a review\'s also on its expected tracklist and member Artist entries up to 406', () => {
    const reviewOnly = [answer('album.expectedTracklist', []), answer(`tracks.${slot}.artists`, [])];
    // An import never answers the review-only paths; a review does, with the paths every project takes.
    assert.throws(() => parseLookupAnswers(body({ answers: [reviewOnly[0]] })), invalid);
    assert.throws(() => parseLookupAnswers(body({ answers: [reviewOnly[1]] })), invalid);
    const parsed = parseLookupAnswers(body({ answers: [answer('album.title', 'Synthetic Album'), ...reviewOnly] }), { review: true });
    assert.deepEqual([parsed.run, parsed.candidateKey, parsed.answers], [1, candidateKey, [answer('album.title', 'Synthetic Album'), ...reviewOnly]]);
    // Bounds: 305 answers for an import and 406 for a review (the manifest check that follows is the caller's).
    const many = (count: number) => Array.from({ length: count }, (_unused, index) => answer(`tracks.slot-${index}.title`, ''));
    assert.equal(parseLookupAnswers(body({ answers: many(305) })).answers.length, 305);
    assert.throws(() => parseLookupAnswers(body({ answers: many(306) })), invalid);
    assert.equal(parseLookupAnswers(body({ answers: many(406) }), { review: true }).answers.length, 406);
    assert.throws(() => parseLookupAnswers(body({ answers: many(407) }), { review: true }), invalid);
    // Neither takes no answer, visibility, a repeated path, another answer kind, a missing base or one nested too deeply.
    for (const answers of [[], [answer('album.visibility', 'hidden')], [answer('album.title'), answer('album.title')], [{ path: 'album.title', answer: 'theirs', base: null }],
        [{ path: 'album.title', answer: 'mine' }], [answer('album.expectedTracklist', [[[{}]]])], 'answers']) {
        assert.throws(() => parseLookupAnswers(body({ answers }), { review: true }), invalid, JSON.stringify(answers).slice(0, 80));
    }
});
