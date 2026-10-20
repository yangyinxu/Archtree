/**
 * Pins the Content Manager upload Credit proposal without a database. Inherited Album primary
 * Credits keep their order and keep a join phrase only while the next Album Credit is inherited
 * too (owner-approved default), so the composed byline never joins a selected Credit with an
 * Album phrase.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { proposedSoundtrackCredits } from '../../src/controllers/contentManager/mediaController';
import { migratedCatalogCreditId, normalizeCatalogCredits } from '../../src/models/catalogCredit';
import { composeCatalogByline, toBylineCredit } from '../../src/services/catalog/catalogByline';

const trackId = '64b0000000000000000000a1';
const primaryId = '64b0000000000000000000a2';
const secondId = '64b0000000000000000000a3';
const featuredId = '64b0000000000000000000a4';
const performerId = '64b0000000000000000000a5';
const labelId = '64b0000000000000000000a6';
const names = new Map([
    [primaryId, 'Primary'],
    [secondId, 'Featured'],
    [featuredId, 'Third'],
    [performerId, 'Performer'],
    [labelId, 'Release House']
]);
const album = {
    credits: normalizeCatalogCredits([
        { creditId: 'album_primary', subjectType: 'artist', subjectId: primaryId, role: 'primary', joinPhrase: ' & ' },
        { creditId: 'album_second', subjectType: 'artist', subjectId: secondId, role: 'primary', joinPhrase: ' feat. ' },
        { creditId: 'album_featured', subjectType: 'artist', subjectId: featuredId, role: 'featured' }
    ])
};

test('an upload inherits Album primary phrases, clears the last one, and appends the selections', () => {
    const credits = proposedSoundtrackCredits(trackId, album, performerId, 'performer', true, labelId, 'label');
    assert.deepEqual(credits.map((credit) => [credit.subjectId, credit.role, credit.order, credit.joinPhrase]), [
        [primaryId, 'primary', 0, ' & '],
        [secondId, 'primary', 1, undefined],
        [performerId, 'performer', 2, undefined],
        [labelId, 'label', 3, undefined]
    ]);
    assert.deepEqual(credits.map((credit) => 'joinPhrase' in credit), [true, false, false, false]);
    assert.equal(credits[0].creditId, migratedCatalogCreditId('audioTrack', trackId, 'artist', primaryId, 'primary'));
    assert.equal(
        composeCatalogByline(credits.map((credit) => toBylineCredit(credit, names.get(credit.subjectId) ?? ''))),
        'Primary & Featured, Performer'
    );
});

test('an upload without inheritance copies no Album phrase and skips an already inherited selection', () => {
    const independent = proposedSoundtrackCredits(trackId, album, performerId, 'performer', false);
    assert.deepEqual(independent.map((credit) => [credit.subjectId, credit.role, credit.joinPhrase]), [
        [performerId, 'performer', undefined]
    ]);
    const repeated = proposedSoundtrackCredits(trackId, album, primaryId, 'primary', true);
    assert.deepEqual(repeated.map((credit) => [credit.subjectId, credit.role, credit.joinPhrase]), [
        [primaryId, 'primary', ' & '],
        [secondId, 'primary', undefined]
    ]);
    assert.deepEqual(proposedSoundtrackCredits(trackId, null, '', 'primary', true), []);
});
