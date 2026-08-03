import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { ObjectId } from 'mongodb';
import { Request, Response } from 'express';
import {
    changePassword,
    clearListeningHistory,
    deleteAccount,
    unlinkProvider
} from '../src/controllers/accountController';
import { getDb } from '../src/infrastructure/database';
import AuthIdentity from '../src/models/authIdentity';
import AuthSession from '../src/models/authSession';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

interface ResponseCapture {
    response: Response;
    statusCode: number;
    body: unknown;
}

/** Captures direct controller responses without bypassing their persistence behavior. */
const captureResponse = (): ResponseCapture => {
    const capture = {
        statusCode: 200,
        body: undefined as unknown
    };
    const response = {
        status(code: number) {
            capture.statusCode = code;
            return this;
        },
        json(body: unknown) {
            capture.body = body;
            return this;
        },
        send(body?: unknown) {
            capture.body = body;
            return this;
        }
    } as unknown as Response;
    return {
        response,
        get statusCode() { return capture.statusCode; },
        get body() { return capture.body; }
    };
};

/** Creates the authenticated request shape installed by requireAuth. */
const authenticatedRequest = (
    userId: string,
    sessionId: string,
    body: Record<string, unknown> = {},
    params: Record<string, string> = {}
) => ({
    auth: {
        userId,
        sessionId,
        email: `${userId}@example.com`,
        role: 'user'
    },
    body,
    params
} as unknown as Request);

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-account-lifecycle-test');
});

after(async () => {
    await harness?.stop();
});

test('password change preserves the current session and revokes other devices', async () => {
    const userId = new ObjectId();
    const oldPassword = 'old-password-is-long';
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email: 'password-change@example.com',
        password: await bcrypt.hash(oldPassword, 4),
        username: '',
        posts: [],
        role: 'user'
    });
    const expiry = new Date(Date.now() + 60_000);
    const current = await AuthSession.create(userId.toString(), 'password-current', expiry);
    const other = await AuthSession.create(userId.toString(), 'password-other', expiry);
    const capture = captureResponse();

    await changePassword(
        authenticatedRequest(userId.toString(), current, {
            currentPassword: oldPassword,
            newPassword: 'new-password-is-long'
        }),
        capture.response
    );

    assert.equal(capture.statusCode, 204);
    const updated = await getDb()!.collection('users').findOne({ _id: userId });
    assert.equal(await bcrypt.compare('new-password-is-long', updated!.password), true);
    assert.ok(await AuthSession.findActiveById(current));
    assert.equal(await AuthSession.findActiveById(other), null);
});

test('provider unlink refuses the final recovery method and succeeds after password setup', async () => {
    const userId = new ObjectId();
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email: 'unlink@example.com',
        password: '',
        username: '',
        posts: [],
        role: 'user'
    });
    await AuthIdentity.create(userId.toString(), 'apple', 'apple-subject');
    const sessionId = await AuthSession.create(
        userId.toString(),
        'unlink-session',
        new Date(Date.now() + 60_000)
    );

    const rejected = captureResponse();
    await unlinkProvider(
        authenticatedRequest(userId.toString(), sessionId, {}, { provider: 'apple' }),
        rejected.response
    );
    assert.equal(rejected.statusCode, 409);
    assert.ok(await AuthIdentity.find('apple', 'apple-subject'));

    await getDb()!.collection('users').updateOne(
        { _id: userId },
        { $set: { password: 'a-hash-is-enough-for-method-detection' } }
    );
    const accepted = captureResponse();
    await unlinkProvider(
        authenticatedRequest(userId.toString(), sessionId, {}, { provider: 'apple' }),
        accepted.response
    );
    assert.equal(accepted.statusCode, 204);
    assert.equal(await AuthIdentity.find('apple', 'apple-subject'), null);
});

test('clearing listening history preserves recently saved activity', async () => {
    const userId = new ObjectId().toString();
    const saved = [{ contentType: 'album', contentId: new ObjectId().toString() }];
    await getDb()!.collection('userActivity').insertOne({
        userId,
        recentlySaved: saved,
        recentlyPlayed: [{ contentType: 'audioTrack', contentId: new ObjectId().toString() }]
    });
    const capture = captureResponse();

    await clearListeningHistory(
        authenticatedRequest(userId, new ObjectId().toString()),
        capture.response
    );

    assert.equal(capture.statusCode, 204);
    const activity = await getDb()!.collection('userActivity').findOne({ userId });
    assert.deepEqual(activity!.recentlyPlayed, []);
    assert.deepEqual(activity!.recentlySaved, saved);
});

test('listener deletion removes every account-owned record transactionally', async () => {
    const userId = new ObjectId();
    const userIdString = userId.toString();
    const identityId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: userId,
            email: 'delete-listener@example.com',
            password: 'hash',
            username: '',
            posts: [],
            role: 'user'
        }),
        getDb()!.collection('userSaves').insertOne({
            userId: userIdString,
            contentType: 'album',
            contentId: new ObjectId().toString()
        }),
        getDb()!.collection('userActivity').insertOne({
            userId: userIdString,
            recentlyPlayed: []
        }),
        getDb()!.collection('authActionTokens').insertOne({
            userId: userIdString,
            purpose: 'resetPassword'
        }),
        getDb()!.collection('authIdentities').insertOne({
            _id: identityId,
            userId: userIdString,
            provider: 'google',
            providerSubject: 'deletion-google-subject'
        }),
        getDb()!.collection('passkeys').insertOne({
            userId: userIdString,
            credentialId: 'deletion-passkey'
        }),
        getDb()!.collection('passkeyChallenges').insertOne({
            userId: userIdString,
            flowId: 'deletion-flow'
        }),
        getDb()!.collection('avatarMutations').insertOne({
            _id: 'deletion-avatar-mutation',
            userId: userIdString,
            status: 'completed'
        })
    ]);
    const sessionId = await AuthSession.create(
        userIdString,
        'deletion-session',
        new Date(Date.now() + 60_000)
    );
    const capture = captureResponse();

    await deleteAccount(authenticatedRequest(userIdString, sessionId), capture.response);

    assert.equal(capture.statusCode, 204);
    for (const collection of [
        'userSaves',
        'userActivity',
        'authActionTokens',
        'authIdentities',
        'passkeys',
        'passkeyChallenges',
        'avatarMutations',
        'authSessions'
    ]) {
        assert.equal(
            await getDb()!.collection(collection).countDocuments({ userId: userIdString }),
            0,
            `${collection} retained listener data`
        );
    }
    assert.equal(await getDb()!.collection('users').findOne({ _id: userId }), null);
});

test('account deletion preserves the account until its avatar is explicitly removed', async () => {
    const userId = new ObjectId();
    const userIdString = userId.toString();
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email: 'delete-avatar-first@example.com',
        password: 'hash',
        username: '',
        posts: [],
        role: 'user',
        avatarAssetId: new ObjectId().toString(),
        avatarRevision: 1
    });
    const sessionId = await AuthSession.create(
        userIdString,
        'avatar-deletion-session',
        new Date(Date.now() + 60_000)
    );
    const capture = captureResponse();

    await deleteAccount(authenticatedRequest(userIdString, sessionId), capture.response);

    assert.equal(capture.statusCode, 409);
    assert.deepEqual(capture.body, {
        message: 'The profile avatar must finish deleting before the account can be removed.',
        requiresAvatarDeletion: true
    });
    assert.ok(await getDb()!.collection('users').findOne({ _id: userId }));
    assert.ok(await AuthSession.findActiveById(sessionId));
});

test('account deletion preserves the account while shared catalog provenance remains', async () => {
    const userId = new ObjectId();
    const userIdString = userId.toString();
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email: 'delete-creator@example.com',
        password: 'hash',
        username: '',
        posts: [],
        role: 'creator'
    });
    await getDb()!.collection('albums').insertOne({
        _id: new ObjectId(),
        createdBy: userIdString,
        title: 'Owned Album'
    });
    const sessionId = await AuthSession.create(
        userIdString,
        'creator-session',
        new Date(Date.now() + 60_000)
    );
    const capture = captureResponse();

    await deleteAccount(authenticatedRequest(userIdString, sessionId), capture.response);

    assert.equal(capture.statusCode, 409);
    assert.equal(
        capture.body?.message,
        'Shared catalog records still reference this account as provenance. An administrator must reassign that provenance or delete those records before the account can be removed.'
    );
    assert.ok(await getDb()!.collection('users').findOne({ _id: userId }));
    assert.ok(await AuthSession.findActiveById(sessionId));
    assert.ok(await getDb()!.collection('albums').findOne({ createdBy: userIdString }));
});
