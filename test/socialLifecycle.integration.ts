import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { MongoServerError, ObjectId } from 'mongodb';
import { createSocialService } from '../src/application/social/socialService';
import {
    SOCIAL_LIMITS, SocialError, type SocialActor, type SocialApi,
    type SocialCommand, type SocialScope
} from '../src/contracts/socialV1';
import { getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import type { SocialReceiptDocument, SocialRelationshipDocument } from '../src/repositories/social/socialDocuments';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let now = Date.now();
let service: SocialApi;
const secret = 'synthetic-social-integration-signing-secret';
const collections = ['users', 'authSessions', 'socialProfiles', 'socialRelationships',
    'socialMutations', 'socialOutbox', 'socialBudgets', 'socialHandles'];

before(async () => { harness = await startMongoReplicaSet('archtree-social-lifecycle-test'); });
beforeEach(async () => {
    now = Date.now();
    await Promise.all(collections.map(name => getDb()!.collection(name).deleteMany({})));
    service = createSocialService({ now: () => now, enabled: () => true, secret: () => secret });
});
after(async () => { await harness?.stop(); });

/** Synthetic account data deliberately contains private fields absent from social DTOs. */
const actor = async (name: string): Promise<SocialActor> => {
    const userId = new ObjectId();
    await getDb()!.collection('users').insertOne({
        _id: userId, email: `${name}@private.invalid`, username: `private-${name}`,
        role: 'user', password: 'synthetic-unused-password-hash',
        avatarAssetId: 'private-avatar-asset', avatarUrl: 'https://private.invalid/avatar'
    });
    const sessionId = await AuthSession.create(userId.toHexString(), `synthetic-refresh-hash-${randomUUID()}`,
        new Date(now + 7 * SOCIAL_LIMITS.scopeMs));
    return { userId: userId.toHexString(), sessionId };
};

type CommandBody = SocialCommand extends infer C ? C extends SocialCommand
    ? Omit<C, 'scopeToken' | 'commandId'> : never : never;
const command = (scope: SocialScope, body: CommandBody): SocialCommand => ({
    ...body, scopeToken: scope.scopeToken, commandId: randomUUID()
}) as SocialCommand;
const mutationIdentity = (value: SocialCommand) => ({ scopeToken: value.scopeToken, commandId: value.commandId });

/** Seed retained status receipts to exercise storage caps without a thousand network mutations. */
const fillReceiptCount = async (identity: SocialActor, count: number) => {
    const receipts = getDb()!.collection<SocialReceiptDocument>('socialMutations');
    const template = (await receipts.findOne({ accountId: identity.userId }))!;
    assert.ok(template);
    const present = await receipts.countDocuments({ accountId: identity.userId });
    assert.ok(count >= present);
    const rows = Array.from({ length: count - present }, () => {
        const commandId = randomUUID();
        return { ...template, _id: `synthetic-receipt-${randomUUID()}`, commandId,
            result: { ...template.result, commandId } };
    });
    if (rows.length) await receipts.insertMany(rows);
    return template;
};

const member = async (name: string, discoverable = true) => {
    const identity = await actor(name);
    const scope = await service.issueScope(identity);
    const result = await service.mutate(identity, command(scope, {
        action: 'profile', expectedRevision: 0, handle: name, alias: `Alias ${name}`, discoverable
    }));
    assert.equal(result.outcome, 'applied');
    const profile = await service.ownProfile(identity);
    assert.ok(profile);
    return { actor: identity, scope, profile };
};
type Member = Awaited<ReturnType<typeof member>>;

const request = (from: Member, to: Member, expectedRevision = 0) =>
    service.mutate(from.actor, command(from.scope, {
        action: 'request', targetSocialId: to.profile.socialId, expectedRevision
    }));

const friendship = async (a: Member, b: Member) => {
    assert.equal((await request(a, b)).outcome, 'applied');
    const incoming = await service.list(b.actor, 'incoming', 20);
    assert.equal(incoming.items.length, 1);
    const result = await service.mutate(b.actor, command(b.scope, {
        action: 'accept', targetSocialId: a.profile.socialId,
        expectedRevision: incoming.items[0].revision
    }));
    assert.equal(result.outcome, 'applied');
};

/** Public responses must not leak a private identity through any nested projection. */
const assertPublic = (response: unknown, actors: SocialActor[]) => {
    const json = JSON.stringify(response);
    for (const identity of actors) {
        assert.equal(json.includes(identity.userId), false);
        assert.equal(json.includes(identity.sessionId), false);
    }
    for (const privateValue of ['@private.invalid', 'private-avatar', 'private.invalid/avatar',
        'synthetic-refresh-hash', 'synthetic-unused-password-hash', 'accountId', 'requestedBy', 'blockedBy']) {
        assert.equal(json.includes(privateValue), false, `Private value appeared: ${privateValue}`);
    }
};

const assertSocialError = (statusCode?: number) => (error: unknown) =>
    error instanceof SocialError && (statusCode === undefined || error.statusCode === statusCode);

/** A bounded gate forces a transaction ordering without timing-dependent sleeps. */
const gate = () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    return { enter, release, entered, released };
};

test('profile creation is opt-in, revisioned, immutable-handle, and allowlisted', async () => {
    const alice = await actor('alice');
    assert.equal(await service.ownProfile(alice), null);
    const scope = await service.issueScope(alice);
    const create = command(scope, { action: 'profile', expectedRevision: 0,
        handle: 'Alice', alias: '  Alice public  ', discoverable: false });
    assert.equal((await service.mutate(alice, create)).outcome, 'applied');
    const profile = (await service.ownProfile(alice))!;
    assert.equal(profile.handle, 'alice');
    assert.equal(profile.alias, 'Alice public');
    assert.equal(profile.active, true);
    assert.equal(profile.discoverable, false);
    assert.equal(profile.revision, 1);
    assert.deepEqual(Object.keys(profile).sort(),
        ['active', 'alias', 'discoverable', 'handle', 'iconSeed', 'revision', 'socialId']);
    assertPublic(profile, [alice]);
    assert.equal((await service.mutate(alice, command(scope, { action: 'profile',
        expectedRevision: 0, handle: 'alice', alias: 'Stale', discoverable: false
    }))).outcome, 'rejected');
    const changedHandle = await service.mutate(alice, command(scope, {
        action: 'profile', expectedRevision: 1, handle: 'renamed', alias: 'Renamed', discoverable: true
    }));
    assert.equal(changedHandle.code, 'handle_immutable');
    const bob = await member('bobby');
    assert.equal(await service.lookup(bob.actor, 'alice'), null);
    assert.equal((await service.mutate(alice, command(scope, {
        action: 'profile', expectedRevision: 1, handle: 'alice', alias: 'Visible', discoverable: true
    }))).outcome, 'applied');
    const found = await service.lookup(bob.actor, 'ALICE');
    assert.equal(found?.socialId, profile.socialId);
    assert.deepEqual(Object.keys(found!).sort(), ['alias', 'handle', 'iconSeed', 'socialId']);
    assertPublic(found, [alice, bob.actor]);
});

test('one handle cannot be claimed by two different accounts under concurrency', async () => {
    const identities = await Promise.all([actor('alice'), actor('bobby')]);
    const scopes = await Promise.all(identities.map(identity => service.issueScope(identity)));
    const results = await Promise.all(identities.map((identity, index) => service.mutate(identity,
        command(scopes[index], { action: 'profile', expectedRevision: 0, handle: 'shared',
            alias: `Alias ${index}`, discoverable: true }))));
    assert.equal(results.filter(result => result.outcome === 'applied').length, 1);
    assert.equal(results.filter(result => result.code === 'handle_unavailable').length, 1);
    assert.equal(await getDb()!.collection('socialProfiles').countDocuments({ handle: 'shared' }), 1);
});

test('requests require recipient acceptance and removing friendship invalidates stale actions', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await friendship(alice, bob);
    const friends = await service.list(alice.actor, 'friends', 20);
    assert.equal(friends.items[0].socialId, bob.profile.socialId);
    assert.equal((await service.list(bob.actor, 'friends', 20)).items[0].socialId, alice.profile.socialId);
    assert.equal((await service.list(alice.actor, 'outgoing', 20)).items.length, 0);
    assert.equal((await service.list(bob.actor, 'incoming', 20)).items.length, 0);
    assertPublic(friends, [alice.actor, bob.actor]);
    const revision = friends.items[0].revision;
    assert.equal((await service.mutate(alice.actor, command(alice.scope, {
        action: 'remove', targetSocialId: bob.profile.socialId, expectedRevision: revision
    }))).outcome, 'applied');
    assert.equal((await service.list(bob.actor, 'friends', 20)).items.length, 0);
    const stale = await service.mutate(bob.actor, command(bob.scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: revision
    }));
    assert.equal(stale.outcome, 'rejected');
    assert.equal((await service.list(alice.actor, 'friends', 20)).items.length, 0);
});

test('crossing requests do not create friendship and only the recipient can accept', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const results = await Promise.all([request(alice, bob), request(bob, alice)]);
    assert.equal(results.filter(result => result.outcome === 'applied').length, 1);
    assert.equal((await service.list(alice.actor, 'friends', 20)).items.length, 0);
    const aliceOutgoing = await service.list(alice.actor, 'outgoing', 20);
    const sender = aliceOutgoing.items.length ? alice : bob;
    const recipient = sender === alice ? bob : alice;
    const pending = (await service.list(sender.actor, 'outgoing', 20)).items[0];
    assert.equal((await service.mutate(sender.actor, command(sender.scope, {
        action: 'accept', targetSocialId: recipient.profile.socialId, expectedRevision: pending.revision
    }))).outcome, 'rejected');
    assert.equal((await service.mutate(recipient.actor, command(recipient.scope, {
        action: 'accept', targetSocialId: sender.profile.socialId, expectedRevision: pending.revision
    }))).outcome, 'applied');
});

test('cancel and decline end a request incarnation without allowing stale acceptance', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await request(alice, bob);
    const firstRevision = (await service.list(bob.actor, 'incoming', 20)).items[0].revision;
    assert.equal((await service.mutate(alice.actor, command(alice.scope, {
        action: 'cancel', targetSocialId: bob.profile.socialId, expectedRevision: firstRevision
    }))).outcome, 'applied');
    const relation = await service.relationship(alice.actor, bob.profile.socialId);
    assert.equal(relation?.state, 'none');
    assert.equal((await request(alice, bob, relation!.revision)).outcome, 'applied');
    assert.equal((await service.mutate(bob.actor, command(bob.scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: firstRevision
    }))).outcome, 'rejected');
    const current = (await service.list(bob.actor, 'incoming', 20)).items[0];
    assert.equal((await service.mutate(bob.actor, command(bob.scope, {
        action: 'decline', targetSocialId: alice.profile.socialId, expectedRevision: current.revision
    }))).outcome, 'applied');
    assert.equal((await service.list(alice.actor, 'outgoing', 20)).items.length, 0);
});

test('directional blocks hide both profiles, clear friendship, and never restore it on unblock', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await friendship(alice, bob);
    for (const [from, to] of [[alice, bob], [bob, alice]]) {
        assert.equal((await service.mutate(from.actor, command(from.scope, {
            action: 'block', targetSocialId: to.profile.socialId
        }))).outcome, 'applied');
    }
    assert.equal(await service.lookup(alice.actor, 'bobby'), null);
    assert.equal(await service.lookup(bob.actor, 'alice'), null);
    assert.equal((await service.list(alice.actor, 'friends', 20)).items.length, 0);
    let blocks = await service.list(alice.actor, 'blocks', 20);
    assert.equal(blocks.items.length, 1);
    assertPublic(blocks, [alice.actor, bob.actor]);
    assert.equal((await service.mutate(alice.actor, command(alice.scope, {
        action: 'unblock', targetSocialId: bob.profile.socialId, expectedRevision: blocks.items[0].revision
    }))).outcome, 'applied');
    assert.equal(await service.lookup(alice.actor, 'bobby'), null);
    blocks = await service.list(bob.actor, 'blocks', 20);
    assert.equal((await service.mutate(bob.actor, command(bob.scope, {
        action: 'unblock', targetSocialId: alice.profile.socialId, expectedRevision: blocks.items[0].revision
    }))).outcome, 'applied');
    assert.ok(await service.lookup(alice.actor, 'bobby'));
    assert.equal((await service.list(alice.actor, 'friends', 20)).items.length, 0);
});

test('deactivation keeps handle and blocks while removing incoming, outgoing and friendships', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const carol = await member('carol');
    const david = await member('david');
    await friendship(alice, bob);
    await request(carol, alice);
    await service.mutate(alice.actor, command(alice.scope, { action: 'block', targetSocialId: david.profile.socialId }));
    assert.equal((await service.mutate(alice.actor, command(alice.scope, { action: 'deactivate' }))).outcome, 'applied');
    const inactive = (await service.ownProfile(alice.actor))!;
    assert.equal(inactive.active, false);
    assert.equal(inactive.socialId, alice.profile.socialId);
    assert.equal(inactive.handle, alice.profile.handle);
    assert.equal(await service.lookup(bob.actor, 'alice'), null);
    assert.equal((await service.list(bob.actor, 'friends', 20)).items.length, 0);
    assert.equal((await service.list(carol.actor, 'outgoing', 20)).items.length, 0);
    assert.equal((await service.list(alice.actor, 'blocks', 20)).items.length, 1);
    assert.equal((await service.mutate(alice.actor, command(alice.scope, {
        action: 'profile', expectedRevision: inactive.revision, handle: 'alice', alias: 'Returned', discoverable: false
    }))).outcome, 'applied');
    const reactivated = (await service.ownProfile(alice.actor))!;
    assert.equal(reactivated.socialId, alice.profile.socialId);
    assert.equal(reactivated.active, true);
    assert.equal((await service.list(alice.actor, 'friends', 20)).items.length, 0);
    assert.equal((await service.list(alice.actor, 'blocks', 20)).items.length, 1);
});

test('disabled admission preserves reads and safety mutations including scope issuance', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await request(alice, bob);
    const disabled = createSocialService({ now: () => now, enabled: () => false, secret: () => secret });
    assert.equal(disabled.admissionEnabled(), false);
    assert.ok(await disabled.ownProfile(alice.actor));
    const scope = await disabled.issueScope(bob.actor);
    await assert.rejects(disabled.mutate(bob.actor, command(scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: 1
    })), assertSocialError());
    assert.equal((await disabled.mutate(bob.actor, command(scope, {
        action: 'block', targetSocialId: alice.profile.socialId
    }))).outcome, 'applied');
    const block = (await disabled.list(bob.actor, 'blocks', 20)).items[0];
    assert.equal((await disabled.mutate(bob.actor, command(scope, {
        action: 'unblock', targetSocialId: alice.profile.socialId, expectedRevision: block.revision
    }))).outcome, 'applied');
    assert.equal((await disabled.mutate(bob.actor, command(scope, { action: 'deactivate' }))).outcome, 'applied');
});

test('signed scopes bind accounts and prevent execution after expiry even if receipts are deleted', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const mutation = command(alice.scope, { action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0 });
    await assert.rejects(service.mutate(bob.actor, mutation), assertSocialError());
    const tampered = { ...mutation, scopeToken: `${mutation.scopeToken.slice(0, -3)}xyz` };
    await assert.rejects(service.mutate(alice.actor, tampered), assertSocialError());
    assert.equal((await service.mutate(alice.actor, mutation)).outcome, 'applied');
    now = Date.parse(alice.scope.expiresAt);
    assert.equal((await service.outcome(alice.actor, mutationIdentity(mutation)))?.outcome, 'applied');
    now += SOCIAL_LIMITS.receiptGraceMs;
    assert.equal(await service.outcome(alice.actor, mutationIdentity(mutation)), null);
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({ commandId: mutation.commandId }), 1);
    await getDb()!.collection('socialMutations').deleteMany({ accountId: alice.actor.userId });
    await assert.rejects(service.mutate(alice.actor, mutation), assertSocialError());
    assert.equal(await service.outcome(alice.actor, mutationIdentity(mutation)), null);
    assert.equal((await service.list(alice.actor, 'outgoing', 20)).items.length, 1);
});

test('same intent replays status only and cannot reveal a historical peer after blocking', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const mutation = command(alice.scope, { action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0 });
    const initial = await service.mutate(alice.actor, mutation);
    await service.mutate(bob.actor, command(bob.scope, { action: 'block', targetSocialId: alice.profile.socialId }));
    const replay = await service.mutate(alice.actor, mutation);
    assert.equal(replay.outcome, initial.outcome);
    assert.equal(replay.replayed, true);
    assert.deepEqual(Object.keys(replay).sort(), ['commandId', 'outcome', 'replayed']);
    assert.equal(await service.lookup(alice.actor, 'bobby'), null);
    assert.equal((await service.list(alice.actor, 'outgoing', 20)).items.length, 0);
    assertPublic([replay, await service.outcome(alice.actor, mutationIdentity(mutation))], [alice.actor, bob.actor]);
    await assert.rejects(service.mutate(alice.actor, { ...mutation, expectedRevision: 999 } as SocialCommand),
        error => error instanceof SocialError && error.code === 'idempotency_conflict');
    const receipt = await getDb()!.collection('socialMutations').findOne({ commandId: mutation.commandId });
    assert.equal(JSON.stringify(receipt).includes(bob.profile.socialId), false);
    assert.equal(JSON.stringify(receipt).includes(bob.actor.userId), false);
});

test('transaction rollback leaves no profile, handle, receipt, or notification invalidation', async () => {
    const alice = await actor('alice');
    const scope = await service.issueScope(alice);
    const failure = new Error('synthetic failure before commit');
    const failing = createSocialService({ now: () => now, enabled: () => true, secret: () => secret,
        beforeCommit: async () => { throw failure; } });
    const mutation = command(scope, { action: 'profile', expectedRevision: 0, handle: 'alice', alias: 'Alice', discoverable: true });
    await assert.rejects(failing.mutate(alice, mutation), assertSocialError(503));
    for (const name of ['socialProfiles', 'socialHandles', 'socialMutations', 'socialOutbox']) {
        assert.equal(await getDb()!.collection(name).countDocuments({}), 0, name);
    }
    assert.equal((await service.mutate(alice, mutation)).outcome, 'applied');
});

test('a real Mongo transaction callback retry preserves the captured intent and stores one receipt', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const mutation = command(alice.scope, { action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0 });
    let callbacks = 0;
    const retrying = createSocialService({ now: () => now, enabled: () => true, secret: () => secret,
        beforeCommit: async () => {
            callbacks += 1;
            if (callbacks === 1) {
                // A caller changing its object cannot rebase intent captured before the first transaction.
                if ('expectedRevision' in mutation) mutation.expectedRevision = 999;
                const failure = new MongoServerError({ message: 'synthetic transient transaction failure', code: 112 });
                failure.addErrorLabel('TransientTransactionError');
                throw failure;
            }
        } });
    assert.equal((await retrying.mutate(alice.actor, mutation)).outcome, 'applied');
    assert.equal(callbacks, 2);
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({ commandId: mutation.commandId }), 1);
    assert.equal((await service.list(alice.actor, 'outgoing', 20)).items[0].revision, 1);
});

test('lost acknowledgement after commit is recovered by explicit same-command retry', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const uncertain = new Error('synthetic acknowledgement loss');
    const failing = createSocialService({ now: () => now, enabled: () => true, secret: () => secret,
        afterCommit: async () => { throw uncertain; } });
    const mutation = command(alice.scope, { action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0 });
    await assert.rejects(failing.mutate(alice.actor, mutation),
        error => error instanceof SocialError && error.code === 'mutation_outcome_unknown');
    assert.equal((await service.outcome(alice.actor, mutationIdentity(mutation)))?.outcome, 'applied');
    assert.equal((await service.mutate(alice.actor, mutation)).replayed, true);
    assert.equal((await service.list(alice.actor, 'outgoing', 20)).items[0].revision, 1);
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({ commandId: mutation.commandId }), 1);
});

test('a block winning before request account fencing prevents a racing request from appearing', { timeout: 15_000 }, async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const checkpoint = gate();
    let first = true;
    const racing = createSocialService({ now: () => now, enabled: () => true, secret: () => secret,
        beforeAccountFence: async identity => {
            if (identity.userId === alice.actor.userId && first) {
                first = false;
                checkpoint.enter();
                await checkpoint.released;
            }
        } });
    const pending = racing.mutate(alice.actor, command(alice.scope, {
        action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0
    }));
    await checkpoint.entered;
    try {
        assert.equal((await service.mutate(bob.actor, command(bob.scope, {
            action: 'block', targetSocialId: alice.profile.socialId
        }))).outcome, 'applied');
    } finally { checkpoint.release(); }
    assert.equal((await pending).outcome, 'rejected');
    assert.equal((await service.list(bob.actor, 'incoming', 20)).items.length, 0);
});

test('deactivation winning a concurrent accept cannot recreate the friendship', { timeout: 15_000 }, async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await request(alice, bob);
    const checkpoint = gate();
    let first = true;
    const racing = createSocialService({ now: () => now, enabled: () => true, secret: () => secret,
        beforeAccountFence: async identity => {
            if (identity.userId === bob.actor.userId && first) {
                first = false;
                checkpoint.enter();
                await checkpoint.released;
            }
        } });
    const pending = racing.mutate(bob.actor, command(bob.scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: 1
    }));
    await checkpoint.entered;
    try { await service.mutate(alice.actor, command(alice.scope, { action: 'deactivate' })); }
    finally { checkpoint.release(); }
    assert.equal((await pending).outcome, 'rejected');
    assert.equal((await service.list(bob.actor, 'friends', 20)).items.length, 0);
});

test('missing accounts, revoked sessions, and mismatched session owners cannot access social state', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await assert.rejects(service.ownProfile({ ...alice.actor, sessionId: bob.actor.sessionId }), assertSocialError(401));
    await AuthSession.revokeById(alice.actor.userId, alice.actor.sessionId);
    await assert.rejects(service.issueScope(alice.actor), assertSocialError(401));
    await assert.rejects(service.mutate(alice.actor, command(alice.scope, { action: 'deactivate' })), assertSocialError(401));
    await getDb()!.collection('users').deleteOne({ _id: new ObjectId(bob.actor.userId) });
    await assert.rejects(service.ownProfile(bob.actor), assertSocialError());
});

test('scope and command admission budgets persist across service recreation and profile deactivation', async () => {
    const alice = await member('alice');
    for (let issued = 1; issued < SOCIAL_LIMITS.scopesPerDay; issued += 1) await service.issueScope(alice.actor);
    await assert.rejects(service.issueScope(alice.actor), assertSocialError(429));
    const restarted = createSocialService({ now: () => now, enabled: () => true, secret: () => secret });
    await assert.rejects(restarted.issueScope(alice.actor), assertSocialError(429));
    await restarted.mutate(alice.actor, command(alice.scope, { action: 'deactivate' }));
    await assert.rejects(restarted.issueScope(alice.actor), assertSocialError(429));
    await getDb()!.collection('socialBudgets').updateOne({ accountId: alice.actor.userId },
        { $set: { commandMinute: Math.floor(now / 60_000), commands: SOCIAL_LIMITS.commandsPerMinute } });
    await assert.rejects(restarted.mutate(alice.actor, command(alice.scope, { action: 'deactivate' })), assertSocialError(429));
});

test('keyset pages are bounded, account-bound, and never repeat an unchanged relationship', async () => {
    const alice = await member('alice');
    const peers = await Promise.all(['bobby', 'carol', 'david'].map(name => member(name)));
    for (const peer of peers) await friendship(alice, peer);
    const first = await service.list(alice.actor, 'friends', 2);
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await service.list(alice.actor, 'friends', 2, first.nextCursor!);
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(row => row.socialId)).size, 3);
    assertPublic([first, second], [alice.actor, ...peers.map(peer => peer.actor)]);
    await assert.rejects(service.list(peers[0].actor, 'friends', 2, first.nextCursor!), assertSocialError());
    await assert.rejects(service.list(alice.actor, 'incoming', 2, first.nextCursor!), assertSocialError());
    await assert.rejects(service.list(alice.actor, 'friends', 2, `${first.nextCursor}x`), assertSocialError());
});

for (const kind of ['pending', 'friends', 'blocks', 'edges'] as const) {
    test(`${kind} capacity rejects a new edge transition without consuming recipient budget`, async () => {
        const alice = await member('alice');
        const bob = await member('bobby');
        if (kind === 'friends') await request(bob, alice);
        const rows: SocialRelationshipDocument[] = Array.from({ length: SOCIAL_LIMITS[kind] }, () => {
            const peerId = new ObjectId().toHexString();
            const accountIds = [alice.actor.userId, peerId].sort();
            return {
                _id: accountIds.join(':'), accountIds,
                socialIds: accountIds.map(id => id === alice.actor.userId
                    ? alice.profile.socialId : `s_${randomUUID().replace(/-/g, '')}`),
                state: kind === 'pending' ? 'pending' : kind === 'friends' ? 'accepted' : 'none',
                ...(kind === 'pending' ? { requestedBy: alice.actor.userId } : {}),
                blockedBy: kind === 'blocks' ? [alice.actor.userId] : [], revision: 1, updatedAt: new Date(now)
            };
        });
        await getDb()!.collection<SocialRelationshipDocument>('socialRelationships').insertMany(rows);
        const beforeRecipientBudget = await getDb()!.collection('socialBudgets').findOne({ accountId: bob.actor.userId });
        const mutation = kind === 'blocks'
            ? command(alice.scope, { action: 'block', targetSocialId: bob.profile.socialId })
            : command(alice.scope, { action: kind === 'friends' ? 'accept' : 'request',
                targetSocialId: bob.profile.socialId, expectedRevision: kind === 'friends' ? 1 : 0 });
        const result = await service.mutate(alice.actor, mutation);
        assert.equal(result.outcome, 'rejected');
        assert.equal(result.code, 'social_limit');
        assert.deepEqual(await getDb()!.collection('socialBudgets').findOne({ accountId: bob.actor.userId }), beforeRecipientBudget);
        const targetRelation = await getDb()!.collection('socialRelationships').findOne({
            accountIds: { $all: [alice.actor.userId, bob.actor.userId] }
        });
        assert.equal(targetRelation?.state ?? 'none', kind === 'friends' ? 'pending' : 'none');
    });
}

test('recipient daily incoming budget rejects before creating another request', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await getDb()!.collection('socialBudgets').updateOne({ accountId: bob.actor.userId }, {
        $set: { incomingDay: Math.floor(now / SOCIAL_LIMITS.scopeMs), incoming: SOCIAL_LIMITS.incomingPerDay }
    });
    const rejected = await request(alice, bob);
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.code, 'social_limit');
    assert.equal(await getDb()!.collection('socialRelationships').countDocuments({}), 0);
});

test('retained receipt cap is account-scoped and expired receipt cleanup frees capacity', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const template = await fillReceiptCount(alice.actor, SOCIAL_LIMITS.receipts);
    const mutation = command(alice.scope, { action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0 });
    await assert.rejects(service.mutate(alice.actor, mutation), assertSocialError(429));
    assert.equal((await service.mutate(alice.actor, {
        action: 'profile', scopeToken: alice.scope.scopeToken, commandId: template.commandId,
        expectedRevision: 0, handle: 'alice', alias: 'Alias alice', discoverable: true
    })).replayed, true);
    assert.equal((await service.mutate(bob.actor, command(bob.scope, { action: 'deactivate' }))).outcome, 'applied');
    await getDb()!.collection<SocialReceiptDocument>('socialMutations').updateMany({
        accountId: alice.actor.userId, _id: { $ne: template._id }
    }, { $set: { expiresAt: new Date(now - 1) } });
    const resumed = await service.mutate(alice.actor, mutation);
    assert.equal(resumed.outcome, 'rejected');
    assert.equal(resumed.code, 'profile_unavailable');
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({ accountId: alice.actor.userId }), 2);
});

test('a blocked inactive profile has a null card and can still be unblocked', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await service.mutate(alice.actor, command(alice.scope, { action: 'block', targetSocialId: bob.profile.socialId }));
    await service.mutate(bob.actor, command(bob.scope, { action: 'deactivate' }));
    const blocks = await service.list(alice.actor, 'blocks', 20);
    assert.equal(blocks.items.length, 1);
    assert.equal(blocks.items[0].profile, null);
    assert.equal(blocks.items[0].socialId, bob.profile.socialId);
    assert.equal((await service.mutate(alice.actor, command(alice.scope, {
        action: 'unblock', targetSocialId: bob.profile.socialId, expectedRevision: blocks.items[0].revision
    }))).outcome, 'applied');
    assert.equal((await service.list(alice.actor, 'blocks', 20)).items.length, 0);
});

test('scope expiration during account-fence admission aborts without creating a receipt', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const expiring = createSocialService({ now: () => now, enabled: () => true, secret: () => secret,
        beforeAccountFence: async () => { now = Date.parse(alice.scope.expiresAt); } });
    const mutation = command(alice.scope, { action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0 });
    await assert.rejects(expiring.mutate(alice.actor, mutation),
        error => error instanceof SocialError && error.code === 'mutation_scope_expired');
    assert.equal(await getDb()!.collection('socialRelationships').countDocuments({}), 0);
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({ commandId: mutation.commandId }), 0);
});

test('deleting an actor before its account fence prevents a racing profile resurrection', async () => {
    const alice = await actor('alice');
    const scope = await service.issueScope(alice);
    let callbacks = 0;
    const racing = createSocialService({ now: () => now, enabled: () => true, secret: () => secret,
        beforeAccountFence: async () => {
            callbacks += 1;
            if (callbacks === 1) await getDb()!.collection('users').deleteOne({ _id: new ObjectId(alice.userId) });
        } });
    const mutation = command(scope, { action: 'profile', expectedRevision: 0, handle: 'alice', alias: 'Alice', discoverable: true });
    await assert.rejects(racing.mutate(alice, mutation), assertSocialError(401));
    assert.ok(callbacks >= 2, 'A stale snapshot must retry before observing the missing account.');
    assert.equal(await getDb()!.collection('socialProfiles').countDocuments({}), 0);
    assert.equal(await getDb()!.collection('socialHandles').countDocuments({}), 0);
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({}), 0);
});

test('invalidation storage coalesces per account and replay or rejection does not re-notify', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const mutation = command(alice.scope, { action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0 });
    await service.mutate(alice.actor, mutation);
    const afterRequest = await getDb()!.collection('socialOutbox').find().sort({ _id: 1 }).toArray();
    assert.equal(afterRequest.length, 2);
    assert.deepEqual(afterRequest.map(value => value.revision), [2, 2]);
    for (const value of afterRequest) {
        assert.deepEqual(Object.keys(value).sort(), ['_id', 'accountId', 'revision', 'updatedAt']);
        assert.equal(JSON.stringify(value).includes(alice.profile.socialId), false);
        assert.equal(JSON.stringify(value).includes(bob.profile.socialId), false);
    }
    await service.mutate(alice.actor, mutation);
    await service.mutate(bob.actor, command(bob.scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: 0
    }));
    assert.deepEqual(await getDb()!.collection('socialOutbox').find().sort({ _id: 1 }).toArray(), afterRequest);
    await service.mutate(bob.actor, command(bob.scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: 1
    }));
    assert.equal(await getDb()!.collection('socialOutbox').countDocuments({}), 2);
    assert.deepEqual((await getDb()!.collection('socialOutbox').find().sort({ _id: 1 }).toArray())
        .map(value => value.revision), [3, 3]);
});

test('purging a pair tombstone cannot let a fresh scope accept an obsolete request incarnation', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await request(alice, bob);
    const oldRevision = (await service.list(bob.actor, 'incoming', 20)).items[0].revision;
    await service.mutate(alice.actor, command(alice.scope, {
        action: 'cancel', targetSocialId: bob.profile.socialId, expectedRevision: oldRevision
    }));
    now += SOCIAL_LIMITS.scopeMs + SOCIAL_LIMITS.receiptGraceMs + 1;
    assert.equal((await getDb()!.collection('socialRelationships').deleteMany({
        state: 'none', expiresAt: { $lte: new Date(now) }
    })).deletedCount, 1);
    alice.scope = await service.issueScope(alice.actor);
    bob.scope = await service.issueScope(bob.actor);
    assert.equal((await request(alice, bob, 0)).outcome, 'applied');
    const recreated = (await service.list(bob.actor, 'incoming', 20)).items[0];
    assert.ok(recreated.revision > oldRevision);
    assert.equal((await service.mutate(bob.actor, command(bob.scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: oldRevision
    }))).outcome, 'rejected');
    assert.equal((await service.list(bob.actor, 'friends', 20)).items.length, 0);
    assert.equal((await service.mutate(bob.actor, command(bob.scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: recreated.revision
    }))).outcome, 'applied');
});

test('blocked, hidden, and missing request targets use the same denial without revealing a revision', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const hidden = await member('hidden', false);
    await service.mutate(bob.actor, command(bob.scope, { action: 'block', targetSocialId: alice.profile.socialId }));
    const results = [];
    for (const targetSocialId of [bob.profile.socialId, hidden.profile.socialId, `s_${'0'.repeat(32)}`]) {
        results.push(await service.mutate(alice.actor, command(alice.scope, {
            action: 'request', targetSocialId, expectedRevision: 999
        })));
    }
    assert.deepEqual(results.map(result => ({ outcome: result.outcome, code: result.code })),
        Array.from({ length: 3 }, () => ({ outcome: 'rejected', code: 'profile_unavailable' })));
    for (const result of results) assert.deepEqual(Object.keys(result).sort(), ['code', 'commandId', 'outcome', 'replayed']);
    assertPublic(results, [alice.actor, bob.actor, hidden.actor]);
});

test('relationship reads expose usable preconditions while hiding another account block or hidden profile', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const hidden = await member('hidden', false);
    assert.deepEqual(await service.relationship(alice.actor, bob.profile.socialId), {
        socialId: bob.profile.socialId, state: 'none', revision: 0
    });
    assert.equal(await service.relationship(alice.actor, hidden.profile.socialId), null);
    assert.equal(await service.relationship(alice.actor, `s_${'0'.repeat(32)}`), null);
    await request(alice, bob);
    const outgoing = (await service.relationship(alice.actor, bob.profile.socialId))!;
    const incoming = (await service.relationship(bob.actor, alice.profile.socialId))!;
    assert.equal(outgoing.state, 'outgoing');
    assert.equal(incoming.state, 'incoming');
    assert.equal(outgoing.revision, incoming.revision);
    await service.mutate(bob.actor, command(bob.scope, {
        action: 'accept', targetSocialId: alice.profile.socialId, expectedRevision: incoming.revision
    }));
    await service.mutate(bob.actor, command(bob.scope, {
        action: 'profile', expectedRevision: bob.profile.revision, handle: 'bobby', alias: 'Bob', discoverable: false
    }));
    assert.equal(await service.lookup(alice.actor, 'bobby'), null);
    assert.equal((await service.relationship(alice.actor, bob.profile.socialId))?.state, 'friends');
    await service.mutate(bob.actor, command(bob.scope, { action: 'block', targetSocialId: alice.profile.socialId }));
    assert.equal(await service.relationship(alice.actor, bob.profile.socialId), null);
    const ownBlock = await service.relationship(bob.actor, alice.profile.socialId);
    assert.equal(ownBlock?.state, 'blocked');
    assertPublic([outgoing, incoming, ownBlock], [alice.actor, bob.actor]);
    assert.deepEqual(Object.keys(ownBlock!).sort(), ['revision', 'socialId', 'state']);
});

test('disabled admission permits withdrawing discoverability while preserving existing friendships', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await friendship(alice, bob);
    const disabled = createSocialService({ now: () => now, enabled: () => false, secret: () => secret });
    const hide = command(alice.scope, { action: 'profile', expectedRevision: alice.profile.revision,
        handle: 'alice', alias: alice.profile.alias, discoverable: false });
    assert.equal((await disabled.mutate(alice.actor, hide)).outcome, 'applied');
    const hidden = (await disabled.ownProfile(alice.actor))!;
    assert.equal(hidden.discoverable, false);
    assert.equal(hidden.active, true);
    assert.equal(await disabled.lookup(bob.actor, 'alice'), null);
    assert.equal((await disabled.relationship(alice.actor, bob.profile.socialId))?.state, 'friends');
    const disabledError = (error: unknown) => error instanceof SocialError && error.code === 'social_disabled';
    await assert.rejects(disabled.mutate(alice.actor, command(alice.scope, {
        action: 'profile', expectedRevision: hidden.revision, handle: 'alice', alias: hidden.alias, discoverable: true
    })), disabledError);
    await assert.rejects(disabled.mutate(alice.actor, command(alice.scope, {
        action: 'profile', expectedRevision: hidden.revision, handle: 'alice', alias: 'Changed alias', discoverable: false
    })), disabledError);
    const newcomer = await actor('newcomer');
    const scope = await disabled.issueScope(newcomer);
    await assert.rejects(disabled.mutate(newcomer, command(scope, {
        action: 'profile', expectedRevision: 0, handle: 'newcomer', alias: 'Newcomer', discoverable: false
    })), disabledError);
    await disabled.mutate(alice.actor, command(alice.scope, { action: 'deactivate' }));
    const inactive = (await disabled.ownProfile(alice.actor))!;
    await assert.rejects(disabled.mutate(alice.actor, command(alice.scope, {
        action: 'profile', expectedRevision: inactive.revision, handle: 'alice', alias: inactive.alias, discoverable: false
    })), disabledError);
});

test('ordinary receipts cannot exhaust the reserved block and privacy-exit capacity', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const carol = await member('carol');
    await friendship(alice, bob);
    await fillReceiptCount(alice.actor, SOCIAL_LIMITS.receipts);
    await assert.rejects(request(alice, carol), assertSocialError(429));
    assert.equal((await service.mutate(alice.actor, command(alice.scope, {
        action: 'block', targetSocialId: carol.profile.socialId
    }))).outcome, 'applied');
    assert.equal((await service.mutate(alice.actor, command(alice.scope, {
        action: 'profile', expectedRevision: alice.profile.revision, handle: 'alice',
        alias: alice.profile.alias, discoverable: false
    }))).outcome, 'applied');
    assert.equal((await service.relationship(alice.actor, bob.profile.socialId))?.state, 'friends');
    assert.equal((await service.mutate(alice.actor, command(alice.scope, { action: 'deactivate' }))).outcome, 'applied');
    assert.equal((await service.ownProfile(alice.actor))?.active, false);
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({ accountId: alice.actor.userId }),
        SOCIAL_LIMITS.receipts + 3);
});

test('the final reserved receipt admits only deactivation after all ordinary safety slots are full', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const filled = SOCIAL_LIMITS.receipts + SOCIAL_LIMITS.safetyReceipts;
    await fillReceiptCount(alice.actor, filled);
    await assert.rejects(service.mutate(alice.actor, command(alice.scope, {
        action: 'block', targetSocialId: bob.profile.socialId
    })), assertSocialError(429));
    await assert.rejects(service.mutate(alice.actor, command(alice.scope, {
        action: 'profile', expectedRevision: alice.profile.revision, handle: 'alice',
        alias: alice.profile.alias, discoverable: false
    })), assertSocialError(429));
    await assert.rejects(request(alice, bob), assertSocialError(429));
    const deactivate = command(alice.scope, { action: 'deactivate' });
    assert.equal((await service.mutate(alice.actor, deactivate)).outcome, 'applied');
    assert.equal((await service.mutate(alice.actor, deactivate)).replayed, true);
    assert.equal((await service.ownProfile(alice.actor))?.active, false);
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({ accountId: alice.actor.userId }), filled + 1);
});

test('an unblock with no owned block has one result regardless of peer blocks or a missing target', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const carol = await member('carol');
    await service.mutate(bob.actor, command(bob.scope, { action: 'block', targetSocialId: alice.profile.socialId }));
    const before = await getDb()!.collection('socialRelationships').find().toArray();
    for (const targetSocialId of [bob.profile.socialId, carol.profile.socialId, `s_${'0'.repeat(32)}`]) {
        const result = await service.mutate(alice.actor, command(alice.scope, {
            action: 'unblock', targetSocialId, expectedRevision: 999
        }));
        assert.equal(result.outcome, 'noop');
        assert.equal(result.code, undefined);
    }
    assert.deepEqual(await getDb()!.collection('socialRelationships').find().toArray(), before);
    assert.equal(await service.relationship(alice.actor, bob.profile.socialId), null);
});

test('durable per-account read limits survive process recreation and do not block privacy mutations', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    await getDb()!.collection('socialBudgets').updateOne({ accountId: alice.actor.userId }, {
        $set: { readMinute: Math.floor(now / 60_000), reads: SOCIAL_LIMITS.readsPerMinute - 1 }
    });
    assert.ok(await service.ownProfile(alice.actor));
    const restarted = createSocialService({ now: () => now, enabled: () => true, secret: () => secret });
    await assert.rejects(restarted.lookup(alice.actor, 'bobby'), assertSocialError(429));
    await assert.rejects(restarted.list(alice.actor, 'friends', 20), assertSocialError(429));
    await assert.rejects(restarted.relationship(alice.actor, bob.profile.socialId), assertSocialError(429));
    await assert.rejects(restarted.outcome(alice.actor, {
        scopeToken: alice.scope.scopeToken, commandId: randomUUID()
    }), assertSocialError(429));
    assert.ok(await restarted.ownProfile(bob.actor));
    assert.equal((await restarted.mutate(alice.actor, command(alice.scope, { action: 'deactivate' }))).outcome, 'applied');
    now += 60_000;
    assert.equal((await restarted.ownProfile(alice.actor))?.active, false);
    assert.equal((await getDb()!.collection('socialBudgets').findOne({ accountId: alice.actor.userId }))?.reads, 1);
});

test('an unknown Mongo commit result never re-executes and recovers the committed same-key receipt', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    let attempts = 0;
    const uncertain = createSocialService({ now: () => now, enabled: () => true, secret: () => secret,
        beforeCommit: async session => {
            attempts += 1;
            // Commit in Mongo, then inject a lost driver acknowledgement before the service marks committed.
            await session.commitTransaction();
            const failure = new MongoServerError({ message: 'synthetic lost commit acknowledgement', code: 91 });
            failure.addErrorLabel('UnknownTransactionCommitResult');
            throw failure;
        } });
    const mutation = command(alice.scope, { action: 'request', targetSocialId: bob.profile.socialId, expectedRevision: 0 });
    await assert.rejects(uncertain.mutate(alice.actor, mutation),
        error => error instanceof SocialError && error.code === 'mutation_outcome_unknown');
    assert.equal(attempts, 1);
    assert.equal((await service.outcome(alice.actor, mutationIdentity(mutation)))?.outcome, 'applied');
    assert.equal((await service.mutate(alice.actor, mutation)).replayed, true);
    assert.equal((await service.list(alice.actor, 'outgoing', 20)).items[0].revision, 1);
    assert.equal(await getDb()!.collection('socialMutations').countDocuments({ commandId: mutation.commandId }), 1);
});

test('validly signed list cursors and mutation scopes cannot substitute for each other', async () => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const carol = await member('carol');
    await friendship(alice, bob);
    await friendship(alice, carol);
    const page = await service.list(alice.actor, 'friends', 1);
    assert.ok(page.nextCursor);
    const mutation = command(alice.scope, { action: 'deactivate' });
    await assert.rejects(service.mutate(alice.actor, { ...mutation, scopeToken: page.nextCursor! }),
        error => error instanceof SocialError && error.code === 'mutation_scope_invalid');
    await assert.rejects(service.list(alice.actor, 'friends', 1, alice.scope.scopeToken),
        error => error instanceof SocialError && error.code === 'invalid_cursor');
    assert.equal((await service.ownProfile(alice.actor))?.active, true);
});

test('block listing and admission examine only owned edges in a large unrelated graph', async context => {
    const alice = await member('alice');
    const bob = await member('bobby');
    const carol = await member('carol');
    await service.mutate(alice.actor, command(alice.scope, { action: 'block', targetSocialId: bob.profile.socialId }));
    const unrelatedEdges = 1_000;
    const rows: SocialRelationshipDocument[] = Array.from({ length: unrelatedEdges }, () => {
        const accountIds = [new ObjectId().toHexString(), new ObjectId().toHexString()].sort();
        return {
            _id: accountIds.join(':'), accountIds,
            socialIds: accountIds.map(() => `s_${randomUUID().replace(/-/g, '')}`),
            state: 'none', blockedBy: [accountIds[0]], revision: 1, updatedAt: new Date(now)
        };
    });
    const db = getDb()!;
    await db.collection<SocialRelationshipDocument>('socialRelationships').insertMany(rows);
    // Profile the service's actual transaction queries, rather than explaining a copied filter.
    await db.command({ profile: 2 });
    try {
        assert.equal((await service.list(alice.actor, 'blocks', 20)).items.length, 1);
        assert.equal((await service.mutate(alice.actor, command(alice.scope, {
            action: 'block', targetSocialId: carol.profile.socialId
        }))).outcome, 'applied');
    } finally { await db.command({ profile: 0 }); }
    const operations = await db.collection('system.profile').find({
        ns: `${db.databaseName}.socialRelationships`,
        $or: [{ 'command.find': 'socialRelationships' }, { 'command.aggregate': 'socialRelationships' }]
    }).toArray();
    const list = operations.find(operation => operation.command?.find
        && JSON.stringify(operation.command.filter).includes('"blockedBy"'));
    const capacity = operations.find(operation => operation.command?.aggregate
        && JSON.stringify(operation.command.pipeline).includes('"blockedBy"'));
    assert.ok(list, 'Expected the actual block-list query in the isolated profiler.');
    assert.ok(capacity, 'Expected the actual block-capacity query in the isolated profiler.');
    for (const [purpose, operation] of [['list', list], ['capacity', capacity]] as const) {
        assert.equal(typeof operation.docsExamined, 'number');
        assert.equal(typeof operation.keysExamined, 'number');
        assert.ok(operation.docsExamined <= 2, `${purpose} scanned ${operation.docsExamined} documents.`);
        assert.ok(operation.keysExamined <= 2, `${purpose} scanned ${operation.keysExamined} index keys.`);
        assert.equal(String(operation.planSummary).includes('COLLSCAN'), false);
    }
    context.diagnostic(JSON.stringify({ unrelatedEdges, blockListDocsExamined: list.docsExamined,
        blockCapacityDocsExamined: capacity.docsExamined, blockListKeysExamined: list.keysExamined,
        blockCapacityKeysExamined: capacity.keysExamined }));
});
