import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Collection, MongoServerError, ObjectId, type ClientSession } from 'mongodb';
import { createRoomService, type RoomServiceOptions } from '../src/application/rooms/roomService';
import { applyRoomSafety, invalidateRoomsForMedia } from '../src/application/rooms/roomLifecycle';
import { createSocialService } from '../src/application/social/socialService';
import { ROOM_LIMITS, type RoomActor, type RoomApi, type RoomCommand, type RoomMediaDescriptor, type RoomSnapshot } from '../src/contracts/roomV1';
import { SOCIAL_LIMITS, SocialError, type SocialApi, type SocialScope } from '../src/contracts/socialV1';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import AuthActionToken from '../src/models/authActionToken';
import { applyEmailAction, changeAccountPassword } from '../src/services/authCredentialService';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import type { RoomDocument } from '../src/repositories/social/roomDocuments';
import { startMongoReplicaSet, type MongoReplicaSetHarness } from './support/mongoReplicaSet';

let harness: MongoReplicaSetHarness | undefined;
let now = Date.now();
let enabled = true;
let epoch = 1;
let api: RoomApi;
let social: SocialApi;
let media: RoomMediaDescriptor[];
const secret = 'synthetic-room-integration-secret';
const collections = ['users', 'authSessions', 'socialProfiles', 'socialRelationships', 'socialMutations', 'socialOutbox',
    'socialBudgets', 'socialHandles', 'socialRooms', 'socialRoomParticipation', 'socialRoomOutbox', 'socialInvitations', 'audioTracks', 'roomTestAuthority'];
const database = () => getDb()!;
const roomDocuments = () => database().collection<RoomDocument>('socialRooms');

/** Synthetic media still uses the actual source document as a transactional replacement fence. */
const resolveMedia = async (id: string, session?: ClientSession) => {
    const value = await database().collection('audioTracks').findOne({ _id: new ObjectId(id), uploadStatus: 'ready', publicationStatus: 'ready' }, { session });
    return value?.roomFixture as RoomMediaDescriptor | undefined ?? null;
};
const touchMedia = async (id: string, revision: string, session: ClientSession) => {
    const value = await database().collection('audioTracks').findOneAndUpdate({ _id: new ObjectId(id), uploadStatus: 'ready',
        publicationStatus: 'ready', 'roomFixture.mediaRevision': revision }, { $inc: { roomFence: 1 } }, { session, returnDocument: 'after' });
    return value.value?.roomFixture as RoomMediaDescriptor | undefined ?? null;
};
const service = (options: RoomServiceOptions = {}) => createRoomService({ now: () => now, enabled: () => enabled, secret: () => secret,
    resolveMedia, touchMedia, assertAuthority: async session => {
        await database().collection('roomTestAuthority').updateOne({ _id: new ObjectId('000000000000000000000001') }, { $inc: { fence: 1 } }, { session });
        return epoch;
    }, ...options });

before(async () => { harness = await startMongoReplicaSet('archtree-room-lifecycle-test'); });
beforeEach(async () => {
    now = Date.now(); enabled = true; epoch = 1;
    await Promise.all(collections.map(name => database().collection(name).deleteMany({})));
    await database().collection('roomTestAuthority').insertOne({ _id: new ObjectId('000000000000000000000001'), fence: 0 });
    media = Array.from({ length: 3 }, (_, index) => {
        const mediaTrackId = new ObjectId().toHexString();
        return { mediaTrackId, title: `Room audio ${index}`, mediaRevision: `mr_${String(index + 1).repeat(32)}`, durationMs: 20_000,
            streamUrl: `/content/mediaTrack/stream/${mediaTrackId}?revision=mr_${String(index + 1).repeat(32)}`, mediaType: 'Audio' as const };
    });
    await database().collection('audioTracks').insertMany(media.map(roomFixture => ({ _id: new ObjectId(roomFixture.mediaTrackId),
        uploadStatus: 'ready', publicationStatus: 'ready', s3Key: roomFixture.mediaTrackId,
        mediaRepresentation: { seekable: true, format: 'wav-pcm' }, roomFixture })));
    social = createSocialService({ now: () => now, enabled: () => true, secret: () => secret });
    api = service();
});
after(async () => { await harness?.stop(); });

const person = async (name: string) => {
    const user = new ObjectId();
    await database().collection('users').insertOne({ _id: user, email: `${name}@private.invalid`, username: `private-${name}`, role: 'user' });
    const sessionId = await AuthSession.create(user.toHexString(), `synthetic-${randomUUID()}`, new Date(now + SOCIAL_LIMITS.scopeMs * 7));
    const actor: RoomActor = { userId: user.toHexString(), sessionId, clientId: randomUUID() };
    const scope = await social.issueScope(actor);
    assert.equal((await social.mutate(actor, { ...identity(scope), action: 'profile', expectedRevision: 0, handle: name,
        alias: `Public ${name}`, discoverable: true })).outcome, 'applied');
    return { actor, scope, profile: (await social.ownProfile(actor))! };
};
type Person = Awaited<ReturnType<typeof person>>;
const identity = (scope: SocialScope) => ({ scopeToken: scope.scopeToken, commandId: randomUUID() });
const command = (who: Person, body: Record<string, unknown>) => ({ ...body, ...identity(who.scope) }) as RoomCommand;
const snapshot = async (who: Person, target = api) => { const value = await target.currentRoom(who.actor); assert.ok(value); return value; };
const memberBody = (state: RoomSnapshot) => ({ roomId: state.roomId, memberId: state.self.memberId });
const controlBody = (state: RoomSnapshot) => ({ ...memberBody(state), expectedEpoch: state.epoch,
    controllerGeneration: state.self.controllerGeneration, expectedControlGeneration: state.controlGeneration,
    expectedPlaybackGeneration: state.timeline!.playbackGeneration, expectedEntryId: state.timeline!.entryId, expectedQueueRevision: state.queueRevision });
const control = (who: Person, state: RoomSnapshot, action: string, extra: Record<string, unknown> = {}) => command(who, { ...controlBody(state), action, ...extra });
const connect = (who: Person, state: RoomSnapshot, locallyPaused = false, target = api) => target.heartbeat(who.actor,
    { ...memberBody(state), controllerGeneration: state.self.controllerGeneration, locallyPaused });
const ready = (who: Person, state: RoomSnapshot, value = true, sequence = 1, target = api) => target.ready(who.actor,
    { ...memberBody(state), controllerGeneration: state.self.controllerGeneration, expectedEpoch: state.epoch,
        preparationId: state.preparation!.preparationId, playbackGeneration: state.timeline!.playbackGeneration,
        entryId: state.timeline!.entryId, mediaRevision: state.timeline!.mediaRevision, sequence, ready: value });
const friendship = async (a: Person, b: Person) => {
    assert.equal((await social.mutate(a.actor, { ...identity(a.scope), action: 'request', targetSocialId: b.profile.socialId, expectedRevision: 0 })).outcome, 'applied');
    const relation = await social.relationship(b.actor, a.profile.socialId);
    assert.equal((await social.mutate(b.actor, { ...identity(b.scope), action: 'accept', targetSocialId: a.profile.socialId, expectedRevision: relation!.revision })).outcome, 'applied');
};
const create = async (host: Person, target = api) => {
    assert.equal((await target.mutate(host.actor, command(host, { action: 'create', mediaTrackIds: media.map(value => value.mediaTrackId) }))).outcome, 'applied');
    const value = await snapshot(host, target); await connect(host, value, false, target); return snapshot(host, target);
};
const invite = async (host: Person, guest: Person) => {
    const current = await snapshot(host);
    assert.equal((await api.mutate(host.actor, command(host, { action: 'invite', ...memberBody(current), targetSocialId: guest.profile.socialId }))).outcome, 'applied');
    const invitation = (await api.invitations(guest.actor))[0]; assert.ok(invitation); return invitation;
};
const join = async (host: Person, guest: Person) => {
    const invitation = await invite(host, guest);
    assert.equal((await api.mutate(guest.actor, command(guest, { action: 'acceptInvitation', invitationId: invitation.invitationId, generation: invitation.generation }))).outcome, 'applied');
    const current = await snapshot(guest); await connect(guest, current); return snapshot(guest);
};
const pair = async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); await create(host); await join(host, guest);
    return { host, guest };
};
const playPair = async (host: Person, guest: Person) => {
    assert.equal((await api.mutate(host.actor, control(host, await snapshot(host), 'play'))).outcome, 'applied');
    const preparingHost = await snapshot(host); const preparingGuest = await snapshot(guest);
    await ready(host, preparingHost); await ready(guest, preparingGuest);
    return snapshot(host);
};
const isError = (code: string) => (error: unknown) => error instanceof SocialError && error.code === code;
const transaction = async (work: (session: ClientSession) => Promise<unknown>) => {
    const session = getDatabaseClient().startSession();
    try { await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
};

/** Recommendations deliberately need no active-controller or playback-generation fields. */
const requestSong = async (who: Person, index = 0, target = api) => {
    const state = await snapshot(who, target);
    return target.mutate(who.actor, command(who, { action: 'requestSong', ...memberBody(state), expectedEpoch: state.epoch,
        mediaTrackId: media[index].mediaTrackId }));
};
const community = async (who: Person, target = api) => target.community(who.actor, (await snapshot(who, target)).roomId);
const outboxRevision = async (who: Person) => (await database().collection('socialOutbox').findOne({ _id: who.actor.userId }))?.revision ?? 0;

/** Reactions are admitted-member intents, including a tab that does not own playback control. */
const reaction = async (who: Person, target = api, value = 'heart') => {
    const state = await snapshot(who, target);
    return target.mutate(who.actor, command(who, { action: 'react', ...memberBody(state), expectedEpoch: state.epoch, reaction: value }));
};

test('observer reactions are status-only, fenced, and never change playback or broadcast generic social invalidations', async () => {
    const { host, guest } = await pair(); const outsider = await person('outsider');
    const observer = { ...guest, actor: { ...guest.actor, clientId: randomUUID() } };
    await connect(guest, await snapshot(guest), true);
    await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    const before = await snapshot(host); const state = await snapshot(observer);
    const stored = (await roomDocuments().findOne({ _id: before.roomId }))!;
    const outboxes = await Promise.all([outboxRevision(host), outboxRevision(guest)]);
    const intent = command(observer, { action: 'react', ...memberBody(state), expectedEpoch: state.epoch, reaction: 'heart' });
    const outcomes = await Promise.all([api.mutate(observer.actor, intent), api.mutate(observer.actor, intent)]);
    assert.ok(outcomes.every(value => value.outcome === 'applied')); assert.equal(outcomes.filter(value => value.replayed).length, 1);
    assert.deepEqual(Object.keys(outcomes[0]).sort(), ['commandId', 'outcome', 'replayed']);
    const value = await community(host); const event = value.events.at(-1)!;
    assert.equal(value.events.filter(entry => entry.kind === 'reaction').length, 1);
    assert.deepEqual(Object.keys(event).sort(), ['actor', 'createdAtMs', 'eventId', 'expiresAtMs', 'kind', 'reaction']);
    assert.equal(event.kind, 'reaction'); assert.equal(event.reaction, 'heart'); assert.equal(event.actor?.socialId, guest.profile.socialId);
    assert.equal(event.expiresAtMs - event.createdAtMs, ROOM_LIMITS.eventMs);
    const after = await snapshot(host); const persisted = (await roomDocuments().findOne({ _id: before.roomId }))!;
    assert.deepEqual({ ...after, revision: before.revision }, before);
    assert.deepEqual(persisted.members, stored.members); assert.deepEqual(persisted.preparation, stored.preparation);
    assert.equal(persisted.reactions, 1);
    assert.equal((await database().collection('socialBudgets').findOne({ _id: guest.actor.userId }))?.roomReactions, 1);
    assert.deepEqual(await Promise.all([outboxRevision(host), outboxRevision(guest)]), outboxes);
    assert.equal((await api.mutate(observer.actor, { ...intent, commandId: randomUUID(), expectedEpoch: state.epoch + 1 } as RoomCommand)).code, 'stale_epoch');
    assert.equal((await api.mutate(outsider.actor, { ...intent, ...identity(outsider.scope) })).code, 'room_unavailable');
    await connect(guest, await snapshot(guest)); await ready(host, await snapshot(host));
    assert.deepEqual((await community(host)).events, value.events);
    for (const who of [host, guest]) for (const privateId of [who.actor.userId, who.actor.sessionId, who.actor.clientId, (await snapshot(who)).self.memberId]) {
        assert.equal(JSON.stringify(value).includes(privateId), false);
    }
});

test('reaction admission rejects revoked sessions, stale member incarnations, disabled and suspended rooms without consuming reaction quota', async () => {
    const { host, guest } = await pair(); const before = await snapshot(guest);
    const intent = command(guest, { action: 'react', ...memberBody(before), expectedEpoch: before.epoch, reaction: 'fire' });
    enabled = false; await assert.rejects(api.mutate(guest.actor, intent), isError('rooms_disabled')); enabled = true;
    await roomDocuments().updateOne({ _id: before.roomId }, { $set: { hostSuspended: true } });
    assert.equal((await api.mutate(guest.actor, intent)).code, 'host_absent');
    await roomDocuments().updateOne({ _id: before.roomId }, { $set: { hostSuspended: false } });
    assert.equal((await api.mutate(guest.actor, intent)).replayed, true);
    await api.mutate(guest.actor, command(guest, { action: 'leave', ...memberBody(before) })); await join(host, guest);
    assert.equal((await api.mutate(guest.actor, { ...intent, commandId: randomUUID() })).code, 'room_unavailable');
    const fresh = command(guest, { action: 'react', ...memberBody(await snapshot(guest)), expectedEpoch: before.epoch, reaction: 'fire' });
    await AuthSession.revokeById(guest.actor.userId, guest.actor.sessionId);
    await assert.rejects(api.mutate(guest.actor, fresh), isError('social_session_required'));
    assert.equal((await database().collection('socialBudgets').findOne({ _id: guest.actor.userId }))?.roomReactions, undefined);
    assert.equal((await community(host)).events.filter(event => event.kind === 'reaction').length, 0);
});

test('concurrent last-account reactions spend exactly one remaining slot and rejoining does not reset the durable limit', async () => {
    const { host, guest } = await pair();
    for (let index = 0; index < ROOM_LIMITS.reactionsPerAccountMinute - 1; index += 1) assert.equal((await reaction(guest)).outcome, 'applied');
    const state = await snapshot(guest);
    const intents = Array.from({ length: 2 }, () => command(guest, { action: 'react', ...memberBody(state), expectedEpoch: state.epoch, reaction: 'clap' }));
    const outcomes = await Promise.all(intents.map(intent => api.mutate(guest.actor, intent)));
    assert.equal(outcomes.filter(value => value.outcome === 'applied').length, 1);
    assert.equal(outcomes.filter(value => value.code === 'room_reaction_limit').length, 1);
    const rejected = intents[outcomes.findIndex(value => value.outcome === 'rejected')];
    assert.equal((await api.mutate(guest.actor, rejected)).replayed, true);
    assert.equal((await database().collection('socialBudgets').findOne({ _id: guest.actor.userId }))?.roomReactions, ROOM_LIMITS.reactionsPerAccountMinute);
    await api.mutate(guest.actor, command(guest, { action: 'leave', ...memberBody(state) })); await join(host, guest);
    assert.equal((await reaction({ ...guest, actor: { ...guest.actor, clientId: randomUUID() } })).code, 'room_reaction_limit');
    assert.equal((await community(host)).events.filter(event => event.kind === 'reaction').length, 0);
    now = (Math.floor(now / 60_000) + 1) * 60_000;
    assert.equal((await reaction(guest)).outcome, 'applied');
    assert.equal((await database().collection('socialBudgets').findOne({ _id: guest.actor.userId }))?.roomReactions, 1);
});

test('room reaction quota arbitrates different accounts transactionally without charging the rejected account', async () => {
    const { host, guest } = await pair(); const state = await snapshot(host);
    await roomDocuments().updateOne({ _id: state.roomId }, { $set: { reactionMinute: Math.floor(now / 60_000), reactions: ROOM_LIMITS.reactionsPerRoomMinute - 1 } });
    const outcomes = await Promise.all([reaction(host), reaction(guest)]);
    assert.equal(outcomes.filter(value => value.outcome === 'applied').length, 1);
    assert.equal(outcomes.filter(value => value.code === 'room_reaction_limit').length, 1);
    assert.equal((await roomDocuments().findOne({ _id: state.roomId }))?.reactions, ROOM_LIMITS.reactionsPerRoomMinute);
    const budgets = await database().collection('socialBudgets').find({ _id: { $in: [host.actor.userId, guest.actor.userId] } }).toArray();
    assert.equal(budgets.reduce((sum, budget) => sum + (budget.roomReactions ?? 0), 0), 1);
    assert.equal((await community(host)).events.filter(event => event.kind === 'reaction').length, 1);
});

test('uncertain reaction commits retain one event and one quota charge for exact same-intent recovery', async () => {
    const { host, guest } = await pair(); const state = await snapshot(guest); let commits = 0;
    const intent = command(guest, { action: 'react', ...memberBody(state), expectedEpoch: state.epoch, reaction: 'music' });
    const uncertain = service({ beforeCommit: async session => {
        commits += 1; await session.commitTransaction();
        const error = new MongoServerError({ message: 'synthetic lost reaction acknowledgement' });
        error.addErrorLabel('UnknownTransactionCommitResult'); error.addErrorLabel('TransientTransactionError'); throw error;
    } });
    await assert.rejects(uncertain.mutate(guest.actor, intent), isError('mutation_outcome_unknown'));
    assert.equal(commits, 1);
    const before = await community(host);
    assert.equal(before.events.filter(event => event.kind === 'reaction').length, 1);
    assert.equal((await social.outcome(guest.actor, { scopeToken: intent.scopeToken, commandId: intent.commandId }))!.outcome, 'applied');
    assert.equal((await api.mutate(guest.actor, intent)).replayed, true); assert.deepEqual(await community(host), before);
    assert.equal((await database().collection('socialBudgets').findOne({ _id: guest.actor.userId }))?.roomReactions, 1);
});

test('accepted activity hooks omit noops, rejections, readiness and reconnects, and label only different queue occurrences as song changes', async () => {
    const { host, guest } = await pair();
    assert.deepEqual((await community(host)).events.map(event => [event.kind, event.actor?.socialId]), [
        ['joined', host.profile.socialId], ['joined', guest.profile.socialId]
    ]);
    await api.mutate(host.actor, control(host, await snapshot(host), 'setControlMode', { mode: 'hostOnly' }));
    await api.mutate(guest.actor, control(guest, await snapshot(guest), 'next'));
    await playPair(host, guest);
    await api.disconnected(guest.actor); await connect(guest, await snapshot(guest));
    assert.equal((await community(host)).events.length, 2);
    const mode = control(host, await snapshot(host), 'setControlMode', { mode: 'everyone' });
    assert.equal((await api.mutate(host.actor, mode)).outcome, 'applied'); await api.mutate(host.actor, mode);
    const before = await snapshot(guest);
    const next = control(guest, before, 'next'); const sameEntry = control(host, await snapshot(host), 'select', { targetEntryId: before.timeline!.entryId });
    assert.equal((await api.mutate(guest.actor, next)).outcome, 'applied'); await api.mutate(guest.actor, next);
    assert.equal((await api.mutate(host.actor, sameEntry)).code, 'stale_playback');
    const current = await snapshot(host);
    await api.mutate(host.actor, control(host, current, 'select', { targetEntryId: current.timeline!.entryId }));
    const events = (await community(host)).events;
    assert.deepEqual(events.map(event => event.kind), ['joined', 'joined', 'modeChanged', 'trackChanged']);
    assert.equal(events.at(-1)?.actor?.socialId, guest.profile.socialId);
});

test('activity retains at most the newest twenty notices and expires logically before sweep without altering playback generations', async () => {
    const { host, guest } = await pair();
    for (let index = 0; index < 12; index += 1) { await reaction(host); await reaction(guest); }
    const before = await snapshot(host); const value = await community(host);
    assert.equal(value.events.length, ROOM_LIMITS.events); assert.ok(value.events.every(event => event.kind === 'reaction'));
    assert.equal(new Set(value.events.map(event => event.eventId)).size, ROOM_LIMITS.events);
    assert.equal((await roomDocuments().findOne({ _id: before.roomId }))?.events?.length, ROOM_LIMITS.events);
    now += ROOM_LIMITS.eventMs;
    assert.deepEqual((await community(host)).events, []);
    await connect(host, await snapshot(host)); await connect(guest, await snapshot(guest));
    const connected = await snapshot(host); await api.sweep();
    const after = await snapshot(host);
    assert.deepEqual({ ...after, revision: connected.revision }, connected);
    assert.deepEqual((await roomDocuments().findOne({ _id: before.roomId }))?.events, []);
    const settled = await snapshot(host); await api.sweep(); assert.deepEqual(await snapshot(host), settled);
});

test('an aborted reaction transaction retains neither an event nor reaction quota and permits explicit same-intent retry', async () => {
    const { host, guest } = await pair(); const state = await snapshot(guest);
    const intent = command(guest, { action: 'react', ...memberBody(state), expectedEpoch: state.epoch, reaction: 'smile' });
    const before = await community(host);
    const aborted = service({ beforeCommit: async () => { throw new Error('synthetic before-commit failure'); } });
    await assert.rejects(aborted.mutate(guest.actor, intent), isError('room_unavailable'));
    assert.deepEqual(await community(host), before);
    assert.equal((await database().collection('socialBudgets').findOne({ _id: guest.actor.userId }))?.roomReactions, undefined);
    assert.equal(await social.outcome(guest.actor, { scopeToken: intent.scopeToken, commandId: intent.commandId }), null);
    assert.equal((await api.mutate(guest.actor, intent)).outcome, 'applied');
    assert.equal((await community(host)).events.filter(event => event.kind === 'reaction').length, 1);
});

test('Unicode event projection trims oldest optional notices before reducing readable requests or queue credits', async () => {
    const host = await person('host'.padEnd(24, 'x')); const guest = await person('guest'.padEnd(24, 'x'));
    await friendship(host, guest); await create(host); await join(host, guest); const members = [host, guest];
    for (const name of ['third', 'fourth']) { const added = await person(name.padEnd(24, 'x')); await friendship(host, added); await join(host, added); members.push(added); }
    for (const who of members) {
        const profile = (await social.ownProfile(who.actor))!;
        assert.equal((await social.mutate(who.actor, { ...identity(who.scope), action: 'profile', expectedRevision: profile.revision,
            handle: profile.handle, alias: '🎵'.repeat(50), discoverable: true })).outcome, 'applied');
    }
    const state = await snapshot(host); const stored = (await roomDocuments().findOne({ _id: state.roomId }))!;
    stored.queue = Array.from({ length: ROOM_LIMITS.queue }, (_, index) => ({ ...stored.queue[0], entryId: index === 0 ? stored.queue[0].entryId : randomUUID() }));
    stored.songRequests = Array.from({ length: ROOM_LIMITS.songRequests }, (_, index) => ({ requestId: randomUUID(),
        requesterMembershipId: stored.members[Math.floor(index / ROOM_LIMITS.songRequestsPerMember)].membershipId,
        mediaTrackId: new ObjectId().toHexString(), mediaRevision: media[0].mediaRevision, title: '🎵'.repeat(160), createdAt: new Date(now) }));
    await database().collection('audioTracks').insertMany(stored.songRequests.map(request => ({ _id: new ObjectId(request.mediaTrackId),
        uploadStatus: 'ready', publicationStatus: 'ready', roomFixture: { ...media[0], mediaTrackId: request.mediaTrackId } })));
    stored.events = [];
    await roomDocuments().replaceOne({ _id: state.roomId }, stored);
    let required;
    // Keep the fixture inside the same encoded-byte budget while filling it close to capacity.
    for (let length = 160; length >= 0; length -= 1) {
        await roomDocuments().updateOne({ _id: state.roomId }, { $set: { songRequests: stored.songRequests.map(value => ({ ...value, title: '🎵'.repeat(length) || 'Audio' })) } });
        try { required = await api.community(host.actor, state.roomId); } catch (error) {
            if (!isError('room_snapshot_too_large')(error)) throw error;
            continue;
        }
        if (Buffer.byteLength(JSON.stringify(required)) <= ROOM_LIMITS.snapshotBytes - 1_000) break;
    }
    assert.ok(required); assert.ok(Buffer.byteLength(JSON.stringify(required)) > ROOM_LIMITS.snapshotBytes - 2_000);
    for (let index = 0; index < 10; index += 1) { assert.equal((await reaction(host)).outcome, 'applied'); assert.equal((await reaction(guest)).outcome, 'applied'); }
    const visible = await api.community(host.actor, state.roomId);
    const internal = (await roomDocuments().findOne({ _id: state.roomId }))!.events!;
    assert.equal(internal.length, ROOM_LIMITS.events); assert.ok(visible.events.length > 0 && visible.events.length < ROOM_LIMITS.events);
    assert.deepEqual(visible.requests, required.requests); assert.deepEqual(visible.queueCredits, required.queueCredits);
    assert.deepEqual(visible.events.map(event => event.eventId), internal.slice(-visible.events.length).map(event => event.eventId));
    assert.ok(Buffer.byteLength(JSON.stringify(visible)) <= ROOM_LIMITS.snapshotBytes);
});

test('observer recommendations have current attribution, duplicate suppression and status-only recovery without changing playback', async () => {
    const { host, guest } = await pair(); const outsider = await person('outsider');
    const observer = { ...guest, actor: { ...guest.actor, clientId: randomUUID() } };
    const before = await snapshot(host); const state = await snapshot(observer);
    const original = command(observer, { action: 'requestSong', ...memberBody(state), expectedEpoch: state.epoch, mediaTrackId: media[1].mediaTrackId });
    const revisions = await Promise.all([outboxRevision(host), outboxRevision(guest)]);
    assert.equal((await api.mutate(observer.actor, original)).outcome, 'applied');
    const value = await community(host);
    assert.equal(value.requests.length, 1); assert.equal(value.requests[0].requestedBy.socialId, guest.profile.socialId);
    assert.ok(value.queueCredits.every(credit => credit.requestedBy?.socialId === host.profile.socialId));
    assert.deepEqual(Object.keys(value.requests[0]).sort(), ['createdAtMs', 'mediaTrackId', 'requestId', 'requestedBy', 'title']);
    assert.deepEqual(Object.keys(value).sort(), ['epoch', 'events', 'queueCredits', 'requests', 'revision', 'roomId']);
    for (const who of [host, guest]) for (const privateId of [who.actor.userId, who.actor.sessionId, who.actor.clientId]) assert.equal(JSON.stringify(value).includes(privateId), false);
    assert.equal((await api.mutate(observer.actor, original)).replayed, true);
    assert.equal((await requestSong(observer, 1)).outcome, 'noop');
    assert.equal((await community(host)).requests.length, 1);
    assert.deepEqual(await Promise.all([outboxRevision(host), outboxRevision(guest)]), revisions);
    const after = await snapshot(host);
    assert.deepEqual(after.timeline, before.timeline); assert.deepEqual(after.queue, before.queue); assert.equal(after.queueRevision, before.queueRevision);
    await assert.rejects(api.community(outsider.actor, state.roomId), isError('room_unavailable'));
    await assert.rejects(api.community(outsider.actor, 'missing'), isError('room_unavailable'));
    await assert.rejects(api.mutate(observer.actor, { ...original, mediaTrackId: media[2].mediaTrackId } as RoomCommand), isError('idempotency_conflict'));
});

test('host queue edits preserve preparation and local pause while enforcing every observed version', async () => {
    const { host, guest } = await pair(); await connect(guest, await snapshot(guest), true);
    await requestSong(guest, 1); const request = (await community(host)).requests[0];
    await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    const before = await snapshot(host); const stored = await roomDocuments().findOne({ _id: before.roomId });
    const accept = control(host, before, 'acceptSongRequest', { requestId: request.requestId });
    assert.equal((await api.mutate(guest.actor, control(guest, await snapshot(guest), 'acceptSongRequest', { requestId: request.requestId }))).code, 'room_forbidden');
    assert.equal((await api.mutate({ ...host.actor, clientId: randomUUID() }, { ...accept, commandId: randomUUID() })).code, 'stale_controller');
    assert.equal((await api.mutate(host.actor, accept)).outcome, 'applied');
    const appended = await snapshot(host);
    assert.equal(appended.queue.length, before.queue.length + 1); assert.equal(appended.queueRevision, before.queueRevision + 1);
    assert.deepEqual(appended.preparation, before.preparation); assert.deepEqual(appended.timeline, before.timeline);
    assert.equal((await community(host)).requests.length, 0);
    assert.equal((await community(host)).queueCredits.at(-1)?.requestedBy?.socialId, guest.profile.socialId);
    assert.deepEqual((await roomDocuments().findOne({ _id: before.roomId }))?.members, stored?.members);
    assert.equal((await api.mutate(host.actor, accept)).replayed, true);
    const stale = control(host, before, 'reorderQueue', { entryIds: [...appended.queue].reverse().map(entry => entry.entryId) });
    assert.equal((await api.mutate(host.actor, stale)).code, 'stale_queue');
    assert.equal((await api.mutate(host.actor, control(host, appended, 'removeQueueEntry', { targetEntryId: appended.timeline!.entryId }))).code, 'current_entry_required');
    assert.equal((await api.mutate(host.actor, control(host, appended, 'reorderQueue', { entryIds: appended.queue.slice(1).map(entry => entry.entryId) }))).code, 'queue_entries_changed');
    const reorderedIds = [...appended.queue].reverse().map(entry => entry.entryId);
    assert.equal((await api.mutate(host.actor, control(host, appended, 'reorderQueue', { entryIds: reorderedIds }))).outcome, 'applied');
    const reordered = await snapshot(host);
    assert.deepEqual(reordered.queue.map(entry => entry.entryId), reorderedIds); assert.deepEqual(reordered.preparation, before.preparation);
    assert.equal((await api.mutate(host.actor, control(host, reordered, 'removeQueueEntry', { targetEntryId: reordered.queue[0].entryId }))).outcome, 'applied');
    const removed = await snapshot(host); assert.deepEqual(removed.timeline, before.timeline); assert.deepEqual(removed.preparation, before.preparation);
    assert.equal(removed.queue.length, before.queue.length);
    assert.equal((await api.mutate(host.actor, control(host, removed, 'reorderQueue', { entryIds: removed.queue.map(entry => entry.entryId),
        expectedPlaybackGeneration: removed.timeline!.playbackGeneration + 1 }))).code, 'stale_playback');
    assert.equal((await api.mutate(host.actor, control(host, removed, 'reorderQueue', { entryIds: removed.queue.map(entry => entry.entryId),
        expectedControlGeneration: removed.controlGeneration + 1 }))).code, 'stale_permission');
    await ready(host, removed); const playing = await snapshot(host);
    assert.equal(playing.timeline!.state, 'playing');
    assert.equal((await api.mutate(host.actor, control(host, playing, 'reorderQueue', { entryIds: [...playing.queue].reverse().map(entry => entry.entryId) }))).outcome, 'applied');
    assert.deepEqual((await snapshot(host)).timeline, playing.timeline);
});

test('recommendation withdrawal is a feature-disabled safety operation with member-incarnation ownership', async () => {
    const { host, guest } = await pair(); await requestSong(guest); await requestSong(host, 1);
    const requests = (await community(host)).requests; const guestRequest = requests.find(value => value.requestedBy.socialId === guest.profile.socialId)!;
    const hostRequest = requests.find(value => value.requestedBy.socialId === host.profile.socialId)!;
    const observer = { ...guest, actor: { ...guest.actor, clientId: randomUUID() } };
    const dismiss = (who: Person, state: RoomSnapshot, requestId: string) => command(who, { ...memberBody(state), action: 'dismissSongRequest', requestId });
    assert.equal((await api.mutate(observer.actor, dismiss(observer, await snapshot(observer), hostRequest.requestId))).code, 'room_forbidden');
    const hostObserver = { ...host, actor: { ...host.actor, clientId: randomUUID() } };
    assert.equal((await api.mutate(hostObserver.actor, dismiss(hostObserver, await snapshot(hostObserver), guestRequest.requestId))).code, 'room_forbidden');
    enabled = false;
    await assert.rejects(requestSong(guest, 2), isError('rooms_disabled'));
    await assert.rejects(api.mutate(host.actor, control(host, await snapshot(host), 'acceptSongRequest', { requestId: guestRequest.requestId })), isError('rooms_disabled'));
    assert.equal((await api.mutate(observer.actor, dismiss(observer, await snapshot(observer), guestRequest.requestId))).outcome, 'applied');
    assert.equal((await api.mutate(host.actor, dismiss(host, await snapshot(host), hostRequest.requestId))).outcome, 'applied');
    assert.deepEqual((await community(host)).requests, []);
});

test('recommendations enforce per-member and room capacities without duplicate or rejected invalidations', async () => {
    const host = await person('host'); await create(host);
    for (let index = media.length; index < 6; index += 1) {
        const id = new ObjectId();
        const roomFixture = { ...media[0], mediaTrackId: id.toHexString(), title: `Additional audio ${index}` };
        media.push(roomFixture);
        await database().collection('audioTracks').insertOne({ _id: id, uploadStatus: 'ready', publicationStatus: 'ready', roomFixture });
    }
    for (let index = 0; index < ROOM_LIMITS.songRequestsPerMember; index += 1) assert.equal((await requestSong(host, index)).outcome, 'applied');
    const revision = await outboxRevision(host);
    assert.equal((await requestSong(host, 0)).outcome, 'noop');
    assert.equal((await requestSong(host, 5)).code, 'room_request_capacity');
    assert.equal(await outboxRevision(host), revision);
    for (let index = 0; index < 3; index += 1) {
        const guest = await person(`guest_${index}`); await friendship(host, guest); await join(host, guest);
        for (let mediaIndex = 0; mediaIndex < 5; mediaIndex += 1) assert.equal((await requestSong(guest, mediaIndex)).outcome, 'applied');
    }
    assert.equal((await community(host)).requests.length, ROOM_LIMITS.songRequests);
    const extra = await person('extra'); await friendship(host, extra); await join(host, extra);
    const before = await community(host);
    assert.equal((await requestSong(extra)).code, 'room_request_capacity');
    assert.deepEqual(await community(host), before);
});

for (const rival of ['acceptSongRequest', 'reorderQueue', 'next'] as const) {
    test(`concurrent acceptance and ${rival} commit one observed queue edit without replaying the loser`, async () => {
        const { host, guest } = await pair(); await requestSong(guest, 1); await requestSong(guest, 2);
        const requests = (await community(host)).requests; const before = await snapshot(host);
        const first = control(host, before, 'acceptSongRequest', { requestId: requests[0].requestId });
        const second = rival === 'acceptSongRequest' ? control(host, before, rival, { requestId: requests[1].requestId })
            : rival === 'reorderQueue' ? control(host, before, rival, { entryIds: [...before.queue].reverse().map(entry => entry.entryId) })
                : control(host, before, rival);
        const outcomes = await Promise.all([api.mutate(host.actor, first), api.mutate(host.actor, second)]);
        assert.equal(outcomes.filter(value => value.outcome === 'applied').length, 1);
        assert.equal(outcomes.filter(value => value.outcome === 'rejected' && ['stale_queue', 'stale_playback'].includes(value.code ?? '')).length, 1);
        const after = await snapshot(host);
        const loser = outcomes[0].outcome === 'rejected' ? first : second;
        assert.equal((await api.mutate(host.actor, loser)).replayed, true);
        assert.deepEqual(await snapshot(host), after);
        assert.ok((await community(host)).requests.length >= 1);
    });
}

for (const action of ['leave', 'kick', 'block', 'deactivate', 'delete'] as const) {
    test(`${action} removes pending recommendations and attribution atomically without deleting accepted queue entries`, async () => {
        const { host, guest } = await pair(); await requestSong(guest, 1);
        assert.equal((await reaction(guest)).outcome, 'applied');
        await api.mutate(host.actor, control(host, await snapshot(host), 'acceptSongRequest', { requestId: (await community(host)).requests[0].requestId }));
        await requestSong(guest, 2); const before = await snapshot(host); const previousMember = (await snapshot(guest)).self.memberId;
        if (action === 'leave') await api.mutate(guest.actor, command(guest, { ...memberBody(await snapshot(guest)), action }));
        else if (action === 'kick') await api.mutate(host.actor, command(host, { ...memberBody(before), action, targetMemberId: previousMember }));
        else if (action === 'block') await social.mutate(host.actor, { ...identity(host.scope), action, targetSocialId: guest.profile.socialId });
        else if (action === 'deactivate') await social.mutate(guest.actor, { ...identity(guest.scope), action });
        else {
            await assert.rejects(deleteListenerAccountData(guest.actor.userId, { afterSocialCleanup: async () => { throw new Error('synthetic recommendation rollback'); } }), /synthetic recommendation rollback/);
            assert.equal((await community(host)).requests.length, 1);
            assert.equal((await community(host)).queueCredits.at(-1)?.requestedBy?.socialId, guest.profile.socialId);
            assert.equal((await deleteListenerAccountData(guest.actor.userId)).status, 'deleted');
        }
        const after = await snapshot(host); const visible = await community(host);
        assert.deepEqual(after.queue, before.queue); assert.deepEqual(after.timeline, before.timeline);
        assert.deepEqual(visible.requests, []); assert.equal(visible.queueCredits.at(-1)?.requestedBy, null);
        const persisted = await roomDocuments().findOne({ _id: before.roomId });
        assert.equal(JSON.stringify(persisted).includes(previousMember), false);
        if (action === 'leave') {
            await join(host, guest);
            assert.notEqual((await snapshot(guest)).self.memberId, previousMember);
            assert.equal((await community(host)).queueCredits.at(-1)?.requestedBy, null);
        }
    });
}

test('host transfer clears the departed host recommendations and credits while End clears the entire community', async () => {
    const { host, guest } = await pair(); await requestSong(host, 1); await requestSong(guest, 2);
    const before = await snapshot(host); const guestBefore = await snapshot(guest);
    await api.mutate(host.actor, command(host, { ...memberBody(before), action: 'offerTransfer', expectedControlGeneration: before.controlGeneration,
        targetMemberId: guestBefore.self.memberId, targetControllerGeneration: guestBefore.self.controllerGeneration }));
    const offer = (await snapshot(guest)).transferOffer!;
    await api.mutate(guest.actor, command(guest, { ...memberBody(guestBefore), action: 'acceptTransfer', offerId: offer.offerId }));
    const value = await community(guest);
    assert.equal(value.requests.length, 1); assert.equal(value.requests[0].requestedBy.socialId, guest.profile.socialId);
    assert.ok(value.queueCredits.every(credit => credit.requestedBy === null));
    assert.ok(value.events.every(event => event.actor?.socialId !== host.profile.socialId));
    assert.equal(value.events.at(-1)?.kind, 'hostChanged'); assert.equal(value.events.at(-1)?.actor?.socialId, guest.profile.socialId);
    const after = await snapshot(guest);
    await api.mutate(guest.actor, command(guest, { ...memberBody(after), action: 'end' }));
    const persisted = await roomDocuments().findOne({ _id: after.roomId });
    assert.deepEqual(persisted?.songRequests, []); assert.deepEqual(persisted?.queue, []); assert.deepEqual(persisted?.events, []);
    await assert.rejects(api.community(guest.actor, after.roomId), isError('room_unavailable'));
});

test('request-only media invalidation is transactional, clears pending recommendations, and preserves the queue timeline', async () => {
    const { host, guest } = await pair(); const id = new ObjectId();
    const roomFixture = { ...media[0], mediaTrackId: id.toHexString(), title: 'Request-only audio' }; media.push(roomFixture);
    await database().collection('audioTracks').insertOne({ _id: id, uploadStatus: 'ready', publicationStatus: 'ready', roomFixture });
    await requestSong(guest, 3); const before = await snapshot(host); const visible = await community(host); const revision = await outboxRevision(host);
    await assert.rejects(transaction(async session => {
        await invalidateRoomsForMedia(id.toHexString(), session, now); throw new Error('synthetic media rollback');
    }), /synthetic media rollback/);
    assert.deepEqual(await community(host), visible); assert.equal(await outboxRevision(host), revision);
    await transaction(async session => {
        await database().collection('audioTracks').updateOne({ _id: id }, { $set: { uploadStatus: 'deleting' } }, { session });
        await invalidateRoomsForMedia(id.toHexString(), session, now);
    });
    assert.deepEqual((await community(host)).requests, []); assert.equal(await outboxRevision(host), revision);
    const after = await snapshot(host);
    assert.deepEqual(after.timeline, before.timeline); assert.deepEqual(after.queue, before.queue); assert.equal(after.queueRevision, before.queueRevision);
    assert.equal((await api.mutate(host.actor, control(host, after, 'acceptSongRequest', { requestId: visible.requests[0].requestId }))).code, 'room_request_unavailable');
});

test('acceptance rechecks the pinned media revision and never substitutes replacement bytes', async () => {
    const { host, guest } = await pair(); await requestSong(guest, 1);
    const value = await community(host); const before = await snapshot(host); const revision = await outboxRevision(host);
    await database().collection('audioTracks').updateOne({ _id: new ObjectId(media[1].mediaTrackId) }, { $set: { 'roomFixture.mediaRevision': 'mr_replaced' } });
    const intent = control(host, before, 'acceptSongRequest', { requestId: value.requests[0].requestId });
    assert.equal((await api.mutate(host.actor, intent)).code, 'room_media_unavailable');
    assert.deepEqual(await snapshot(host), before); assert.deepEqual((await community(host)).requests, []);
    assert.equal(await outboxRevision(host), revision);
    assert.equal((await api.mutate(host.actor, intent)).replayed, true);
});

test('a captured natural-end timer cannot reinterpret a later queue reorder', async () => {
    const host = await person('host'); await create(host);
    await api.mutate(host.actor, control(host, await snapshot(host), 'play')); await ready(host, await snapshot(host));
    const before = await snapshot(host); now += media[0].durationMs + ROOM_LIMITS.startLeadMs;
    let scheduled = false;
    const timer = service({ beforeSweepRoom: async () => {
        if (scheduled) return; scheduled = true;
        assert.equal((await api.mutate(host.actor, control(host, before, 'reorderQueue', {
            entryIds: [before.queue[0].entryId, before.queue[2].entryId, before.queue[1].entryId] }))).outcome, 'applied');
    } });
    await timer.sweep();
    assert.equal((await snapshot(host)).timeline!.entryId, before.timeline!.entryId);
    assert.equal((await community(host)).events.filter(event => event.kind === 'trackChanged').length, 0);
    await api.sweep(); assert.equal((await snapshot(host)).timeline!.entryId, before.queue[2].entryId);
    const advanced = (await community(host)).events.filter(event => event.kind === 'trackChanged');
    assert.equal(advanced.length, 1); assert.equal(advanced[0].actor, null);
    await api.sweep(); assert.equal((await community(host)).events.filter(event => event.kind === 'trackChanged').length, 1);
});

test('Everyone playback permission never grants queue moderation and recommendation epochs remain fenced', async () => {
    const { host, guest } = await pair(); await requestSong(guest);
    await api.mutate(host.actor, control(host, await snapshot(host), 'setControlMode', { mode: 'everyone' }));
    const state = await snapshot(guest); const request = (await community(guest)).requests[0];
    for (const [action, extra] of [
        ['acceptSongRequest', { requestId: request.requestId }],
        ['removeQueueEntry', { targetEntryId: state.queue[1].entryId }],
        ['reorderQueue', { entryIds: [...state.queue].reverse().map(entry => entry.entryId) }]
    ] as const) assert.equal((await api.mutate(guest.actor, control(guest, state, action, extra))).code, 'room_forbidden');
    assert.equal((await api.mutate(guest.actor, command(guest, { ...memberBody(state), action: 'requestSong',
        expectedEpoch: state.epoch + 1, mediaTrackId: media[1].mediaTrackId }))).code, 'stale_epoch');
    assert.equal((await requestSong(guest, 1)).outcome, 'applied');
    assert.equal((await community(guest)).requests.length, 2);
});

test('full queues retain recommendations on rejection and current-only queues cannot be emptied', async () => {
    const { host, guest } = await pair(); await requestSong(guest, 1);
    const before = await snapshot(host); const request = (await community(host)).requests[0];
    const stored = (await roomDocuments().findOne({ _id: before.roomId }))!;
    stored.queue = [stored.queue[0], ...Array.from({ length: ROOM_LIMITS.queue - 1 }, () => ({ ...stored.queue[1], entryId: randomUUID() }))];
    await roomDocuments().replaceOne({ _id: before.roomId }, stored);
    const state = await snapshot(host); const revision = await outboxRevision(host);
    assert.equal((await api.mutate(host.actor, control(host, state, 'acceptSongRequest', { requestId: request.requestId }))).code, 'room_queue_capacity');
    assert.equal((await community(host)).requests.length, 1); assert.equal(await outboxRevision(host), revision);
    assert.equal((await snapshot(host)).queue.length, ROOM_LIMITS.queue);
    await roomDocuments().updateOne({ _id: before.roomId }, { $set: { queue: [stored.queue[0]] } });
    const one = await snapshot(host);
    assert.equal((await api.mutate(host.actor, control(host, one, 'removeQueueEntry', { targetEntryId: one.queue[0].entryId }))).code, 'current_entry_required');
    assert.equal((await snapshot(host)).queue.length, 1);
});

test('recommendation acceptance retains its original identity after an uncertain commit and appends once', async () => {
    const { host, guest } = await pair(); await requestSong(guest, 1); const request = (await community(host)).requests[0];
    const before = await snapshot(host); const intent = control(host, before, 'acceptSongRequest', { requestId: request.requestId });
    let attempts = 0;
    const uncertain = service({ afterCommit: async () => { attempts += 1; throw new Error('synthetic acknowledgement loss'); } });
    await assert.rejects(uncertain.mutate(host.actor, intent), isError('mutation_outcome_unknown'));
    assert.equal(attempts, 1); assert.equal((await snapshot(host)).queue.length, before.queue.length + 1);
    assert.deepEqual(await social.outcome(host.actor, { scopeToken: intent.scopeToken, commandId: intent.commandId }),
        { commandId: intent.commandId, outcome: 'applied', replayed: true });
    assert.equal((await api.mutate(host.actor, intent)).replayed, true);
    assert.equal((await snapshot(host)).queue.length, before.queue.length + 1); assert.deepEqual((await community(host)).requests, []);
});

test('media deletion winning a recommendation admission race leaves no pending request or partial community change', async () => {
    const { host, guest } = await pair(); let removed = false;
    const racing = service({ beforeAccountFence: async () => {
        if (removed) return; removed = true;
        await transaction(async session => {
            await database().collection('audioTracks').updateOne({ _id: new ObjectId(media[1].mediaTrackId) }, { $set: { uploadStatus: 'deleting' } }, { session });
            await invalidateRoomsForMedia(media[1].mediaTrackId, session, now);
        });
    } });
    assert.equal((await requestSong(guest, 1, racing)).code, 'room_media_unavailable');
    assert.deepEqual((await community(host)).requests, []);
});

test('community resolves current aliases after profile changes and keeps admitted requests after friendship removal', async () => {
    const { host, guest } = await pair(); await requestSong(guest, 1);
    await api.mutate(host.actor, control(host, await snapshot(host), 'acceptSongRequest', { requestId: (await community(host)).requests[0].requestId }));
    await requestSong(guest, 2); const before = await snapshot(host); const revision = await outboxRevision(host);
    const profile = (await social.ownProfile(guest.actor))!;
    assert.equal((await social.mutate(guest.actor, { ...identity(guest.scope), action: 'profile', expectedRevision: profile.revision,
        handle: profile.handle, alias: 'New current alias', discoverable: false })).outcome, 'applied');
    const updated = await community(host);
    assert.equal(updated.requests[0].requestedBy.alias, 'New current alias');
    assert.equal(updated.queueCredits.at(-1)?.requestedBy?.alias, 'New current alias');
    assert.equal(await outboxRevision(host), revision); assert.deepEqual((await snapshot(host)).timeline, before.timeline);
    assert.ok(updated.revision > before.revision);
    assert.equal(updated.events.find(event => event.actor?.socialId === guest.profile.socialId)?.actor?.alias, 'New current alias');
    const relationship = (await social.relationship(host.actor, guest.profile.socialId))!;
    await social.mutate(host.actor, { ...identity(host.scope), action: 'remove', targetSocialId: guest.profile.socialId, expectedRevision: relationship.revision });
    assert.equal((await community(host)).requests.length, 1);
});

test('recommendation titles are bounded at capture and oversized community evidence fails closed', async () => {
    const { host, guest } = await pair();
    await database().collection('audioTracks').updateOne({ _id: new ObjectId(media[1].mediaTrackId) }, { $set: { 'roomFixture.title': '🎵'.repeat(400) } });
    await requestSong(guest, 1); const value = await community(host);
    assert.equal([...value.requests[0].title].length, 160);
    const persisted = (await roomDocuments().findOne({ _id: value.roomId }))!;
    assert.equal([...persisted.songRequests![0].title].length, 160);
    await roomDocuments().updateOne({ _id: value.roomId }, { $set: { 'songRequests.0.title': 'x'.repeat(ROOM_LIMITS.snapshotBytes) } });
    await assert.rejects(api.community(host.actor, value.roomId), isError('room_snapshot_too_large'));
    await roomDocuments().updateOne({ _id: value.roomId }, { $set: { songRequests: Array.from({ length: ROOM_LIMITS.songRequests + 1 }, () => persisted.songRequests![0]) } });
    await assert.rejects(api.community(host.actor, value.roomId), isError('room_snapshot_too_large'));
});

test('real friend invite admission is private, bounded, and separated from the local queue', async () => {
    const { host, guest } = await pair(); const outsider = await person('outsider');
    const state = await snapshot(host);
    assert.equal(state.members.length, 2); assert.equal(state.controlMode, 'hostOnly');
    assert.equal(new Set(state.queue.map(value => value.entryId)).size, 3);
    assert.deepEqual(state.queue.map(value => value.mediaTrackId), media.map(value => value.mediaTrackId));
    assert.equal(await api.room(outsider.actor, state.roomId), null);
    assert.deepEqual(await api.invitations(outsider.actor), []);
    assert.equal((await api.mutate(outsider.actor, command(outsider, { action: 'invite', ...memberBody(state), targetSocialId: guest.profile.socialId }))).code, 'room_unavailable');
    const publicJson = JSON.stringify([state, await api.eligibleMedia(host.actor)]);
    for (const who of [host, guest]) for (const value of [who.actor.userId, who.actor.sessionId, who.actor.clientId, '@private.invalid']) assert.equal(publicJson.includes(value), false);
    assert.equal(await database().collection('socialRoomParticipation').countDocuments({}), 2);
    assert.equal((await api.eligibleMedia(host.actor)).length, 3);
});

test('invitation DTO hides room and membership before acceptance; stale invitations cannot join', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); const state = await create(host);
    const first = await invite(host, guest);
    assert.deepEqual(Object.keys(first).sort(), ['expiresAtMs', 'generation', 'invitationId', 'inviter']);
    assert.equal(JSON.stringify(first).includes(state.roomId), false);
    const replacement = await invite(host, guest); assert.notEqual(first.invitationId, replacement.invitationId);
    assert.equal((await api.mutate(guest.actor, command(guest, { action: 'acceptInvitation', invitationId: first.invitationId, generation: first.generation }))).code, 'invitation_unavailable');
    assert.equal(await api.currentRoom(guest.actor), null);
});

test('invitation links are recipient-bound reads and outgoing metadata requires the current host controller', async () => {
    const { host, guest } = await pair(); const recipient = await person('recipient'); const outsider = await person('outsider');
    await friendship(host, recipient); const value = await invite(host, recipient); const room = await snapshot(host);
    const receiptCount = await database().collection('socialMutations').countDocuments({});
    assert.deepEqual(await api.invitation(recipient.actor, value.invitationId), value);
    for (const actor of [host.actor, guest.actor, outsider.actor]) {
        assert.equal(await api.invitation(actor, value.invitationId), null);
        assert.equal(await api.invitation(actor, 'i_missing'), null);
    }
    assert.deepEqual(await api.outgoingInvitations(host.actor, room.roomId), [{ invitationId: value.invitationId,
        generation: value.generation, recipientSocialId: recipient.profile.socialId, expiresAtMs: value.expiresAtMs }]);
    await assert.rejects(api.outgoingInvitations(guest.actor, room.roomId), isError('room_forbidden'));
    await assert.rejects(api.outgoingInvitations({ ...host.actor, clientId: randomUUID() }, room.roomId), isError('room_forbidden'));
    await assert.rejects(api.outgoingInvitations(outsider.actor, room.roomId), isError('room_unavailable'));
    assert.equal(await api.currentRoom(recipient.actor), null);
    assert.equal((await snapshot(host)).revision, room.revision);
    assert.equal(await database().collection('socialMutations').countDocuments({}), receiptCount);
    const observer = { ...host, actor: { ...host.actor, clientId: randomUUID() } };
    await api.mutate(observer.actor, command(observer, { action: 'takeControl', ...memberBody(room) }));
    await assert.rejects(api.outgoingInvitations(host.actor, room.roomId), isError('room_forbidden'));
    assert.equal((await api.outgoingInvitations(observer.actor, room.roomId)).length, 1);
});

test('invitation link replacement, logical expiry and disabled participation preserve read-only semantics', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); const room = await create(host);
    const original = await invite(host, guest); const replacement = await invite(host, guest);
    assert.equal(await api.invitation(guest.actor, original.invitationId), null);
    assert.deepEqual(await api.invitation(guest.actor, replacement.invitationId), replacement);
    enabled = false;
    assert.deepEqual(await api.invitation(guest.actor, replacement.invitationId), replacement);
    assert.equal((await api.outgoingInvitations(host.actor, room.roomId))[0].invitationId, replacement.invitationId);
    await database().collection('socialInvitations').updateOne({ invitationId: replacement.invitationId }, { $set: { expiresAt: new Date(now) } });
    assert.equal(await api.invitation(guest.actor, replacement.invitationId), null);
    assert.deepEqual(await api.outgoingInvitations(host.actor, room.roomId), []);
    assert.equal(await database().collection('socialInvitations').countDocuments({}), 1, 'Logical expiry must not depend on TTL deletion.');
});

test('invitation detail and preview share lifecycle filtering before the bounded preview fills', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); const room = await create(host);
    const value = await invite(host, guest);
    const source = await database().collection('socialInvitations').findOne({ invitationId: value.invitationId }); assert.ok(source);
    await database().collection('socialInvitations').insertMany(Array.from({ length: ROOM_LIMITS.invitations }, (_, index) => ({ ...source,
        _id: new ObjectId(), invitationId: `i_stale_${index}`, roomId: `r_closed_${index}`, createdAt: new Date(now + index + 1) })));
    assert.deepEqual(await api.invitations(guest.actor), [value]);
    assert.equal(await api.invitation(guest.actor, 'i_stale_0'), null);
    await roomDocuments().updateOne({ _id: room.roomId }, { $set: { hostMembershipId: 'm_replaced_host' } });
    assert.equal(await api.invitation(guest.actor, value.invitationId), null);
    assert.deepEqual(await api.invitations(guest.actor), []);
});

for (const action of ['accept', 'decline', 'end', 'removeFriend', 'block', 'deactivate', 'delete'] as const) {
    test(`invitation link becomes unavailable after committed ${action}`, async () => {
        const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); const room = await create(host);
        const value = await invite(host, guest);
        if (action === 'accept' || action === 'decline') {
            await api.mutate(guest.actor, command(guest, { action: action === 'accept' ? 'acceptInvitation' : 'declineInvitation',
                invitationId: value.invitationId, generation: value.generation }));
        } else if (action === 'end') await api.mutate(host.actor, command(host, { action: 'end', ...memberBody(room) }));
        else if (action === 'delete') assert.equal((await deleteListenerAccountData(host.actor.userId)).status, 'deleted');
        else if (action === 'deactivate') await social.mutate(host.actor, { ...identity(host.scope), action: 'deactivate' });
        else if (action === 'block') await social.mutate(guest.actor, { ...identity(guest.scope), action: 'block', targetSocialId: host.profile.socialId });
        else {
            const relationship = await social.relationship(host.actor, guest.profile.socialId); assert.ok(relationship);
            await social.mutate(host.actor, { ...identity(host.scope), action: 'remove', targetSocialId: guest.profile.socialId, expectedRevision: relationship.revision });
        }
        assert.equal(await api.invitation(guest.actor, value.invitationId), null);
        assert.deepEqual(await api.invitations(guest.actor), []);
    });
}

test('invitation link reads retain actual session fences and hide inactive recipients', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); const room = await create(host);
    const value = await invite(host, guest);
    await database().collection('socialProfiles').updateOne({ _id: guest.profile.socialId }, { $set: { active: false } });
    assert.equal(await api.invitation(guest.actor, value.invitationId), null);
    assert.deepEqual(await api.outgoingInvitations(host.actor, room.roomId), []);
    await AuthSession.revokeById(guest.actor.userId, guest.actor.sessionId);
    await assert.rejects(api.invitation(guest.actor, value.invitationId), isError('social_session_required'));
    await assert.rejects(api.invitation(host.actor, '../rooms/current'), isError('invalid_request'));
    await assert.rejects(api.outgoingInvitations(host.actor, 'r_room?account=other'), isError('invalid_request'));
});

test('retained invitation rows cannot expose a closed room, inactive sender or revoked friendship', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); const room = await create(host);
    const value = await invite(host, guest);
    const unavailable = async () => {
        assert.equal(await api.invitation(guest.actor, value.invitationId), null);
        assert.deepEqual(await api.invitations(guest.actor), []);
    };
    await roomDocuments().updateOne({ _id: room.roomId }, { $set: { state: 'closed' } }); await unavailable();
    await roomDocuments().updateOne({ _id: room.roomId }, { $set: { state: 'open', expiresAt: new Date(now) } }); await unavailable();
    await roomDocuments().updateOne({ _id: room.roomId }, { $set: { expiresAt: new Date(now + 60_000) } });
    await database().collection('socialProfiles').updateOne({ _id: host.profile.socialId }, { $set: { active: false } }); await unavailable();
    await database().collection('socialProfiles').updateOne({ _id: host.profile.socialId }, { $set: { active: true } });
    const accountIds = [host.actor.userId, guest.actor.userId].sort();
    await database().collection('socialRelationships').updateOne({ accountIds }, { $set: { state: 'none' } }); await unavailable();
    assert.deepEqual(await api.outgoingInvitations(host.actor, room.roomId), []);
});

test('a recipient in another room can inspect and decline without leaving or joining automatically', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); await create(host);
    const ownRoom = await create(guest); const value = await invite(host, guest);
    assert.deepEqual(await api.invitation(guest.actor, value.invitationId), value);
    assert.equal((await snapshot(guest)).roomId, ownRoom.roomId);
    const acceptance = command(guest, { action: 'acceptInvitation', invitationId: value.invitationId, generation: value.generation });
    assert.equal((await api.mutate(guest.actor, acceptance)).code, 'already_in_room');
    assert.equal((await api.mutate(guest.actor, acceptance)).replayed, true);
    assert.deepEqual(await api.invitation(guest.actor, value.invitationId), value);
    await api.mutate(guest.actor, command(guest, { action: 'declineInvitation', invitationId: value.invitationId, generation: value.generation }));
    assert.equal(await api.invitation(guest.actor, value.invitationId), null);
    assert.equal((await snapshot(guest)).roomId, ownRoom.roomId);
    assert.equal((await snapshot(guest)).revision, ownRoom.revision);
});

test('two concurrent room creations retain exactly one account participation', async () => {
    const host = await person('host');
    const results = await Promise.all([1, 2].map(() => api.mutate(host.actor, command(host, { action: 'create', mediaTrackIds: [media[0].mediaTrackId] }))));
    assert.deepEqual(results.map(value => value.outcome).sort(), ['applied', 'rejected']);
    assert.equal(results.find(value => value.outcome === 'rejected')?.code, 'already_in_room');
    assert.equal(await roomDocuments().countDocuments({ state: 'open' }), 1);
    assert.equal(await database().collection('socialRoomParticipation').countDocuments({}), 1);
});

test('host-only controls deny guests; switching to everyone invalidates stale permissions', async () => {
    const { host, guest } = await pair(); const before = await snapshot(guest);
    assert.equal((await api.mutate(guest.actor, control(guest, before, 'next'))).code, 'room_forbidden');
    assert.equal((await api.mutate(host.actor, control(host, await snapshot(host), 'setControlMode', { mode: 'everyone' }))).outcome, 'applied');
    assert.equal((await api.mutate(guest.actor, control(guest, before, 'next'))).code, 'stale_permission');
    assert.equal((await api.mutate(guest.actor, control(guest, await snapshot(guest), 'next'))).outcome, 'applied');
    assert.equal((await snapshot(host)).timeline?.entryId, before.queue[1].entryId);
});

test('simultaneous Next commands commit at most one advance and never reinterpret the losing intent', async () => {
    const { host, guest } = await pair(); await api.mutate(host.actor, control(host, await snapshot(host), 'setControlMode', { mode: 'everyone' }));
    const hostState = await snapshot(host); const guestState = await snapshot(guest);
    const first = control(host, hostState, 'next'); const second = control(guest, guestState, 'next');
    const results = await Promise.all([api.mutate(host.actor, first), api.mutate(guest.actor, second)]);
    assert.deepEqual(results.map(value => value.outcome).sort(), ['applied', 'rejected']);
    assert.equal(results.find(value => value.outcome === 'rejected')?.code, 'stale_playback');
    const after = await snapshot(host); assert.equal(after.timeline?.entryId, hostState.queue[1].entryId);
    assert.equal(after.timeline?.playbackGeneration, hostState.timeline!.playbackGeneration + 1);
    const loser = results[0].outcome === 'rejected' ? { who: host, command: first } : { who: guest, command: second };
    assert.equal((await api.mutate(loser.who.actor, loser.command)).replayed, true);
    assert.equal((await snapshot(host)).revision, after.revision);
});

test('simultaneous distinct Select commands leave exactly the first committed song', async () => {
    const { host, guest } = await pair(); await api.mutate(host.actor, control(host, await snapshot(host), 'setControlMode', { mode: 'everyone' }));
    const a = await snapshot(host); const b = await snapshot(guest);
    const results = await Promise.all([api.mutate(host.actor, control(host, a, 'select', { targetEntryId: a.queue[1].entryId })),
        api.mutate(guest.actor, control(guest, b, 'select', { targetEntryId: b.queue[2].entryId }))]);
    const winningIndex = results.findIndex(value => value.outcome === 'applied');
    assert.equal(results.filter(value => value.outcome === 'applied').length, 1);
    assert.equal((await snapshot(host)).timeline?.entryId, a.queue[winningIndex + 1].entryId);
});

test('readiness starts only the captured generation with one future anchor and duplicate reports have no echo', async () => {
    const { host, guest } = await pair(); await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    const a = await snapshot(host); const b = await snapshot(guest); await ready(host, a);
    assert.equal((await snapshot(host)).timeline?.state, 'preparing');
    await ready(guest, b);
    const playing = await snapshot(host);
    assert.equal(playing.timeline?.state, 'playing'); assert.equal(playing.timeline?.anchorServerTimeMs, now + ROOM_LIMITS.startLeadMs);
    assert.equal(playing.timeline?.playbackGeneration, a.timeline?.playbackGeneration);
    assert.ok(playing.members.every(value => value.ready));
    await ready(guest, b); assert.equal((await snapshot(host)).revision, playing.revision);
});

test('readiness deadline leaves unready members unsynchronized; zero ready clients remain paused', async () => {
    const { host, guest } = await pair(); await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    const first = await snapshot(host); now += ROOM_LIMITS.preparationMs; await api.sweep();
    let state = await snapshot(host); assert.equal(state.timeline?.state, 'paused'); assert.equal(state.timeline?.playbackGeneration, first.timeline?.playbackGeneration);
    await api.mutate(host.actor, control(host, state, 'play')); state = await snapshot(host);
    await ready(guest, await snapshot(guest)); now += ROOM_LIMITS.preparationMs; await api.sweep();
    const after = await snapshot(host); assert.equal(after.timeline?.state, 'playing');
    assert.equal(after.members.find(value => value.memberId === after.hostMemberId)?.ready, false);
    assert.equal(after.members.find(value => value.memberId !== after.hostMemberId)?.ready, true);
});

test('a locally paused but present host does not prevent a ready guest from starting', async () => {
    const { host, guest } = await pair(); await connect(host, await snapshot(host), true);
    await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    const a = await snapshot(host); const b = await snapshot(guest);
    assert.deepEqual(a.preparation?.cohortMembershipIds, [b.self.memberId]);
    await ready(guest, b); assert.equal((await snapshot(host)).timeline?.state, 'playing');
});

test('same-session tabs have one controller and takeover fences old controls, readiness, and disconnects', async () => {
    const host = await person('host'); const initial = await create(host);
    const tab = { ...host, actor: { ...host.actor, clientId: randomUUID() } };
    assert.equal((await snapshot(tab)).self.isController, false);
    assert.equal((await api.mutate(tab.actor, control(tab, initial, 'play'))).code, 'stale_controller');
    assert.equal((await api.mutate(tab.actor, command(tab, { action: 'takeControl', ...memberBody(initial) }))).outcome, 'applied');
    const taken = await snapshot(tab); assert.equal(taken.self.controllerGeneration, initial.self.controllerGeneration + 1);
    assert.equal(taken.members[0].connected, false); await connect(tab, taken);
    assert.equal((await api.mutate(host.actor, control(host, initial, 'next'))).code, 'stale_controller');
    await assert.rejects(connect(host, initial), isError('stale_controller'));
    await api.disconnected(host.actor); assert.equal((await snapshot(tab)).members[0].connected, true);
});

test('host disconnect stops new playback intents, pauses after grace, and returning never auto-resumes', async () => {
    const { host, guest } = await pair(); await playPair(host, guest);
    await api.disconnected(host.actor);
    assert.equal((await api.mutate(host.actor, control(host, await snapshot(host), 'next'))).code, 'host_absent');
    now += ROOM_LIMITS.hostGraceMs; await connect(guest, await snapshot(guest)); await api.sweep();
    const suspended = await snapshot(guest); assert.equal(suspended.status, 'suspended'); assert.equal(suspended.timeline?.state, 'paused');
    await connect(host, await snapshot(host)); const returned = await snapshot(host);
    assert.equal(returned.timeline?.state, 'paused'); assert.equal(returned.status, 'suspended');
    assert.equal(returned.hostAbsenceDeadlineMs, null);
    await api.mutate(host.actor, control(host, returned, 'play')); assert.equal((await snapshot(host)).status, 'open');
});

test('five minute host absence closes the room and releases all exact participation slots', async () => {
    const { host, guest } = await pair(); const before = await snapshot(host);
    await api.disconnected(host.actor); now += ROOM_LIMITS.hostCloseMs; await api.sweep();
    assert.equal(await api.currentRoom(host.actor), null); assert.equal(await api.currentRoom(guest.actor), null);
    assert.equal(await database().collection('socialRoomParticipation').countDocuments({}), 0);
    const closed = await roomDocuments().findOne({ _id: before.roomId });
    assert.equal(closed?.state, 'closed'); assert.deepEqual(closed?.members, []); assert.deepEqual(closed?.queue, []);
});

test('host exit requires consent transfer or End, while guest Leave preserves the room', async () => {
    const { host, guest } = await pair(); const a = await snapshot(host); const b = await snapshot(guest);
    assert.equal((await api.mutate(host.actor, command(host, { action: 'leave', ...memberBody(a) }))).code, 'host_exit_required');
    await api.mutate(host.actor, command(host, { action: 'offerTransfer', ...memberBody(a), expectedControlGeneration: a.controlGeneration,
        targetMemberId: b.self.memberId, targetControllerGeneration: b.self.controllerGeneration }));
    const offer = (await snapshot(guest)).transferOffer!; assert.ok(offer);
    await api.mutate(guest.actor, command(guest, { action: 'acceptTransfer', ...memberBody(b), offerId: offer.offerId }));
    assert.equal(await api.currentRoom(host.actor), null); const transferred = await snapshot(guest);
    assert.equal(transferred.hostMemberId, b.self.memberId); assert.equal(transferred.members.length, 1);
    assert.equal(transferred.controlGeneration, a.controlGeneration + 1);
    assert.equal((await api.mutate(host.actor, command(host, { action: 'end', ...memberBody(a) }))).code, 'room_unavailable');
    await api.mutate(guest.actor, command(guest, { action: 'end', ...memberBody(transferred) }));
    assert.equal(await api.currentRoom(guest.actor), null);
});

test('transfer offers expire and cannot survive the target controller taking over', async () => {
    const { host, guest } = await pair(); const a = await snapshot(host); const b = await snapshot(guest);
    const offer = () => api.mutate(host.actor, command(host, { action: 'offerTransfer', ...memberBody(a), expectedControlGeneration: a.controlGeneration,
        targetMemberId: b.self.memberId, targetControllerGeneration: b.self.controllerGeneration }));
    await offer(); const first = (await snapshot(guest)).transferOffer!; now += ROOM_LIMITS.transferMs;
    assert.equal((await api.mutate(guest.actor, command(guest, { action: 'acceptTransfer', ...memberBody(b), offerId: first.offerId }))).code, 'transfer_unavailable');
    await connect(host, a); await connect(guest, b); await offer();
    const second = (await snapshot(guest)).transferOffer!;
    const other = { ...guest, actor: { ...guest.actor, clientId: randomUUID() } };
    await api.mutate(other.actor, command(other, { action: 'takeControl', ...memberBody(b) }));
    assert.equal((await api.mutate(other.actor, command(other, { action: 'acceptTransfer', ...memberBody(b), offerId: second.offerId }))).code, 'transfer_unavailable');
});

test('feature disable pauses rooms, denies new authority, and preserves safety exit and shared pause', async () => {
    const { host, guest } = await pair(); await playPair(host, guest); enabled = false;
    await assert.rejects(api.mutate(host.actor, control(host, await snapshot(host), 'next')), isError('rooms_disabled'));
    assert.equal((await api.mutate(host.actor, control(host, await snapshot(host), 'pause'))).outcome, 'applied');
    await api.sweep(); assert.equal((await snapshot(host)).timeline?.state, 'paused');
    assert.equal((await api.mutate(guest.actor, command(guest, { action: 'leave', ...memberBody(await snapshot(guest)) }))).outcome, 'applied');
    assert.equal((await api.mutate(host.actor, command(host, { action: 'end', ...memberBody(await snapshot(host)) }))).outcome, 'applied');
    assert.equal(await api.currentRoom(host.actor), null);
});

test('authority epoch rotation cancels preparation and makes stale controls harmless', async () => {
    const host = await person('host'); const initial = await create(host);
    await api.mutate(host.actor, control(host, initial, 'play')); const old = await snapshot(host); epoch += 1;
    await api.sweep(); const state = await snapshot(host);
    assert.equal(state.epoch, epoch); assert.equal(state.timeline?.state, 'paused'); assert.equal(state.preparation, null);
    assert.equal(state.timeline?.playbackGeneration, old.timeline!.playbackGeneration + 1);
    assert.equal((await api.mutate(host.actor, control(host, old, 'next'))).code, 'stale_epoch');
    await ready(host, old); assert.equal((await snapshot(host)).revision, state.revision);
});

test('source replacement invalidates the pinned queue atomically and cannot leave preparation running', async () => {
    const host = await person('host'); await create(host); await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    const old = await snapshot(host);
    await transaction(async session => {
        await database().collection('audioTracks').updateOne({ _id: new ObjectId(media[0].mediaTrackId) }, { $set: { uploadStatus: 'deleting' } }, { session });
        await invalidateRoomsForMedia(media[0].mediaTrackId, session, now);
    });
    const state = await snapshot(host); assert.equal(state.preparation, null); assert.equal(state.timeline?.state, 'paused');
    assert.equal(state.queueRevision, old.queueRevision + 1);
    assert.equal((await api.mutate(host.actor, control(host, state, 'play'))).code, 'room_media_unavailable');
    await ready(host, old); assert.equal((await snapshot(host)).revision, state.revision);
});

test('block/deactivation lifecycle work enlists one transaction and rolls back with its caller', async () => {
    const { host, guest } = await pair(); const before = await snapshot(host);
    await assert.rejects(transaction(async session => {
        await applyRoomSafety({ kind: 'block', accountId: host.actor.userId, targetAccountId: guest.actor.userId }, session, now);
        throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    assert.equal((await snapshot(host)).members.length, 2); assert.equal((await snapshot(host)).revision, before.revision);
    await transaction(session => applyRoomSafety({ kind: 'block', accountId: host.actor.userId, targetAccountId: guest.actor.userId }, session, now));
    assert.equal(await api.currentRoom(guest.actor), null); assert.equal((await snapshot(host)).members.length, 1);
    await transaction(session => applyRoomSafety({ kind: 'deactivate', accountId: host.actor.userId }, session, now));
    assert.equal(await api.currentRoom(host.actor), null);
});

test('session revocation is fenced against read/control and freezes host readiness immediately', async () => {
    const { host, guest } = await pair(); await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    await transaction(async session => {
        await database().collection('authSessions').updateOne({ _id: new ObjectId(host.actor.sessionId) }, { $set: { revokedAt: new Date(now) } }, { session });
        await applyRoomSafety({ kind: 'session', accountId: host.actor.userId, sessionId: host.actor.sessionId }, session, now);
    });
    await assert.rejects(api.currentRoom(host.actor), isError('social_session_required'));
    const state = await snapshot(guest); assert.equal(state.timeline?.state, 'paused'); assert.equal(state.preparation, null);
    assert.equal(state.members.find(value => value.memberId === state.hostMemberId)?.connected, false);
});

test('unknown committed outcomes retain same-key evidence without automatically executing another command', async () => {
    const host = await person('host'); await create(host); const state = await snapshot(host);
    const intent = control(host, state, 'next'); let commits = 0;
    const uncertain = service({ beforeCommit: async session => {
        commits += 1; await session.commitTransaction();
        const error = new MongoServerError({ message: 'synthetic lost commit acknowledgement' });
        error.addErrorLabel('UnknownTransactionCommitResult'); error.addErrorLabel('TransientTransactionError'); throw error;
    } });
    await assert.rejects(uncertain.mutate(host.actor, intent), isError('mutation_outcome_unknown'));
    assert.equal(commits, 1); assert.equal((await snapshot(host)).timeline?.entryId, state.queue[1].entryId);
    assert.deepEqual(await social.outcome(host.actor, { scopeToken: intent.scopeToken, commandId: intent.commandId }),
        { commandId: intent.commandId, outcome: 'applied', replayed: true });
    assert.equal((await api.mutate(host.actor, intent)).replayed, true);
    await assert.rejects(api.mutate(host.actor, { ...intent, action: 'previous' } as RoomCommand), isError('idempotency_conflict'));
});

test('five known-aborted room retries preserve the original selection and commit exactly once', async () => {
    const host = await person('host'); await create(host); const before = await snapshot(host);
    const intent = control(host, before, 'select', { targetEntryId: before.queue[1].entryId });
    const original = structuredClone(intent);
    let attempts = 0;
    const retrying = service({ beforeCommit: async () => {
        attempts += 1;
        if (attempts <= 5) {
            if (attempts === 1 && 'targetEntryId' in intent) intent.targetEntryId = before.queue[2].entryId;
            const error = new MongoServerError({ message: 'synthetic room contention', code: 112 });
            error.addErrorLabel('TransientTransactionError'); throw error;
        }
    } });
    assert.equal((await retrying.mutate(host.actor, intent)).outcome, 'applied');
    assert.equal(attempts, 6);
    const after = await snapshot(host);
    assert.equal(after.timeline?.entryId, before.queue[1].entryId);
    assert.equal(after.timeline?.playbackGeneration, before.timeline!.playbackGeneration + 1);
    assert.equal(await database().collection('socialMutations').countDocuments({ commandId: original.commandId }), 1);
    assert.equal((await api.mutate(host.actor, original)).replayed, true);
});

test('persistent known-aborted room contention exhausts six attempts without changing state or receipts', async () => {
    const host = await person('host'); await create(host); const before = await snapshot(host);
    const intent = control(host, before, 'next');
    let attempts = 0;
    const failing = service({ beforeCommit: async () => {
        attempts += 1;
        const error = new MongoServerError({ message: 'synthetic persistent room contention', code: 112 });
        error.addErrorLabel('TransientTransactionError'); throw error;
    } });
    await assert.rejects(failing.mutate(host.actor, intent), isError('room_unavailable'));
    assert.equal(attempts, 6);
    assert.deepEqual(await snapshot(host), before);
    assert.equal(await database().collection('socialMutations').countDocuments({ commandId: intent.commandId }), 0);
    assert.equal((await api.mutate(host.actor, intent)).outcome, 'applied');
});

test('a transient label after a room commit cannot replay the already committed action', async () => {
    const host = await person('host'); await create(host); const before = await snapshot(host);
    const intent = control(host, before, 'next');
    let attempts = 0;
    const uncertain = service({ afterCommit: async () => {
        attempts += 1;
        const error = new MongoServerError({ message: 'synthetic post-commit transient label', code: 112 });
        error.addErrorLabel('TransientTransactionError'); throw error;
    } });
    await assert.rejects(uncertain.mutate(host.actor, intent), isError('mutation_outcome_unknown'));
    assert.equal(attempts, 1);
    assert.equal((await snapshot(host)).timeline?.playbackGeneration, before.timeline!.playbackGeneration + 1);
    assert.equal(await database().collection('socialMutations').countDocuments({ commandId: intent.commandId }), 1);
    assert.equal((await api.mutate(host.actor, intent)).replayed, true);
});

test('scope expiry never reapplies a command; retained social outcome remains available after expiry', async () => {
    const host = await person('host'); const intent = command(host, { action: 'create', mediaTrackIds: [media[0].mediaTrackId] });
    await api.mutate(host.actor, intent); now = Date.parse(host.scope.expiresAt);
    await assert.rejects(api.mutate(host.actor, intent), isError('mutation_scope_expired'));
    assert.equal((await social.outcome(host.actor, { scopeToken: intent.scopeToken, commandId: intent.commandId })).outcome, 'applied');
    assert.equal(await roomDocuments().countDocuments({}), 1);
});

test('admission does not claim a live socket and cannot start before a trusted heartbeat', async () => {
    const host = await person('host');
    await api.mutate(host.actor, command(host, { action: 'create', mediaTrackIds: [media[0].mediaTrackId] }));
    const state = await snapshot(host); assert.equal(state.members[0].connected, false);
    assert.equal((await api.mutate(host.actor, control(host, state, 'play'))).code, 'host_absent');
    await connect(host, state);
    assert.equal((await api.mutate(host.actor, control(host, await snapshot(host), 'play'))).outcome, 'applied');
});

test('late joining readiness is individual, sequence fenced, and preserves the shared playing anchor', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); await create(host);
    await api.mutate(host.actor, control(host, await snapshot(host), 'play')); await ready(host, await snapshot(host));
    const playing = await snapshot(host); const joined = await join(host, guest);
    assert.equal(joined.members.find(value => value.memberId === joined.self.memberId)?.ready, false);
    const report = { ...memberBody(joined), controllerGeneration: joined.self.controllerGeneration, expectedEpoch: joined.epoch,
        preparationId: 'current', playbackGeneration: joined.timeline!.playbackGeneration, entryId: joined.timeline!.entryId,
        mediaRevision: joined.timeline!.mediaRevision, sequence: 1, ready: true };
    await api.ready(guest.actor, report); const synchronized = await snapshot(guest);
    assert.equal(synchronized.members.find(value => value.memberId === joined.self.memberId)?.ready, true);
    assert.deepEqual(synchronized.timeline, playing.timeline);
    await api.ready(guest.actor, report); assert.equal((await snapshot(guest)).revision, synchronized.revision);
    await api.ready(guest.actor, { ...report, ready: false, sequence: 2 });
    const unsynchronized = await snapshot(guest);
    assert.equal(unsynchronized.members.find(value => value.memberId === joined.self.memberId)?.ready, false);
    await api.ready(guest.actor, report); assert.equal((await snapshot(guest)).revision, unsynchronized.revision);
    assert.deepEqual(unsynchronized.timeline, playing.timeline);
});

test('current readiness cannot masquerade as an active preparation or an old source generation', async () => {
    const host = await person('host'); await create(host); await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    const state = await snapshot(host); const base = { ...memberBody(state), controllerGeneration: state.self.controllerGeneration,
        expectedEpoch: state.epoch, preparationId: 'current', playbackGeneration: state.timeline!.playbackGeneration,
        entryId: state.timeline!.entryId, mediaRevision: state.timeline!.mediaRevision, sequence: 1, ready: true };
    await api.ready(host.actor, base); assert.equal((await snapshot(host)).revision, state.revision);
    await ready(host, state); const started = await snapshot(host);
    await api.ready(host.actor, { ...base, mediaRevision: 'mr_wrong', sequence: 5, ready: false });
    assert.equal((await snapshot(host)).revision, started.revision);
});

test('an old natural-end job cannot follow a newly selected song after a competing commit', async () => {
    const host = await person('host'); await create(host); await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    await ready(host, await snapshot(host)); const playing = await snapshot(host);
    now += media[0].durationMs + ROOM_LIMITS.startLeadMs;
    let scheduled = false;
    const timer = service({ beforeSweepRoom: async () => {
        if (scheduled) return; scheduled = true;
        assert.equal((await api.mutate(host.actor, control(host, playing, 'next'))).outcome, 'applied');
        await ready(host, await snapshot(host)); now += media[1].durationMs + ROOM_LIMITS.startLeadMs;
        await connect(host, await snapshot(host));
    } });
    await timer.sweep();
    assert.equal((await snapshot(host)).timeline?.entryId, playing.queue[1].entryId);
    await api.sweep(); assert.equal((await snapshot(host)).timeline?.entryId, playing.queue[2].entryId);
});

test('rejected queue validation commits status evidence without partial room, slot, or outbox writes', async () => {
    const host = await person('host');
    const intent = command(host, { action: 'create', mediaTrackIds: [media[0].mediaTrackId, new ObjectId().toHexString()] });
    const rejected = await api.mutate(host.actor, intent); assert.equal(rejected.code, 'room_media_unavailable');
    assert.equal(await roomDocuments().countDocuments({}), 0);
    assert.equal(await database().collection('socialRoomParticipation').countDocuments({}), 0);
    assert.equal(await database().collection('socialRoomOutbox').countDocuments({}), 0);
    assert.equal((await api.mutate(host.actor, intent)).replayed, true);
});

test('profile changes publish a new room revision without resetting playback or invitations', async () => {
    const { host, guest } = await pair(); const extra = await person('extra'); await friendship(host, extra); await invite(host, extra);
    const before = await playPair(host, guest);
    await transaction(async session => {
        await database().collection('socialProfiles').updateOne({ accountId: guest.actor.userId }, { $set: { alias: 'Updated public alias' } }, { session });
        await applyRoomSafety({ kind: 'profile', accountId: guest.actor.userId }, session, now);
    });
    const after = await snapshot(host); assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.timeline, before.timeline); assert.equal(after.members.find(value => value.socialId === guest.profile.socialId)?.alias, 'Updated public alias');
    assert.equal((await api.invitations(extra.actor)).length, 1);
});

test('the first heartbeat under a new authority pauses an old preparation before it can complete', async () => {
    const host = await person('host'); await create(host); await api.mutate(host.actor, control(host, await snapshot(host), 'play'));
    const state = await snapshot(host); epoch += 1; await connect(host, state);
    const after = await snapshot(host); assert.equal(after.epoch, epoch); assert.equal(after.timeline?.state, 'paused'); assert.equal(after.preparation, null);
});

test('production social Block removes the blocked member and invitation in the graph transaction', async () => {
    const { host, guest } = await pair();
    assert.equal((await social.mutate(host.actor, { ...identity(host.scope), action: 'block', targetSocialId: guest.profile.socialId })).outcome, 'applied');
    assert.equal(await api.currentRoom(guest.actor), null); assert.equal((await snapshot(host)).members.length, 1);
    assert.equal((await social.relationship(host.actor, guest.profile.socialId))?.state, 'blocked');
    assert.equal((await api.mutate(host.actor, command(host, { action: 'invite', ...memberBody(await snapshot(host)), targetSocialId: guest.profile.socialId }))).code, 'profile_unavailable');
});

test('production social deactivation closes a hosted room while preserving guest social identity', async () => {
    const { host, guest } = await pair();
    assert.equal((await social.mutate(host.actor, { ...identity(host.scope), action: 'deactivate' })).outcome, 'applied');
    assert.equal(await api.currentRoom(host.actor), null); assert.equal(await api.currentRoom(guest.actor), null);
    assert.equal((await social.ownProfile(guest.actor))?.active, true);
    assert.equal(await database().collection('socialRoomParticipation').countDocuments({}), 0);
});

test('production account deletion removes only the guest and preserves deletion rollback guarantees', async () => {
    const { host, guest } = await pair(); const state = await snapshot(host);
    await assert.rejects(deleteListenerAccountData(guest.actor.userId, { afterSocialCleanup: async () => { throw new Error('synthetic deletion rollback'); } }), /synthetic deletion rollback/);
    assert.equal((await snapshot(guest)).roomId, state.roomId);
    assert.equal((await deleteListenerAccountData(guest.actor.userId)).status, 'deleted');
    assert.equal((await snapshot(host)).members.length, 1);
    assert.equal(await database().collection('socialRoomParticipation').findOne({ _id: guest.actor.userId }), null);
    assert.equal((await deleteListenerAccountData(host.actor.userId)).status, 'deleted');
    assert.equal((await roomDocuments().findOne({ _id: state.roomId }))?.state, 'closed');
});

test('production session revocation disconnects the exact controller and logout-all removes participation', async () => {
    const { host, guest } = await pair(); const before = await snapshot(host);
    const otherSession = await AuthSession.create(host.actor.userId, `synthetic-other-${randomUUID()}`, new Date(now + SOCIAL_LIMITS.scopeMs));
    await AuthSession.revokeById(host.actor.userId, otherSession);
    assert.equal((await snapshot(host)).members.find(value => value.memberId === before.hostMemberId)?.connected, true);
    await AuthSession.revokeById(host.actor.userId, host.actor.sessionId);
    assert.equal((await snapshot(guest)).members.find(value => value.memberId === before.hostMemberId)?.connected, false);
    await AuthSession.revokeAll(guest.actor.userId);
    assert.equal(await database().collection('socialRoomParticipation').findOne({ _id: guest.actor.userId }), null);
});

test('source replacement winning admission cannot leave a room pinned to old bytes', async () => {
    const host = await person('host'); let replaced = false;
    const racing = service({ beforeAccountFence: async () => {
        if (replaced) return; replaced = true;
        await transaction(async session => {
            await database().collection('audioTracks').updateOne({ _id: new ObjectId(media[0].mediaTrackId) }, { $set: { uploadStatus: 'deleting' } }, { session });
            await invalidateRoomsForMedia(media[0].mediaTrackId, session, now);
        });
    } });
    const result = await racing.mutate(host.actor, command(host, { action: 'create', mediaTrackIds: [media[0].mediaTrackId] }));
    assert.equal(result.code, 'room_media_unavailable'); assert.equal(await roomDocuments().countDocuments({}), 0);
});

test('a block winning before invitation admission prevents the stale acceptance transaction', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); await create(host);
    const invitation = await invite(host, guest); let blocked = false;
    const racing = service({ beforeAccountFence: async () => {
        if (blocked) return; blocked = true;
        assert.equal((await social.mutate(host.actor, { ...identity(host.scope), action: 'block', targetSocialId: guest.profile.socialId })).outcome, 'applied');
    } });
    const result = await racing.mutate(guest.actor, command(guest, { action: 'acceptInvitation', invitationId: invitation.invitationId, generation: invitation.generation }));
    assert.equal(result.code, 'invitation_unavailable'); assert.equal(await api.currentRoom(guest.actor), null);
    assert.equal((await snapshot(host)).members.length, 1);
});

test('a definite aborted command writes neither state nor receipt and can explicitly retry the same key', async () => {
    const host = await person('host'); await create(host); const state = await snapshot(host); const intent = control(host, state, 'next');
    const failing = service({ beforeCommit: async () => { throw new Error('synthetic storage interruption'); } });
    await assert.rejects(failing.mutate(host.actor, intent), isError('room_unavailable'));
    assert.equal((await snapshot(host)).revision, state.revision);
    assert.equal(await social.outcome(host.actor, identityFrom(intent)), null);
    assert.equal((await api.mutate(host.actor, intent)).outcome, 'applied');
    assert.equal((await snapshot(host)).timeline?.entryId, state.queue[1].entryId);
});

/** Status lookup intentionally receives only immutable scope identity, never the original intent. */
const identityFrom = (intent: RoomCommand) => ({ scopeToken: intent.scopeToken, commandId: intent.commandId });

test('production friend removal cancels pending invites but preserves already admitted membership', async () => {
    const { host, guest } = await pair(); const other = await person('other'); await friendship(host, other); await invite(host, other);
    const pending = await social.relationship(host.actor, other.profile.socialId);
    await social.mutate(host.actor, { ...identity(host.scope), action: 'remove', targetSocialId: other.profile.socialId, expectedRevision: pending!.revision });
    assert.deepEqual(await api.invitations(other.actor), []);
    const joined = await social.relationship(host.actor, guest.profile.socialId);
    await social.mutate(host.actor, { ...identity(host.scope), action: 'remove', targetSocialId: guest.profile.socialId, expectedRevision: joined!.revision });
    assert.equal((await snapshot(guest)).members.length, 2);
});

test('production profile update immediately publishes its alias at the same playback generation', async () => {
    const { host, guest } = await pair(); const before = await playPair(host, guest);
    const own = (await social.ownProfile(guest.actor))!;
    await social.mutate(guest.actor, { ...identity(guest.scope), action: 'profile', expectedRevision: own.revision,
        handle: own.handle, alias: 'Changed alias', discoverable: false });
    const after = await snapshot(host); assert.equal(after.revision, before.revision + 1); assert.deepEqual(after.timeline, before.timeline);
    assert.equal(after.members.find(value => value.socialId === guest.profile.socialId)?.alias, 'Changed alias');
});

test('expired invitations are rejected logically before asynchronous TTL cleanup', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); await create(host); const value = await invite(host, guest);
    await database().collection('socialInvitations').updateOne({ invitationId: value.invitationId }, { $set: { expiresAt: new Date(now) } });
    assert.deepEqual(await api.invitations(guest.actor), []);
    assert.equal((await api.mutate(guest.actor, command(guest, { action: 'acceptInvitation', invitationId: value.invitationId, generation: value.generation }))).code, 'invitation_unavailable');
    assert.equal(await api.currentRoom(guest.actor), null);
});

test('revokeAllExcept preserves a kept controller and disconnects only a controller actually revoked', async () => {
    const { host, guest } = await pair(); const state = await snapshot(host);
    const other = await AuthSession.create(host.actor.userId, `synthetic-preserved-${randomUUID()}`, new Date(now + SOCIAL_LIMITS.scopeMs));
    await AuthSession.revokeAllExcept(host.actor.userId, host.actor.sessionId);
    assert.equal((await snapshot(host)).members.find(value => value.memberId === state.hostMemberId)?.connected, true);
    assert.ok((await database().collection('authSessions').findOne({ _id: new ObjectId(other) }))?.revokedAt);
    const kept = await AuthSession.create(host.actor.userId, `synthetic-another-${randomUUID()}`, new Date(now + SOCIAL_LIMITS.scopeMs));
    await AuthSession.revokeAllExcept(host.actor.userId, kept);
    const remaining = await snapshot(guest);
    assert.equal(remaining.members.find(value => value.memberId === state.hostMemberId)?.connected, false);
    assert.equal(remaining.members.length, 2);
    const stillSignedIn = { ...host, actor: { ...host.actor, sessionId: kept } };
    assert.equal((await snapshot(stillSignedIn)).self.isController, false);
});

test('password reset rolls back room removal with the credential and permits the same-code retry', async () => {
    const { host, guest } = await pair(); const state = await snapshot(host);
    const guestId = guest.actor.userId;
    await database().collection('users').updateOne({ _id: new ObjectId(guestId) }, { $set: { password: 'old-hash' } });
    const code = await AuthActionToken.issue(guestId, 'resetPassword', 15);
    const original = Collection.prototype.deleteMany;
    Collection.prototype.deleteMany = async function (filter, ...args) {
        if (this.collectionName === 'socialRealtimeTickets' && filter?.accountId === guestId) throw new Error('Synthetic late cleanup failure');
        return original.call(this, filter, ...args);
    } as typeof original;
    try {
        await assert.rejects(applyEmailAction(guestId, 'resetPassword', code, 'new-hash'), /Synthetic late cleanup failure/);
    } finally { Collection.prototype.deleteMany = original; }
    assert.deepEqual(await snapshot(host), state);
    assert.equal((await database().collection('users').findOne({ _id: new ObjectId(guestId) }))!.password, 'old-hash');
    assert.ok(await AuthSession.findActiveById(guest.actor.sessionId));
    assert.equal(await applyEmailAction(guestId, 'resetPassword', code, 'new-hash'), true);
    assert.equal((await snapshot(host)).members.length, 1);
    assert.equal(await AuthSession.findActiveById(guest.actor.sessionId), null);
});

test('password change disconnects the revoked controller while preserving its own session', async () => {
    const { host, guest } = await pair();
    const kept = await AuthSession.create(host.actor.userId, `synthetic-password-kept-${randomUUID()}`, new Date(now + SOCIAL_LIMITS.scopeMs));
    await changeAccountPassword(host.actor.userId, kept, undefined, 'changed-hash');
    assert.ok(await AuthSession.findActiveById(kept));
    assert.equal(await AuthSession.findActiveById(host.actor.sessionId), null);
    assert.equal((await snapshot(guest)).members.find(member => member.socialId === host.profile.socialId)?.connected, false);
});

test('readiness is cleared on local pause and disconnect, and a new controller can start its own report sequence', async () => {
    const host = await person('host'); await create(host); const paused = await snapshot(host);
    const report = { ...memberBody(paused), controllerGeneration: paused.self.controllerGeneration, expectedEpoch: paused.epoch,
        preparationId: 'current', playbackGeneration: paused.timeline!.playbackGeneration, entryId: paused.timeline!.entryId,
        mediaRevision: paused.timeline!.mediaRevision, sequence: 50, ready: true };
    await api.ready(host.actor, report); assert.equal((await snapshot(host)).members[0].ready, true);
    await connect(host, paused, true); const locallyPaused = await snapshot(host); assert.equal(locallyPaused.members[0].ready, false);
    await connect(host, locallyPaused, true); assert.equal((await snapshot(host)).revision, locallyPaused.revision);
    const tab = { ...host, actor: { ...host.actor, clientId: randomUUID() } };
    await api.mutate(tab.actor, command(tab, { action: 'takeControl', ...memberBody(paused) }));
    const taken = await snapshot(tab); await connect(tab, taken);
    await api.ready(tab.actor, { ...report, sequence: 1, controllerGeneration: taken.self.controllerGeneration });
    assert.equal((await snapshot(tab)).members[0].ready, true);
    await api.disconnected(tab.actor); assert.equal((await snapshot(tab)).members[0].ready, false);
});

test('social and room commands share one collision namespace for immutable mutation identity', async () => {
    const host = await person('host'); const key = identity(host.scope);
    await social.mutate(host.actor, { ...key, action: 'profile', expectedRevision: host.profile.revision, handle: host.profile.handle,
        alias: 'New alias', discoverable: true });
    await assert.rejects(api.mutate(host.actor, { ...key, action: 'create', mediaTrackIds: [media[0].mediaTrackId] }), isError('idempotency_conflict'));
    assert.equal(await roomDocuments().countDocuments({}), 0);
});

test('invitation changes atomically invalidate both private inboxes without historical payloads or rejected echoes', async () => {
    const host = await person('host'); const guest = await person('guest'); const outsider = await person('outsider');
    await friendship(host, guest); const room = await create(host);
    const revision = async (who: Person) => (await database().collection('socialOutbox').findOne({ _id: who.actor.userId }))!.revision as number;
    const beforeHost = await revision(host); const beforeGuest = await revision(guest); const beforeOutsider = await revision(outsider);
    const intent = command(host, { action: 'invite', ...memberBody(room), targetSocialId: guest.profile.socialId });
    assert.equal((await api.mutate(host.actor, intent)).outcome, 'applied');
    assert.equal(await revision(host), beforeHost + 1); assert.equal(await revision(guest), beforeGuest + 1);
    assert.equal(await revision(outsider), beforeOutsider);
    await api.mutate(host.actor, intent); assert.equal(await revision(guest), beforeGuest + 1);
    assert.equal((await api.mutate(host.actor, command(host, { action: 'invite', ...memberBody(room), targetSocialId: outsider.profile.socialId }))).outcome, 'rejected');
    assert.equal(await revision(host), beforeHost + 1); assert.equal(await revision(outsider), beforeOutsider);
    const invitation = (await api.invitations(guest.actor))[0];
    await api.mutate(guest.actor, command(guest, { action: 'declineInvitation', invitationId: invitation.invitationId, generation: invitation.generation }));
    assert.equal(await revision(host), beforeHost + 2); assert.equal(await revision(guest), beforeGuest + 2);
    await invite(host, guest); const beforeEnd = await revision(guest);
    await api.mutate(host.actor, command(host, { action: 'end', ...memberBody(room) }));
    assert.equal(await revision(guest), beforeEnd + 1); assert.deepEqual(await api.invitations(guest.actor), []);
    const outbox = await database().collection('socialOutbox').findOne({ _id: guest.actor.userId });
    assert.deepEqual(Object.keys(outbox!).sort(), ['_id', 'accountId', 'revision', 'updatedAt']);
    assert.equal(JSON.stringify(outbox).includes(invitation.invitationId), false);
    assert.equal(JSON.stringify(outbox).includes(room.roomId), false);
});

test('failed invitation commit rolls back inbox invalidations together with invitation evidence', async () => {
    const host = await person('host'); const guest = await person('guest'); await friendship(host, guest); const room = await create(host);
    const before = await database().collection('socialOutbox').findOne({ _id: guest.actor.userId });
    const failing = service({ beforeCommit: async () => { throw new Error('synthetic invitation failure'); } });
    await assert.rejects(failing.mutate(host.actor, command(host, { action: 'invite', ...memberBody(room), targetSocialId: guest.profile.socialId })), isError('room_unavailable'));
    assert.deepEqual(await api.invitations(guest.actor), []);
    assert.deepEqual(await database().collection('socialOutbox').findOne({ _id: guest.actor.userId }), before);
});
