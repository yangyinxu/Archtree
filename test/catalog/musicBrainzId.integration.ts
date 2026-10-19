/**
 * Only the admin catalog editor and import publication write a MusicBrainz ID: the Artist and Organization model updates that
 * legacy content routes and the Content Manager use drop it, so neither a stored ID nor a new one changes through them. All names,
 * IDs and accounts are synthetic.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { ObjectId } from 'mongodb';
import { createApp } from '../../src/app';
import { getDb } from '../../src/infrastructure/database';
import { Artist } from '../../src/models/artist';
import { Organization } from '../../src/models/organization';
import { createSession } from '../../src/services/auth/authSessionService';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from '../support/mongoReplicaSet';

const stored = '00000000-0000-4000-8000-0000000000b1', attempted = '00000000-0000-4000-8000-0000000000b2';
const artist = new ObjectId(), organization = new ObjectId(), admin = new ObjectId();
let harness: MongoReplicaSetHarness, server: Server, base = '', token = '';
const db = () => getDb()!;

before(async () => {
    harness = await startMongoReplicaSet('archtree-musicbrainz-model-test');
    server = await new Promise(resolve => { const active = createApp().listen(0, '127.0.0.1', () => resolve(active)); });
    const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
    for (const name of ['users', 'authSessions', 'artists', 'organizations']) await db().collection(name).deleteMany({});
    const user = { _id: admin, role: 'admin', emailVerified: true, email: 'musicbrainz-admin@example.test' };
    await db().collection('users').insertOne(user); token = (await createSession(user)).accessToken;
    await db().collection('artists').insertOne({ _id: artist, name: 'Model Artist', bio: '', albumIds: [], lifecycleStatus: 'ready', musicBrainzId: stored });
    await db().collection('organizations').insertOne({ _id: organization, name: 'Model Label', organizationType: 'label', description: '', lifecycleStatus: 'ready', musicBrainzId: stored });
});
after(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); await harness?.stop(); });

test('Artist and Organization model updates never write a MusicBrainz ID, while other fields still change', async () => {
    await Artist.updateById(artist.toHexString(), { name: 'Renamed Artist', musicBrainzId: attempted, 'musicBrainzId.extra': 1 });
    await Artist.updateCoverArtById(artist.toHexString(), null, { coverArtUrl: '/artist.jpg', musicBrainzId: attempted });
    await Organization.updateById(organization.toHexString(), { name: 'Renamed Label', musicBrainzId: attempted });
    const [savedArtist, savedOrganization] = [await db().collection('artists').findOne({ _id: artist }), await db().collection('organizations').findOne({ _id: organization })];
    assert.deepEqual([savedArtist!.name, savedArtist!.coverArtUrl, savedArtist!.musicBrainzId], ['Renamed Artist', '/artist.jpg', stored]);
    assert.deepEqual([savedOrganization!.name, savedOrganization!.musicBrainzId], ['Renamed Label', stored]);
    // An Artist without an ID gains none through the model either.
    const plain = new ObjectId();
    await db().collection('artists').insertOne({ _id: plain, name: 'Plain Artist', albumIds: [], lifecycleStatus: 'ready' });
    await Artist.updateById(plain.toHexString(), { musicBrainzId: attempted });
    assert.equal('musicBrainzId' in (await db().collection('artists').findOne({ _id: plain }))!, false);
});

test('the legacy Artist update route cannot set a MusicBrainz ID', async () => {
    const form = new FormData(); form.set('name', 'Legacy Renamed'); form.set('musicBrainzId', attempted);
    const response = await fetch(`${base}/content/artist/${artist.toHexString()}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(response.status, 200, await response.text());
    const json = await fetch(`${base}/content/artist/${artist.toHexString()}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio: 'Legacy bio', musicBrainzId: attempted }) });
    assert.ok(json.status < 500, String(json.status));
    const saved = await db().collection('artists').findOne({ _id: artist });
    assert.deepEqual([saved!.name, saved!.musicBrainzId], ['Legacy Renamed', stored]);
});

test('the Content Manager Artist and Organization forms cannot set or clear a MusicBrainz ID', async () => {
    const manage = (path: string, body: URLSearchParams | FormData) => fetch(`${base}/content/manage${path}`, { method: 'POST', redirect: 'manual',
        headers: { Authorization: `Bearer ${token}`, ...(body instanceof URLSearchParams ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body });
    const metadata = await manage('/artist/update-metadata', new URLSearchParams({ artistId: artist.toHexString(), name: 'Managed Artist', bio: 'Managed bio', birthDate: '', musicBrainzId: attempted }));
    assert.equal(metadata.status, 302);
    assert.match(metadata.headers.get('location') ?? '', /Artist%20details%20updated%20successfully/);
    const label = await manage('/organization/update', new URLSearchParams({ organizationId: organization.toHexString(), name: 'Managed Label', organizationType: 'label', description: '', musicBrainzId: '' }));
    assert.equal(label.status, 302);
    assert.match(label.headers.get('location') ?? '', /Organization%20updated%20successfully/);
    // The multipart Artist form (the one that may also replace cover art) drops the field as well.
    const form = new FormData(); form.set('artistId', artist.toHexString()); form.set('name', 'Managed Again'); form.set('musicBrainzId', attempted);
    const multipart = await manage('/artist/update', form);
    assert.equal(multipart.status, 302);
    assert.match(multipart.headers.get('location') ?? '', /Artist%20updated%20successfully/);
    const [savedArtist, savedOrganization] = [await db().collection('artists').findOne({ _id: artist }), await db().collection('organizations').findOne({ _id: organization })];
    assert.deepEqual([savedArtist!.name, savedArtist!.bio, savedArtist!.musicBrainzId], ['Managed Again', 'Managed bio', stored]);
    assert.deepEqual([savedOrganization!.name, savedOrganization!.musicBrainzId], ['Managed Label', stored]);
});
