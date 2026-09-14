import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { MongoServerError, ObjectId, type ClientSession } from 'mongodb';
import { createRoomService, type RoomServiceOptions } from '../src/application/rooms/roomService';
import { applyRoomSafety, invalidateRoomsForMedia } from '../src/application/rooms/roomLifecycle';
import { createSocialService } from '../src/application/social/socialService';
import { ROOM_LIMITS, type RoomActor, type RoomApi, type RoomCommand, type RoomMediaDescriptor, type RoomSnapshot } from '../src/contracts/roomV1';
import { SOCIAL_LIMITS, SocialError, type SocialApi, type SocialScope } from '../src/contracts/socialV1';
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
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
        const error = new MongoServerError({ message: 'synthetic lost commit acknowledgement' }); error.addErrorLabel('UnknownTransactionCommitResult'); throw error;
    } });
    await assert.rejects(uncertain.mutate(host.actor, intent), isError('mutation_outcome_unknown'));
    assert.equal(commits, 1); assert.equal((await snapshot(host)).timeline?.entryId, state.queue[1].entryId);
    assert.deepEqual(await social.outcome(host.actor, { scopeToken: intent.scopeToken, commandId: intent.commandId }),
        { commandId: intent.commandId, outcome: 'applied', replayed: true });
    assert.equal((await api.mutate(host.actor, intent)).replayed, true);
    await assert.rejects(api.mutate(host.actor, { ...intent, action: 'previous' } as RoomCommand), isError('idempotency_conflict'));
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
