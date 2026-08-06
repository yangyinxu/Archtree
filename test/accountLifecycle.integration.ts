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
import { getDatabaseClient, getDb } from '../src/infrastructure/database';
import AuthIdentity from '../src/models/authIdentity';
import AuthSession from '../src/models/authSession';
import { Album } from '../src/models/album';
import { Artist } from '../src/models/artist';
import { AudioFormat, AudioTrack } from '../src/models/audioTrack';
import { Carousel } from '../src/models/carousel';
import { ContentCollection } from '../src/models/contentCollection';
import { ImageAsset } from '../src/models/imageAsset';
import { Page } from '../src/models/page';
import User from '../src/models/user';
import { Playlist, playlistRequestFingerprint } from '../src/models/playlist';
import { SimpleDate } from '../src/models/simpleDate';
import {
    AccountReferenceUnavailableError,
    touchActiveAccount
} from '../src/services/accountReferenceFenceService';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import {
    beginAvatarMutation,
    releaseAvatarMutation
} from '../src/services/avatarMutationService';
import { deleteAvatarOwnerAndAllAssets } from '../src/services/avatarStorageService';
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

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const sharedProvenanceCollections = [
    'artists',
    'albums',
    'audioTracks',
    'carousels',
    'contentCollections',
    'pages',
    'imageAssets'
] as const;

/** Inserts a representative provenance row behind the same account fence as model writers. */
const insertSharedProvenanceRecord = async (
    collectionName: typeof sharedProvenanceCollections[number],
    userId: string,
    dependencies: {
        beforeAccountFence?: () => Promise<void>;
        afterRecordWritten?: () => Promise<void>;
    } = {}
) => {
    const recordId = new ObjectId();
    const session = getDatabaseClient().startSession();
    try {
        await session.withTransaction(async () => {
            await dependencies.beforeAccountFence?.();
            await touchActiveAccount(userId, session);
            const record = {
                _id: recordId,
                createdBy: userId,
                ...(collectionName === 'pages'
                    ? { slug: `account-race-${recordId.toHexString()}` }
                    : {}),
                ...(collectionName === 'imageAssets'
                    ? { ownerType: 'artist', ownerId: new ObjectId().toHexString() }
                    : {})
            };
            await getDb()!.collection(collectionName).insertOne(record, { session });
            await dependencies.afterRecordWritten?.();
        });
        return recordId;
    } finally {
        await session.endSession();
    }
};

let harness: MongoReplicaSetHarness | undefined;

before(async () => {
    harness = await startMongoReplicaSet('archtree-account-lifecycle-test');
});

after(async () => {
    await harness?.stop();
});

test('account-deletion provenance lookup has an image-asset creator index', async () => {
    const indexes = await getDb()!.collection('imageAssets').indexes();
    assert.ok(indexes.some((index) => (
        index.key?.createdBy === 1 && index.key?.ownerType === 1
    )));
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
        }),
        getDb()!.collection('playlists').insertOne({
            _id: new ObjectId(),
            ownerUserId: userIdString,
            name: 'Delete with listener',
            items: [],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date()
        }),
        getDb()!.collection('accountMutations').insertOne({
            _id: 'deletion-playlist-mutation',
            ownerUserId: userIdString,
            idempotencyKeyHash: 'deletion-playlist-mutation-hash',
            operation: 'playlist.create',
            status: 'completed',
            expiresAt: new Date(Date.now() + 60_000)
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
        'playlists',
        'accountMutations',
        'authSessions'
    ]) {
        const ownershipField = collection === 'playlists' || collection === 'accountMutations'
            ? 'ownerUserId'
            : 'userId';
        assert.equal(
            await getDb()!.collection(collection).countDocuments({ [ownershipField]: userIdString }),
            0,
            `${collection} retained listener data`
        );
    }
    assert.equal(await getDb()!.collection('users').findOne({ _id: userId }), null);
});

test('account deletion cannot race Playlist mutations into orphaned private data', async () => {
    const scenarios = ['create', 'rename', 'delete', 'add', 'reorder'] as const;
    for (const scenario of scenarios) {
        const userId = new ObjectId();
        const userIdString = userId.toHexString();
        const playlistId = new ObjectId();
        const trackId = new ObjectId();
        await Promise.all([
            getDb()!.collection('users').insertOne({
                _id: userId,
                email: `playlist-race-${scenario}@example.com`,
                password: 'hash',
                username: '',
                posts: [],
                role: 'user'
            }),
            scenario === 'create'
                ? Promise.resolve()
                : getDb()!.collection('playlists').insertOne({
                    _id: playlistId,
                    ownerUserId: userIdString,
                    name: 'Race source',
                    items: [],
                    revision: 1,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }),
            scenario === 'add'
                ? getDb()!.collection('audioTracks').insertOne({
                    _id: trackId,
                    title: 'Ready race track',
                    uploadStatus: 'ready',
                    s3Key: trackId.toHexString()
                })
                : Promise.resolve()
        ]);
        const sessionId = await AuthSession.create(
            userIdString,
            `playlist-race-session-${scenario}`,
            new Date(Date.now() + 60_000)
        );
        const capture = captureResponse();
        const key = `account-delete-race-${scenario}`;
        const mutation = scenario === 'create'
            ? Playlist.create(
                userIdString,
                'Concurrent create',
                key,
                playlistRequestFingerprint('playlist.create', { name: 'Concurrent create' })
            )
            : scenario === 'rename'
                ? Playlist.rename(
                    userIdString,
                    playlistId.toHexString(),
                    'Concurrent rename',
                    1,
                    key,
                    playlistRequestFingerprint('playlist.rename', {
                        playlistId: playlistId.toHexString(),
                        name: 'Concurrent rename',
                        expectedRevision: 1
                    })
                )
                : scenario === 'delete'
                    ? Playlist.delete(
                        userIdString,
                        playlistId.toHexString(),
                        1,
                        key,
                        playlistRequestFingerprint('playlist.delete', {
                            playlistId: playlistId.toHexString(),
                            expectedRevision: 1
                        })
                    )
                    : scenario === 'add'
                        ? Playlist.addItem(
                            userIdString,
                            playlistId.toHexString(),
                            trackId.toHexString(),
                            undefined,
                            1,
                            key,
                            playlistRequestFingerprint('playlist.item.add', {
                                playlistId: playlistId.toHexString(),
                                audioTrackId: trackId.toHexString(),
                                position: null,
                                expectedRevision: 1
                            })
                        )
                        : Playlist.reorderItems(
                            userIdString,
                            playlistId.toHexString(),
                            [],
                            1,
                            key,
                            playlistRequestFingerprint('playlist.item.reorder', {
                                playlistId: playlistId.toHexString(),
                                itemIds: [],
                                expectedRevision: 1
                            })
                        );

        await Promise.allSettled([
            mutation,
            deleteAccount(authenticatedRequest(userIdString, sessionId), capture.response)
        ]);

        assert.equal(await getDb()!.collection('users').countDocuments({ _id: userId }), 0, scenario);
        assert.equal(await getDb()!.collection('playlists').countDocuments({ ownerUserId: userIdString }), 0, scenario);
        assert.equal(await getDb()!.collection('accountMutations').countDocuments({ ownerUserId: userIdString }), 0, scenario);
        assert.equal(await getDb()!.collection('authSessions').countDocuments({ userId: userIdString }), 0, scenario);
    }
});

test('an Avatar mutation reservation wins the account fence before deletion checks private state', async () => {
    const userId = new ObjectId();
    const userIdString = userId.toHexString();
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email: 'avatar-reservation-wins@example.com',
        password: 'hash',
        username: '',
        posts: [],
        role: 'user'
    });
    const sessionId = await AuthSession.create(
        userIdString,
        'avatar-reservation-wins-session',
        new Date(Date.now() + 60_000)
    );
    const reservationWritten = deferred();
    const releaseReservation = deferred();

    const reservation = beginAvatarMutation(
        userIdString,
        'avatar-reservation-wins',
        'replace',
        0,
        {
            afterReservationWritten: async () => {
                reservationWritten.resolve();
                await releaseReservation.promise;
            }
        }
    );
    await reservationWritten.promise;
    const deletion = deleteListenerAccountData(userIdString);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReservation.resolve();

    assert.equal((await reservation).isOwner, true);
    assert.deepEqual(await deletion, { status: 'avatarCleanupPending' });
    assert.ok(await getDb()!.collection('users').findOne({ _id: userId }));
    assert.ok(await AuthSession.findActiveById(sessionId));
    assert.ok(await getDb()!.collection('avatarMutations').findOne({
        userId: userIdString,
        status: 'pending'
    }));

    await releaseAvatarMutation((await reservation).mutationId);
    assert.deepEqual(await deleteListenerAccountData(userIdString), { status: 'deleted' });
    assert.equal(await getDb()!.collection('users').findOne({ _id: userId }), null);
    assert.equal(await AuthSession.findActiveById(sessionId), null);
});

test('one pending Avatar lease excludes a different concurrent mutation for the same account', async () => {
    const userId = new ObjectId();
    const userIdString = userId.toHexString();
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email: 'avatar-exclusive-lease@example.com',
        password: 'hash',
        username: '',
        posts: [],
        role: 'user'
    });
    const firstWritten = deferred();
    const releaseFirst = deferred();

    const first = beginAvatarMutation(
        userIdString,
        'avatar-exclusive-first',
        'replace',
        0,
        {
            afterReservationWritten: async () => {
                firstWritten.resolve();
                await releaseFirst.promise;
            }
        }
    );
    await firstWritten.promise;
    const second = beginAvatarMutation(
        userIdString,
        'avatar-exclusive-second',
        'delete',
        0
    );
    releaseFirst.resolve();

    const firstResult = await first;
    const secondResult = await second;
    assert.equal(firstResult.isOwner, true);
    assert.equal(secondResult.isOwner, false);
    assert.deepEqual(secondResult.result, {
        statusCode: 409,
        body: { message: 'Another avatar operation is still in progress.' }
    });
    assert.equal(await getDb()!.collection('avatarMutations').countDocuments({
        userId: userIdString,
        status: 'pending'
    }), 1);
    await releaseAvatarMutation(firstResult.mutationId);
    assert.deepEqual(await deleteListenerAccountData(userIdString), { status: 'deleted' });
});

test('account deletion wins the shared fence before a new Avatar reservation can persist', async () => {
    const userId = new ObjectId();
    const userIdString = userId.toHexString();
    await getDb()!.collection('users').insertOne({
        _id: userId,
        email: 'avatar-deletion-wins@example.com',
        password: 'hash',
        username: '',
        posts: [],
        role: 'user'
    });
    const sessionId = await AuthSession.create(
        userIdString,
        'avatar-deletion-wins-session',
        new Date(Date.now() + 60_000)
    );
    const deletionFenced = deferred();
    const releaseDeletion = deferred();

    const deletion = deleteListenerAccountData(userIdString, {
        afterAccountFence: async () => {
            deletionFenced.resolve();
            await releaseDeletion.promise;
        }
    });
    await deletionFenced.promise;
    const reservation = beginAvatarMutation(
        userIdString,
        'avatar-deletion-wins',
        'replace',
        0
    );
    const reservationOutcome = reservation.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseDeletion.resolve();

    assert.deepEqual(await deletion, { status: 'deleted' });
    const rejected = await reservationOutcome;
    assert.equal(rejected.value, undefined);
    assert.ok(rejected.error instanceof AccountReferenceUnavailableError);
    assert.equal(await getDb()!.collection('users').findOne({ _id: userId }), null);
    assert.equal(await AuthSession.findActiveById(sessionId), null);
    assert.equal(await getDb()!.collection('avatarMutations').countDocuments({
        userId: userIdString
    }), 0);
});

test('detached Avatar lifecycle evidence blocks account deletion until cleanup completes', async () => {
    const userId = new ObjectId();
    const userIdString = userId.toHexString();
    const imageId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: userId,
            email: 'avatar-cleanup-pending@example.com',
            password: 'hash',
            username: '',
            posts: [],
            role: 'user',
            avatarRevision: 2,
            avatarAssetId: null
        }),
        getDb()!.collection('imageAssets').insertOne({
            _id: imageId,
            ownerType: 'user',
            ownerId: userIdString,
            createdBy: userIdString,
            s3Key: `avatars/${imageId.toHexString()}`,
            uploadStatus: 'deleteFailed',
            uploadError: 'simulated cleanup failure'
        })
    ]);
    const sessionId = await AuthSession.create(
        userIdString,
        'avatar-cleanup-pending-session',
        new Date(Date.now() + 60_000)
    );
    const blocked = captureResponse();

    await deleteAccount(authenticatedRequest(userIdString, sessionId), blocked.response);

    assert.equal(blocked.statusCode, 409);
    assert.deepEqual(blocked.body, {
        code: 'avatar_cleanup_pending',
        message: 'A profile photo update or cleanup must finish before the account can be removed.'
    });
    assert.ok(await getDb()!.collection('users').findOne({ _id: userId }));
    assert.ok(await AuthSession.findActiveById(sessionId));
    assert.ok(await getDb()!.collection('imageAssets').findOne({ _id: imageId }));

    await getDb()!.collection('imageAssets').deleteOne({ _id: imageId });
    const retried = captureResponse();
    await deleteAccount(authenticatedRequest(userIdString, sessionId), retried.response);
    assert.equal(retried.statusCode, 204);
    assert.equal(await getDb()!.collection('users').findOne({ _id: userId }), null);
    assert.equal(await AuthSession.findActiveById(sessionId), null);
});

test('removing the current Avatar retries an older failed replacement before account deletion', async () => {
    const userId = new ObjectId();
    const userIdString = userId.toHexString();
    const oldImageId = new ObjectId();
    const currentImageId = new ObjectId();
    await Promise.all([
        getDb()!.collection('users').insertOne({
            _id: userId,
            email: 'avatar-old-cleanup-retry@example.com',
            password: 'hash',
            username: '',
            posts: [],
            role: 'user',
            avatarRevision: 2,
            avatarAssetId: currentImageId.toHexString()
        }),
        getDb()!.collection('imageAssets').insertMany([
            {
                _id: oldImageId,
                ownerType: 'user',
                ownerId: userIdString,
                createdBy: userIdString,
                s3Key: `avatars/${oldImageId.toHexString()}`,
                uploadStatus: 'deleteFailed',
                uploadError: 'simulated old replacement cleanup failure'
            },
            {
                _id: currentImageId,
                ownerType: 'user',
                ownerId: userIdString,
                createdBy: userIdString,
                s3Key: `avatars/${currentImageId.toHexString()}`,
                uploadStatus: 'ready',
                uploadError: null
            }
        ])
    ]);
    const deletedKeys: string[] = [];

    const removal = await deleteAvatarOwnerAndAllAssets(
        currentImageId.toHexString(),
        userIdString,
        () => User.clearAvatar(userIdString, 2, currentImageId.toHexString()),
        {
            deleteObject: async (s3Key) => {
                deletedKeys.push(s3Key);
            }
        }
    );

    assert.equal(removal.ownerCleared, true);
    assert.equal(removal.cleanupPending, false);
    assert.deepEqual(new Set(deletedKeys), new Set([
        `avatars/${currentImageId.toHexString()}`,
        `avatars/${oldImageId.toHexString()}`
    ]));
    assert.equal(await getDb()!.collection('imageAssets').countDocuments({
        ownerType: 'user',
        ownerId: userIdString
    }), 0);
    const user = await getDb()!.collection('users').findOne({ _id: userId });
    assert.equal(user!.avatarAssetId, null);
    assert.deepEqual(await deleteListenerAccountData(userIdString), { status: 'deleted' });
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

test('committed shared provenance wins every account deletion fence and remains traceable', async () => {
    for (const collectionName of sharedProvenanceCollections) {
        const userId = new ObjectId();
        const userIdString = userId.toHexString();
        await getDb()!.collection('users').insertOne({
            _id: userId,
            email: `provenance-write-wins-${collectionName}@example.com`,
            password: 'hash',
            username: '',
            posts: [],
            role: 'admin'
        });
        const sessionId = await AuthSession.create(
            userIdString,
            `provenance-write-wins-${collectionName}`,
            new Date(Date.now() + 60_000)
        );
        const recordWritten = deferred();
        const releaseRecord = deferred();
        const deletionStarted = deferred();

        const creation = insertSharedProvenanceRecord(collectionName, userIdString, {
            afterRecordWritten: async () => {
                recordWritten.resolve();
                await releaseRecord.promise;
            }
        });
        await recordWritten.promise;
        const deletion = deleteListenerAccountData(userIdString, {
            beforeAccountFence: async () => {
                deletionStarted.resolve();
            }
        });
        await deletionStarted.promise;
        releaseRecord.resolve();

        const recordId = await creation;
        assert.deepEqual(await deletion, { status: 'sharedProvenance' }, collectionName);
        assert.ok(
            await getDb()!.collection(collectionName).findOne({ _id: recordId }),
            collectionName
        );
        assert.ok(await getDb()!.collection('users').findOne({ _id: userId }), collectionName);
        assert.ok(await AuthSession.findActiveById(sessionId), collectionName);

        await getDb()!.collection(collectionName).deleteOne({ _id: recordId });
        assert.deepEqual(
            await deleteListenerAccountData(userIdString),
            { status: 'deleted' },
            collectionName
        );
    }
});

test('committed account deletion rejects provenance writes in every shared collection', async () => {
    for (const collectionName of sharedProvenanceCollections) {
        const userId = new ObjectId();
        const userIdString = userId.toHexString();
        await getDb()!.collection('users').insertOne({
            _id: userId,
            email: `provenance-delete-wins-${collectionName}@example.com`,
            password: 'hash',
            username: '',
            posts: [],
            role: 'admin'
        });
        const sessionId = await AuthSession.create(
            userIdString,
            `provenance-delete-wins-${collectionName}`,
            new Date(Date.now() + 60_000)
        );
        const deletionFenced = deferred();
        const releaseDeletion = deferred();
        const creationStarted = deferred();

        const deletion = deleteListenerAccountData(userIdString, {
            afterAccountFence: async () => {
                deletionFenced.resolve();
                await releaseDeletion.promise;
            }
        });
        await deletionFenced.promise;
        const creation = insertSharedProvenanceRecord(collectionName, userIdString, {
            beforeAccountFence: async () => {
                creationStarted.resolve();
            }
        });
        const creationOutcome = creation.then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error })
        );
        await creationStarted.promise;
        releaseDeletion.resolve();

        assert.deepEqual(await deletion, { status: 'deleted' }, collectionName);
        const rejected = await creationOutcome;
        assert.equal(rejected.value, undefined, collectionName);
        assert.ok(rejected.error instanceof AccountReferenceUnavailableError, collectionName);
        assert.equal(
            await getDb()!.collection(collectionName).countDocuments({ createdBy: userIdString }),
            0,
            collectionName
        );
        assert.equal(await getDb()!.collection('users').findOne({ _id: userId }), null);
        assert.equal(await AuthSession.findActiveById(sessionId), null);
    }
});

test('every production provenance writer rejects a missing creator account', async () => {
    const creatorUserId = new ObjectId().toHexString();
    const referencedArtistId = new ObjectId();
    await getDb()!.collection('artists').insertOne({
        _id: referencedArtistId,
        name: 'Existing reference target',
        albumIds: [],
        lifecycleStatus: 'ready',
        referenceRevision: 0
    });

    const sharedAsset = () => ({
        _id: new ObjectId(),
        ownerType: 'artist' as const,
        ownerId: referencedArtistId.toHexString(),
        createdBy: creatorUserId,
        originalFileName: 'missing-creator.jpg',
        contentType: 'image/jpeg',
        s3Key: `images/${new ObjectId().toHexString()}`,
        uploadStatus: 'pending' as const,
        uploadUpdatedAt: new Date(),
        uploadError: null
    });
    const writers: Array<{
        label: string;
        collectionName: typeof sharedProvenanceCollections[number];
        write: () => Promise<unknown>;
    }> = [
        {
            label: 'Artist.save',
            collectionName: 'artists',
            write: () => new Artist(
                'Missing creator Artist',
                new SimpleDate(),
                '',
                '',
                [] as unknown as [string],
                creatorUserId,
                new ObjectId()
            ).save()
        },
        {
            label: 'Album.save',
            collectionName: 'albums',
            write: () => new Album(
                'Missing creator Album',
                '',
                [] as unknown as [string],
                new SimpleDate(),
                creatorUserId,
                new ObjectId()
            ).save()
        },
        {
            label: 'AudioTrack.save',
            collectionName: 'audioTracks',
            write: () => new AudioTrack(
                'Missing creator Soundtrack',
                [] as unknown as [string],
                [] as unknown as [string],
                '',
                new SimpleDate(),
                '',
                new AudioFormat('MP3'),
                '',
                creatorUserId,
                'missing-creator.mp3',
                'audio/mpeg',
                new ObjectId()
            ).save()
        },
        {
            label: 'Carousel.save manual',
            collectionName: 'carousels',
            write: () => new Carousel(
                'Missing creator manual Carousel',
                [],
                creatorUserId,
                creatorUserId,
                'manual'
            ).save()
        },
        {
            label: 'Carousel.save artist',
            collectionName: 'carousels',
            write: () => new Carousel(
                'Missing creator Artist Carousel',
                [],
                creatorUserId,
                creatorUserId,
                'artist',
                {
                    artistId: referencedArtistId.toHexString(),
                    contentType: 'audioTrack',
                    sort: 'titleAsc',
                    limit: 20
                }
            ).save()
        },
        {
            label: 'Carousel.save personalized',
            collectionName: 'carousels',
            write: () => new Carousel(
                'Missing creator personalized Carousel',
                [],
                creatorUserId,
                creatorUserId,
                'personalized',
                undefined,
                { source: 'recentlyPlayed', limit: 20 }
            ).save()
        },
        {
            label: 'ContentCollection.save manual',
            collectionName: 'contentCollections',
            write: () => new ContentCollection(
                'Missing creator Grid',
                'grid',
                'manual',
                'album',
                [],
                creatorUserId,
                creatorUserId
            ).save()
        },
        {
            label: 'ContentCollection.save dynamic',
            collectionName: 'contentCollections',
            write: () => new ContentCollection(
                'Missing creator List',
                'list',
                'dynamic',
                'audioTrack',
                [],
                creatorUserId,
                creatorUserId,
                'downloadedSongs'
            ).save()
        },
        {
            label: 'Page.save',
            collectionName: 'pages',
            write: () => new Page(
                'home',
                'Missing creator Home',
                [],
                creatorUserId,
                creatorUserId
            ).save()
        },
        {
            label: 'Page.upsertBySlug',
            collectionName: 'pages',
            write: () => Page.upsertBySlug('library', 'Missing creator Library', creatorUserId)
        },
        {
            label: 'ImageAsset.insert',
            collectionName: 'imageAssets',
            write: () => ImageAsset.insert(sharedAsset())
        },
        {
            label: 'ImageAsset.insert existing transaction',
            collectionName: 'imageAssets',
            write: async () => {
                const session = getDatabaseClient().startSession();
                try {
                    await session.withTransaction(async () => {
                        await ImageAsset.insert(sharedAsset(), session);
                    });
                } finally {
                    await session.endSession();
                }
            }
        }
    ];

    for (const writer of writers) {
        await assert.rejects(
            writer.write,
            (error: unknown) => error instanceof AccountReferenceUnavailableError,
            writer.label
        );
        assert.equal(
            await getDb()!.collection(writer.collectionName).countDocuments({
                createdBy: creatorUserId
            }),
            0,
            writer.label
        );
    }
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
