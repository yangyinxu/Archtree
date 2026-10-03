import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import bcrypt from 'bcryptjs';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import AuthIdentity from '../src/models/authIdentity';
import AuthSession from '../src/models/authSession';
import { Passkey, PasskeyChallenge } from '../src/models/passkey';
import User from '../src/models/user';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

/**
 * Exercises registration, resend, verification and recovery through the real
 * routes. Generic responses are sent before account work, so assertions about
 * codes and accounts wait for the mail boundary instead of the HTTP response.
 */
let baseUrl = '';
let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let originalSesSend: typeof SESv2Client.prototype.send;
const originalEnvironment = new Map<string, string | undefined>();

interface DeliveryAttempt { code: string; outcome: 'pending' | 'delivered' | 'failed' }
interface MailControl { gate?: Promise<void>; failures: number }
const deliveries = new Map<string, DeliveryAttempt[]>();
const mailControls = new Map<string, MailControl>();

const setTestEnvironment = (name: string, value: string) => {
    originalEnvironment.set(name, process.env[name]);
    process.env[name] = value;
};

/** Captures codes at the SES boundary; a recipient's control can hold or fail its next sends. */
const installEmailCapture = () => {
    originalSesSend = SESv2Client.prototype.send;
    SESv2Client.prototype.send = (async (command: any) => {
        const recipient = String(command.input?.Destination?.ToAddresses?.[0] ?? '');
        const text = String(command.input?.Content?.Simple?.Body?.Text?.Data ?? '');
        const code = text.match(/\b(\d{6})\b/)?.[1];
        assert.ok(recipient && code, 'the auth email contains a recipient and six-digit code');
        const attempt: DeliveryAttempt = { code, outcome: 'pending' };
        deliveries.set(recipient, [...(deliveries.get(recipient) ?? []), attempt]);
        const control = mailControls.get(recipient);
        if (control?.gate) await control.gate;
        if (control && control.failures > 0) {
            control.failures -= 1;
            attempt.outcome = 'failed';
            throw new Error('simulated email delivery failure');
        }
        attempt.outcome = 'delivered';
        return {} as any;
    }) as typeof SESv2Client.prototype.send;
};

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Polls observable state with a bound so a regression fails instead of hanging. */
const waitFor = async (condition: () => boolean, description: string) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
        await pause(10);
    }
};

const delivered = (email: string) => (deliveries.get(email) ?? []).filter(attempt => attempt.outcome === 'delivered');
const waitForDelivered = async (email: string, count: number) => {
    await waitFor(() => delivered(email).length >= count, `${count} delivered email(s) for ${email}`);
    return delivered(email)[count - 1].code;
};

const postJson = (pathname: string, body: Record<string, unknown>) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});
const register = async (email: string, password: string, displayName: string) => {
    const response = await postJson('/auth/signup', { email, password, displayName });
    assert.equal(response.status, 202);
    await response.text();
};
const resend = async (email: string) => {
    const response = await postJson('/auth/email/resend-verification', { email });
    assert.equal(response.status, 202);
    await response.text();
};
const verify = async (email: string, code: string) => {
    const response = await postJson('/auth/email/verify', { email, code });
    await response.text();
    return response.status;
};
const login = async (email: string, password: string) => {
    const response = await postJson('/auth/login', { identifier: email, password });
    await response.text();
    return response.status;
};
/** Returns a syntactically valid code that differs from the delivered one. */
const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

before(async () => {
    setTestEnvironment('AUTH_EMAIL_FROM', 'auth@example.test');
    setTestEnvironment('AUTH_CODE_PEPPER', 'synthetic-registration-lifecycle-pepper');
    setTestEnvironment('AWS_REGION', 'us-east-1');
    setTestEnvironment('JWT_SECRET', 'synthetic-registration-lifecycle-jwt-secret');
    installEmailCapture();
    harness = await startMongoReplicaSet('archtree-email-registration-lifecycle-test');
    const app = createApp({ environment: 'test' });
    server = await new Promise<Server>(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
    // Every case submits from loopback; isolate the shared per-IP and per-account windows.
    resetRateLimitWindowsForTests();
});

after(async () => {
    await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close(error => (error ? reject(error) : resolve()));
    });
    await harness?.stop();
    SESv2Client.prototype.send = originalSesSend;
    for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

test('a victim who registers after an attacker owns the account with the victim password once verified', async () => {
    const email = 'lorem.victim@example.test';
    const attackerPassword = 'Attacker lorem ipsum 739';
    const victimPassword = 'Victim dolor sit amet 842';
    await register(email, attackerPassword, 'Attacker Ipsum');
    await waitForDelivered(email, 1);
    await register(email, victimPassword, 'Victim Dolor');
    const victimCode = await waitForDelivered(email, 2);

    // The first registrant's sign-in answer must not change when someone else
    // registers the address, or it would signal when to send a newer attempt.
    assert.equal(await login(email, attackerPassword), 403, 'unverified accounts cannot sign in');
    assert.equal(await verify(email, victimCode), 204);
    assert.equal(await login(email, victimPassword), 200);
    assert.equal(await login(email, attackerPassword), 401);
    const user = await User.findByEmail(email);
    assert.equal(user?.displayName, 'Victim Dolor');
    assert.equal(user?.emailVerified, true);
});

test('a newer attempt voids the older code, and resend binds the newest attempt', async () => {
    const email = 'lorem.attempts@example.test';
    await register(email, 'First attempt lorem 101', 'Lorem First');
    const firstCode = await waitForDelivered(email, 1);
    await register(email, 'Second attempt ipsum 202', 'Lorem Second');
    const secondCode = await waitForDelivered(email, 2);
    await resend(email);
    const resentCode = await waitForDelivered(email, 3);

    assert.equal(await verify(email, firstCode), 400);
    assert.equal(await verify(email, secondCode), 400, 'resend replaced the second code');
    assert.equal(await verify(email, resentCode), 204);
    assert.equal(await login(email, 'Second attempt ipsum 202'), 200);
    assert.equal(await login(email, 'First attempt lorem 101'), 401);
    assert.equal((await User.findByEmail(email))?.displayName, 'Lorem Second');
});

test('five wrong verification codes void the code until a new one is requested', async () => {
    const email = 'lorem.verify-attempts@example.test';
    const password = 'Verify attempts lorem 303';
    await register(email, password, 'Lorem Attempts');
    const code = await waitForDelivered(email, 1);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal(await verify(email, wrongCode(code)), 400);
    }
    assert.equal(await verify(email, code), 400, 'the fifth wrong attempt voids the delivered code');
    assert.equal((await User.findByEmail(email))?.emailVerified, false);

    await resend(email);
    const replacement = await waitForDelivered(email, 2);
    assert.equal(await verify(email, replacement), 204);
    assert.equal(await login(email, password), 200);
});

test('five wrong reset codes void the code and leave the password unchanged', async () => {
    const email = 'lorem.reset-attempts@example.test';
    const password = 'Reset attempts lorem 404';
    await new User(email, await bcrypt.hash(password, 4), 'lorem-reset', [], 'user', 'Lorem Reset', true).save();
    const forgot = await postJson('/auth/password/forgot', { email });
    assert.equal(forgot.status, 202);
    const code = await waitForDelivered(email, 1);
    const reset = async (candidate: string, replacement: string) => {
        const response = await postJson('/auth/password/reset', { email, code: candidate, password: replacement });
        await response.text();
        return response.status;
    };
    const storedPassword = async () => (await User.findByEmail(email))!.password as string;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal(await reset(wrongCode(code), 'Replacement ipsum 505'), 400);
    }
    assert.equal(await reset(code, 'Replacement ipsum 505'), 400);
    assert.equal(await bcrypt.compare(password, await storedPassword()), true);

    const again = await postJson('/auth/password/forgot', { email });
    assert.equal(again.status, 202);
    const replacement = await waitForDelivered(email, 2);
    assert.equal(await reset(replacement, 'Replacement dolor 606'), 204);
    assert.equal(await login(email, 'Replacement dolor 606'), 200);
});

test('verification revokes sessions, provider identities and passkeys from before verification', async () => {
    const email = 'lorem.pre-verification@example.test';
    await register(email, 'Pre verification lorem 707', 'Lorem Pending');
    const code = await waitForDelivered(email, 1);
    const userId = (await User.findByEmail(email))!._id.toString();
    // These records cannot be created through the routes for an unverified
    // account; they model access left by an earlier release or a race.
    const sessionId = await AuthSession.create(userId, 'synthetic-pre-verification-refresh', new Date(Date.now() + 60_000));
    await AuthIdentity.create(userId, 'google', 'synthetic-pre-verification-subject');
    await Passkey.create({
        userId, credentialId: 'synthetic-pre-verification-credential', publicKey: 'synthetic',
        counter: 0, transports: [], deviceType: 'singleDevice', backedUp: false
    });
    await PasskeyChallenge.issue('register', 'synthetic-pre-verification-challenge', userId);

    assert.equal(await verify(email, code), 204);
    assert.equal(await AuthSession.findActiveById(sessionId), null);
    assert.equal(await getDb()!.collection('authIdentities').countDocuments({ userId }), 0);
    assert.equal(await getDb()!.collection('passkeys').countDocuments({ userId }), 0);
    assert.equal(await getDb()!.collection('passkeyChallenges').countDocuments({ userId }), 0);
    assert.equal(await login(email, 'Pre verification lorem 707'), 200);
});

test('a resend pressed as soon as registration responds, while its password is hashed, still delivers a code', async () => {
    const email = 'lorem.resend-hash-gap@example.test';
    const password = 'Resend hash gap lorem 818';
    const hashing = deferred(); const releaseHash = deferred();
    const originalHash = bcrypt.hash;
    // Hold only this registration's password hash, so the resend below is
    // guaranteed to arrive before the account exists or any email is sent.
    // bcrypt.compare calls hash with a callback, so that form passes through.
    bcrypt.hash = ((value: string, ...rest: unknown[]) => {
        const hash = () => (originalHash as (...args: unknown[]) => unknown).call(bcrypt, value, ...rest);
        if (value !== password || rest.length > 1) return hash();
        hashing.resolve();
        return releaseHash.promise.then(hash);
    }) as typeof bcrypt.hash;
    mailControls.set(email, { failures: 1 });
    try {
        await register(email, password, 'Lorem Hash Gap');
        await hashing.promise;
        await resend(email);
        // Give a resend that ignores the in-flight registration time to look up and drop.
        await pause(100);
        assert.equal(deliveries.get(email), undefined, 'nothing is sent while the registration hash is held');
        releaseHash.resolve();
        const code = await waitForDelivered(email, 1);
        assert.deepEqual(deliveries.get(email)?.map(attempt => attempt.outcome), ['failed', 'delivered']);
        assert.equal(await verify(email, code), 204);
        assert.equal(await login(email, password), 200);
    } finally {
        releaseHash.resolve();
        bcrypt.hash = originalHash;
        mailControls.delete(email);
    }
});

test('a resend pressed while registration creates the account still delivers a code after the first email fails', async () => {
    const email = 'lorem.resend-gap@example.test';
    const password = 'Resend gap lorem 808';
    const creating = deferred(); const release = deferred();
    const originalSave = User.prototype.save;
    // Hold account creation so the resend arrives while registration is in flight.
    User.prototype.save = async function (this: User) {
        if (this.email === email) { creating.resolve(); await release.promise; }
        return originalSave.call(this);
    };
    mailControls.set(email, { failures: 1 });
    try {
        await register(email, password, 'Lorem Gap');
        await creating.promise;
        await resend(email);
        // Give a resend that ignores the in-flight registration time to look up and drop.
        await pause(100);
        release.resolve();
        const code = await waitForDelivered(email, 1);
        assert.equal(deliveries.get(email)?.[0].outcome, 'failed');
        assert.equal(await verify(email, code), 204);
        assert.equal(await login(email, password), 200);
    } finally {
        release.resolve();
        User.prototype.save = originalSave;
        mailControls.delete(email);
    }
});

test('a resend pressed during a successful in-flight delivery coalesces into it', async () => {
    const email = 'lorem.resend-coalesce@example.test';
    const gate = deferred();
    mailControls.set(email, { gate: gate.promise, failures: 0 });
    try {
        await register(email, 'Resend coalesce lorem 909', 'Lorem Coalesce');
        await waitFor(() => (deliveries.get(email) ?? []).length === 1, 'the registration email to start sending');
        await resend(email);
        await pause(100);
        gate.resolve();
        const code = await waitForDelivered(email, 1);
        await pause(100);
        assert.equal(deliveries.get(email)?.length, 1, 'the resend reused the in-flight delivery');
        assert.equal(await verify(email, code), 204);
    } finally {
        gate.resolve();
        mailControls.delete(email);
    }
});

test('an attempt that loses an account-creation race still binds its own credentials', async () => {
    const email = 'lorem.creation-race@example.test';
    await register(email, 'Creation race first 111', 'Lorem Race First');
    await waitForDelivered(email, 1);
    const originalFind = User.findByEmail;
    let hidden = false;
    // Model another process that created the account after this attempt looked it up.
    User.findByEmail = (async (candidate: string) => {
        if (candidate === email && !hidden) { hidden = true; return null; }
        return originalFind.call(User, candidate);
    }) as typeof User.findByEmail;
    try {
        await register(email, 'Creation race second 222', 'Lorem Race Second');
        const code = await waitForDelivered(email, 2);
        User.findByEmail = originalFind;
        assert.equal(hidden, true);
        assert.equal(await verify(email, code), 204);
        assert.equal(await login(email, 'Creation race second 222'), 200);
        assert.equal(await getDb()!.collection('users').countDocuments({ email }), 1);
    } finally {
        User.findByEmail = originalFind;
    }
});
