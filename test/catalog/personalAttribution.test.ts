import assert from 'node:assert/strict';
import test from 'node:test';

import { createPersonalAttribution, PersonalAttributionValidationError, readPersonalAttribution } from '../../src/models/personalAttribution';
import { AudioTrack } from '../../src/models/audioTrack';
import { adminCatalogItemRevision } from '../../src/administration/catalog/adminCatalogService';
import { personalDisplayByline, personalPublicationByline } from '../../src/services/catalog/catalogByline';
import { resolvePublicCatalogBylines, toPublicAudioTrack } from '../../src/services/catalog/publicCatalogService';
import { nativeAttributionOutcome } from '../support/nativeDisplayTextValidators';

const ownerId = '6400000000000000000000a1';
const trackId = '6400000000000000000000b1';
const personalTrack = (publicName = '') => ({
    _id: trackId, title: 'Lorem Video', artistIds: [], albumId: null, credits: [],
    attributionStatus: 'unknown', personalAttribution: createPersonalAttribution(ownerId, publicName),
    mediaType: 'video', contentType: 'video/mp4', uploadStatus: 'ready', publicationStatus: 'ready',
    s3Key: `video/${trackId}/6400000000000000000000c1`, createdBy: ownerId,
    email: 'private@example.test', accountName: 'Private Account', avatarUrl: '/private-avatar.jpg'
});

test('personal creation normalizes an explicit signature and requires an authoritative account ID', () => {
    assert.deepEqual(createPersonalAttribution(ownerId.toUpperCase(), '  Lorem Cafe\u0301  '), { ownerId, publicName: 'Lorem Café' });
    assert.deepEqual(createPersonalAttribution(ownerId), { ownerId, publicName: '' });
    for (const [owner, name] of [[undefined, 'Lorem'], ['account-name', 'Lorem'], [ownerId, null],
        [ownerId, 'x'.repeat(201)], [ownerId, 'Lorem\u0000'], [ownerId, 'Lorem\u202E'],
        [ownerId, '\ud800'], [ownerId, '\u0301']] as const) {
        assert.throws(() => createPersonalAttribution(owner, name), PersonalAttributionValidationError);
    }
});

test('tolerant reads never manufacture personal attribution from a missing or invalid account binding', () => {
    for (const value of [null, [], {}, { ownerId }, { publicName: 'Lorem Film' }, { ownerId: 'invalid', publicName: 'Lorem' },
        { ownerId: null, publicName: 'Lorem' }, { publicName: 'x'.repeat(201) }]) assert.equal(readPersonalAttribution(value), null);
    assert.equal(personalDisplayByline({ ...personalTrack('Lorem Film'), personalAttribution: { publicName: 'Lorem Film' } }), null);
});

test('a blank personal signature uses neutral public text without resolving account metadata', () => {
    const owner = personalTrack('  ');
    assert.equal(personalDisplayByline(owner), personalPublicationByline);
    assert.equal(personalPublicationByline, '个人发布');
    assert.equal(personalDisplayByline({ ...owner, personalAttribution: { ownerId, publicName: null, displayName: 'Private Account' } }), null);
    assert.equal(personalDisplayByline({ ...owner, attributionStatus: 'documented' }), null);
    assert.equal(personalDisplayByline({ ...owner, credits: [{ subjectType: 'artist' }] }), null);
});

test('new MediaTrack saves reject personal attribution combined with catalog Credits before persistence', () => {
    for (const fields of [{ credits: [], attributionStatus: 'documented' },
        { credits: [{ subjectType: 'artist' }], attributionStatus: 'unknown' }, { credits: undefined, attributionStatus: 'unknown' }]) {
        const track = Object.assign(Object.create(AudioTrack.prototype), fields, { personalAttribution: createPersonalAttribution(ownerId) }) as AudioTrack;
        assert.throws(() => track.save(), PersonalAttributionValidationError);
    }
});

test('legacy public personal Video DTOs preserve playback and artwork but expose no account association', async () => {
    for (const name of ['', 'Lorem Film']) {
        const owner = { ...personalTrack(name), artistIds: [ownerId] }, dto = toPublicAudioTrack(owner)!;
        assert.equal(dto.displayByline, name || personalPublicationByline);
        assert.deepEqual(dto.credits, []);
        assert.deepEqual(dto.artistIds, []);
        assert.equal(dto.attributionStatus, 'unknown');
        assert.equal(dto.mediaType, 'video');
        assert.equal(dto.streamUrl, `/content/mediaTrack/stream/${trackId}`);
        const wire = JSON.stringify(dto);
        for (const value of ['personalAttribution', 'ownerId', ownerId, 'private@example.test', 'Private Account', 'avatarUrl', 's3Key']) assert.equal(wire.includes(value), false, value);
        const outcome = nativeAttributionOutcome({ artistNames: [], credits: dto.credits, displayByline: dto.displayByline, attributionStatus: dto.attributionStatus });
        assert.deepEqual(outcome, { ios: { decodes: true, byline: dto.displayByline }, android: { decodes: true, byline: dto.displayByline } });
        assert.deepEqual([...await resolvePublicCatalogBylines([owner])], [[trackId, dto.displayByline]]);
        const replaced = toPublicAudioTrack({ ...owner, mediaType: 'audio', contentType: 'audio/mpeg', s3Key: trackId });
        assert.equal(replaced?.displayByline, dto.displayByline);
        assert.equal(replaced?.mediaType, 'audio');
    }
    const album = { _id: '6400000000000000000000d1', coverArtUrl: '/album.jpg' };
    assert.equal(toPublicAudioTrack({ ...personalTrack(), albumId: album._id }, album)?.displayCoverArtUrl, '/album.jpg');
    assert.equal(toPublicAudioTrack({ ...personalTrack(), coverArtId: '6400000000000000000000e1', albumId: album._id }, album)?.displayCoverArtUrl, '/content/images/6400000000000000000000e1');
    assert.equal(toPublicAudioTrack({ ...personalTrack(), publicationStatus: 'pending' }), null);
    assert.equal(toPublicAudioTrack({ ...personalTrack(), visibility: 'hidden' }), null);
});

test('private personal attribution changes invalidate catalog confirmations', () => {
    const owner = personalTrack('Lorem Film');
    const revision = adminCatalogItemRevision('audioTrack', owner);
    assert.notEqual(adminCatalogItemRevision('audioTrack', { ...owner, personalAttribution: { ...owner.personalAttribution, publicName: 'Ipsum Film' } }), revision);
    assert.notEqual(adminCatalogItemRevision('audioTrack', { ...owner, personalAttribution: { publicName: 'Lorem Film' } }), revision);
});
