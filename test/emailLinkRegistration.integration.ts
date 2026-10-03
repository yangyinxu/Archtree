import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { request as httpRequest, Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { Collection, ObjectId } from 'mongodb';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import AuthActionToken from '../src/models/authActionToken';
import AuthIdentity from '../src/models/authIdentity';
import AuthSession from '../src/models/authSession';
import { hashEmailLinkToken } from '../src/models/emailLinkToken';
import { Passkey, PasskeyChallenge } from '../src/models/passkey';
import User from '../src/models/user';
import { deleteListenerAccountData } from '../src/services/accountDeletionService';
import { createSession } from '../src/services/authSessionService';
import { setEmailDomainResolver, type MxResolver } from '../src/services/emailDomainDeliverability';
import { MongoReplicaSetHarness, startMongoReplicaSet } from './support/mongoReplicaSet';

/**
 * Exercises Web email-link registration, mandatory verification and the
 * retired code endpoints through the real routes on a replica set. Generic
 * responses are sent before account work, so assertions about email and
 * accounts wait for the SES boundary or a security event instead of the
 * HTTP response.
 */
const linkOrigin = 'https://listen.example.test';
const webauthnRpId = 'listen.example.test';
const registrationAccepted = { message: 'Check your email for the next step.' };
const recoveryAccepted = { message: 'If the account can use this action, an email has been sent.' };
const verificationAccepted = { message: 'If this address needs verification, a link has been sent.' };
const linkInvalid = { code: 'link_invalid', message: 'This link is invalid, expired, or already used.' };
const domainUndeliverable = {
    code: 'email_domain_undeliverable',
    message: 'This email domain cannot receive email. Check the address and try again.'
};
const alreadyRegistered = {
    code: 'email_already_registered',
    message: 'This email already has an account. Log in or reset your password.'
};
const verificationRequired = {
    code: 'email_verification_required',
    message: 'Verify your email to sign in. Open the verification link we sent to your email address, then sign in again.'
};
const retired = {
    code: 'email_registration_moved',
    message: 'Email sign-up has moved to the Finitude website. Create your account there, then sign in.'
};
const subjects = {
    registration: 'Finish creating your Finitude account',
    alreadyRegistered: 'You already have a Finitude account',
    verification: 'Verify your Finitude email',
    reset: 'Reset your Finitude password'
};

let baseUrl = '';
let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let originalSesSend: typeof SESv2Client.prototype.send;
let originalInfo: typeof console.info;
const originalEnvironment = new Map<string, string | undefined>();

interface SentEmail { recipient: string; subject: string; text: string; token?: string; code?: string }
const sent: SentEmail[] = [];
const securityEvents: string[] = [];

const setTestEnvironment = (name: string, value: string) => {
    originalEnvironment.set(name, process.env[name]);
    process.env[name] = value;
};

/** Captures every authentication email at the SES boundary; nothing leaves the process. */
const installEmailCapture = () => {
    originalSesSend = SESv2Client.prototype.send;
    SESv2Client.prototype.send = (async (command: any) => {
        const recipient = String(command.input?.Destination?.ToAddresses?.[0] ?? '');
        const subject = String(command.input?.Content?.Simple?.Subject?.Data ?? '');
        const text = String(command.input?.Content?.Simple?.Body?.Text?.Data ?? '');
        sent.push({
            recipient,
            subject,
            text,
            token: text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1],
            code: subject === subjects.reset ? text.match(/\b(\d{6})\b/)?.[1] : undefined
        });
        return {} as any;
    }) as typeof SESv2Client.prototype.send;
};

/** Records security events (never containing addresses or tokens) so tests can wait for account work. */
const installSecurityEventCapture = () => {
    originalInfo = console.info;
    console.info = (value?: unknown, ...rest: unknown[]) => {
        try {
            const record = JSON.parse(String(value));
            if (record.category === 'security') securityEvents.push(record.event);
            if (record.category === 'security' || record.category === 'authentication_funnel') return;
        } catch {
            // Other diagnostics pass through unchanged.
        }
        originalInfo(value, ...rest);
    };
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

const sentTo = (email: string) => sent.filter(mail => mail.recipient === email);
const waitForEmail = async (email: string, count: number) => {
    await waitFor(() => sentTo(email).length >= count, `${count} email(s) for ${email}`);
    return sentTo(email)[count - 1];
};
const eventCount = (event: string) => securityEvents.filter(value => value === event).length;
const waitForEvent = (event: string, count: number) => waitFor(() => eventCount(event) >= count, `${count} ${event} event(s)`);

const postJson = (pathname: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
});
const browserPost = (pathname: string, body: unknown) => postJson(pathname, body, {
    Origin: baseUrl,
    'Sec-Fetch-Site': 'same-origin'
});
/** Sends a raw request so the test controls the Host header, which fetch does not allow. */
const rawPost = (pathname: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(`${baseUrl}${pathname}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers }
        }, response => {
            let data = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { data += chunk; });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data }));
        });
        request.on('error', reject);
        request.end(JSON.stringify(body));
    });

const requestRegistration = async (email: string) => {
    const response = await browserPost('/auth/browser/registration/request', { email });
    assert.equal(response.status, 202);
    return response.text();
};
const inspect = (token: string) => browserPost('/auth/browser/registration/inspect', { token });
const complete = (token: string, password: string, displayName: string) =>
    browserPost('/auth/browser/registration/complete', { token, password, displayName });
const login = async (identifier: string, password: string) => {
    const response = await postJson('/auth/login', { identifier, password });
    return { status: response.status, body: await response.json() as any };
};
const expectStatus = async (response: Promise<Response> | Response, status: number, body?: unknown) => {
    const resolved = await response;
    assert.equal(resolved.status, status);
    const text = await resolved.text();
    if (body !== undefined) assert.deepEqual(JSON.parse(text), body);
    return text ? JSON.parse(text) : undefined;
};

const hash = (password: string) => bcrypt.hash(password, 4);
const users = () => getDb()!.collection('users');
const linkTokens = () => getDb()!.collection('emailLinkTokens');

/** A verified account, as created by link registration or a provider. */
const verifiedAccount = async (email: string, password: string) => {
    const result = await new User(email, await hash(password), '', [], 'user', 'Verified Lorem', true).save();
    return result.insertedId.toString();
};

/**
 * An account created before verification existed. It is created verified so
 * a session predating the rule can be issued, then the field is removed.
 */
const legacyAccount = async (email: string, password: string) => {
    const userId = await verifiedAccount(email, password);
    const tokens = await createSession((await User.findById(userId)) as any);
    await users().updateOne({ _id: new ObjectId(userId) }, { $unset: { emailVerified: '' } });
    return { userId, tokens };
};

/**
 * A record left by the earlier code-based sign-up, with access an attacker
 * could have obtained before the guards existed: a session, an Apple
 * identity, a passkey, a pending enrollment, and a code slot.
 */
const pendingRecord = async (email: string, password: string) => {
    const result = await users().insertOne({
        email,
        password: await hash(password),
        username: 'attacker-ipsum',
        posts: [],
        role: 'user',
        displayName: 'Attacker Ipsum',
        emailVerified: false,
        pendingRegistration: { passwordHash: 'synthetic-attempt-hash', displayName: 'Attacker Attempt', username: '' }
    });
    const userId = result.insertedId.toHexString();
    const sessionId = await AuthSession.create(userId, `synthetic-${randomUUID()}`, new Date(Date.now() + 60_000));
    await AuthIdentity.create(userId, 'apple', `synthetic-apple-${randomUUID()}`, 'attacker-relay@example.test');
    await Passkey.create({
        userId, credentialId: `synthetic-${randomUUID()}`, publicKey: 'synthetic', counter: 0,
        transports: [], deviceType: 'singleDevice', backedUp: false
    });
    await PasskeyChallenge.issue('register', 'synthetic-enrollment', userId);
    await getDb()!.collection('authActionTokens').insertOne({
        _id: `synthetic-slot-${userId}` as any, userId, purpose: 'verifyEmail', codeHash: 'synthetic',
        createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
        registration: { passwordHash: 'synthetic-attempt-hash', displayName: 'Attacker Attempt', username: '' }
    });
    return { userId, sessionId };
};

const accessCounts = async (userId: string) => ({
    identities: await getDb()!.collection('authIdentities').countDocuments({ userId }),
    passkeys: await getDb()!.collection('passkeys').countDocuments({ userId }),
    challenges: await getDb()!.collection('passkeyChallenges').countDocuments({ userId }),
    codes: await getDb()!.collection('authActionTokens').countDocuments({ userId })
});

/** Fails the room-cleanup step of session revocation for one account, inside the outer transaction. */
const failSessionCleanup = (userId: string) => {
    const original = Collection.prototype.deleteMany;
    Collection.prototype.deleteMany = async function (filter, ...args) {
        if (this.collectionName === 'socialRealtimeTickets' && filter?.accountId === userId) {
            throw new Error('Synthetic cleanup failure');
        }
        return original.call(this, filter, ...args);
    } as typeof original;
    return () => { Collection.prototype.deleteMany = original; };
};

/** Stubs only the Google verifier boundary; every local write keeps its production behavior. */
const withGoogleIdentity = async <T>(identity: { sub: string; email: string }, run: () => Promise<T>) => {
    const original = OAuth2Client.prototype.verifyIdToken;
    OAuth2Client.prototype.verifyIdToken = (async () => ({ getPayload: () => ({
        ...identity, email_verified: true, nonce: 'synthetic-nonce'
    }) })) as typeof original;
    try { return await run(); } finally { OAuth2Client.prototype.verifyIdToken = original; }
};

/** A software ES256 authenticator producing real WebAuthn assertions for the configured RP. */
const softwarePasskey = () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    // COSE EC2 key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} in CBOR.
    const coseKey = Buffer.concat([
        Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'),
        Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')
    ]);
    const credentialId = crypto.randomBytes(16).toString('base64url');
    const assertion = (challenge: string, counter: number) => {
        const signCount = Buffer.alloc(4); signCount.writeUInt32BE(counter);
        // Flags: user present (0x01) and user verified (0x04).
        const authenticatorData = Buffer.concat([crypto.createHash('sha256').update(webauthnRpId).digest(), Buffer.from([0x05]), signCount]);
        const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: linkOrigin, crossOrigin: false }));
        const signature = crypto.sign('sha256', Buffer.concat([
            authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()
        ]), privateKey);
        return {
            id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {},
            response: {
                authenticatorData: authenticatorData.toString('base64url'),
                clientDataJSON: clientDataJSON.toString('base64url'),
                signature: signature.toString('base64url')
            }
        };
    };
    return { credentialId, publicKey: coseKey.toString('base64url'), assertion };
};

before(async () => {
    setTestEnvironment('AUTH_EMAIL_FROM', 'auth@example.test');
    setTestEnvironment('AUTH_CODE_PEPPER', 'synthetic-email-link-pepper');
    setTestEnvironment('AWS_REGION', 'us-east-1');
    setTestEnvironment('JWT_SECRET', 'synthetic-email-link-jwt-secret');
    setTestEnvironment('AUTH_LINK_ORIGIN', linkOrigin);
    setTestEnvironment('GOOGLE_CLIENT_IDS', 'synthetic-google-client');
    setTestEnvironment('WEBAUTHN_RP_ID', webauthnRpId);
    setTestEnvironment('WEBAUTHN_ORIGIN', linkOrigin);
    installEmailCapture();
    installSecurityEventCapture();
    harness = await startMongoReplicaSet('archtree-email-link-registration-test');
    const app = createApp({ environment: 'test' });
    server = await new Promise<Server>(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
    // Every case submits from loopback; isolate the per-IP, per-account and link-email windows.
    resetRateLimitWindowsForTests();
    securityEvents.length = 0;
});

after(async () => {
    await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close(error => (error ? reject(error) : resolve()));
    });
    await harness?.stop();
    SESv2Client.prototype.send = originalSesSend;
    console.info = originalInfo;
    for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

test('a new address registers through a single-use link built from AUTH_LINK_ORIGIN, then logs in', async () => {
    const email = 'lorem.new@example.test';
    const password = 'New listener lorem 101';
    // Links are never built from request headers.
    const requested = await rawPost('/auth/browser/registration/request', { email }, { Host: 'attacker.example.test' });
    assert.equal(requested.status, 202);
    assert.deepEqual(JSON.parse(requested.body), registrationAccepted);
    const mail = await waitForEmail(email, 1);
    assert.equal(mail.subject, subjects.registration);
    assert.ok(mail.token);
    assert.ok(mail.text.includes(`${linkOrigin}/finitude/register/complete#token=${mail.token}\n`));
    assert.doesNotMatch(mail.text, /attacker/);
    assert.equal(await User.findByEmail(email), null, 'a request creates no account');

    const stored = await linkTokens().find({ email }).toArray();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]._id, hashEmailLinkToken('registration', mail.token));
    assert.equal(JSON.stringify(stored).includes(mail.token), false, 'only the keyed hash is stored');

    await expectStatus(inspect(mail.token), 200, { email });
    await expectStatus(inspect(mail.token), 200, { email });
    await expectStatus(complete(mail.token, password, '  Lorem New  '), 201, { email });
    const user = (await User.findByEmail(email))!;
    assert.equal(user.emailVerified, true);
    assert.ok(user.emailVerifiedAt instanceof Date);
    assert.equal(user.displayName, 'Lorem New');
    assert.equal(await bcrypt.compare(password, user.password), true);
    assert.equal((await login(email, password)).status, 200);

    await expectStatus(complete(mail.token, 'Another lorem ipsum 202', 'Lorem Again'), 400, linkInvalid);
    await expectStatus(inspect(mail.token), 400, linkInvalid);
    assert.equal(await bcrypt.compare(password, (await User.findByEmail(email))!.password), true);
});

test('registration completion validates the link, password and display name before any work', async () => {
    const email = 'lorem.validation@example.test';
    await requestRegistration(email);
    const { token } = await waitForEmail(email, 1);
    await expectStatus(complete('not-a-token', 'Validation lorem 303', 'Lorem'), 400, linkInvalid);
    const weak = await expectStatus(complete(token!, 'short', 'Lorem'), 422);
    assert.equal(weak.code, 'invalid_password');
    for (const displayName of ['', '   ', 'x'.repeat(81), 'Lorem\u0007Ipsum', 42]) {
        const rejected = await expectStatus(complete(token!, 'Validation lorem 303', displayName as string), 422);
        assert.deepEqual(rejected, { code: 'invalid_display_name', message: 'Enter a display name between 1 and 80 characters.' });
    }
    assert.equal(await User.findByEmail(email), null);
    await expectStatus(inspect(token!), 200, { email });
});

test('an attacker cannot keep a pending record: the owner\'s link replaces it completely', async () => {
    const email = 'lorem.victim@example.test';
    const attackerPassword = 'Attacker lorem ipsum 739';
    const ownerPassword = 'Owner dolor sit amet 842';
    const { userId, sessionId } = await pendingRecord(email, attackerPassword);

    const attacker = await login(email, attackerPassword);
    assert.equal(attacker.status, 403);
    assert.deepEqual(attacker.body, verificationRequired);
    const mail = await waitForEmail(email, 1);
    assert.equal(mail.subject, subjects.registration, 'a pending record gets a registration link, never a verify link');
    assert.ok(mail.token);
    assert.equal(eventCount('login_verification_required'), 1);

    await expectStatus(inspect(mail.token), 200, { email });
    await expectStatus(complete(mail.token, ownerPassword, 'Owner Dolor'), 201, { email });
    const replaced = (await users().findOne({ _id: new ObjectId(userId) }))!;
    assert.equal(replaced.emailVerified, true);
    assert.equal(replaced.displayName, 'Owner Dolor');
    assert.equal(replaced.username, '');
    assert.equal(replaced.pendingRegistration, undefined);
    assert.deepEqual(Object.keys(replaced).sort(), [
        '_id', 'displayName', 'email', 'emailVerified', 'emailVerifiedAt', 'listenerMutationRevision',
        'password', 'passwordUpdatedAt', 'posts', 'role', 'username'
    ]);
    assert.equal(await users().countDocuments({ email }), 1);
    assert.equal(await AuthSession.findActiveById(sessionId), null);
    assert.deepEqual(await accessCounts(userId), { identities: 0, passkeys: 0, challenges: 0, codes: 0 });
    assert.equal(await linkTokens().countDocuments({ email, consumedAt: { $exists: false } }), 0);
    assert.equal((await login(email, attackerPassword)).status, 401);
    assert.equal((await login(email, ownerPassword)).status, 200);
});

test('every account state receives the identical registration response; accounts receive a notice only', async () => {
    const fresh = 'lorem.fresh@example.test';
    const verified = 'lorem.verified@example.test';
    const legacy = 'lorem.legacy-notice@example.test';
    const pending = 'lorem.pending-notice@example.test';
    const verifiedId = await verifiedAccount(verified, 'Verified lorem ipsum 404');
    await legacyAccount(legacy, 'Legacy lorem ipsum 505');
    await pendingRecord(pending, 'Pending lorem ipsum 606');
    const before = await users().findOne({ _id: new ObjectId(verifiedId) });

    const bodies = [await requestRegistration(fresh), await requestRegistration(verified),
        await requestRegistration(legacy), await requestRegistration(pending)];
    assert.equal(new Set(bodies).size, 1, 'the response body is byte-identical');
    assert.deepEqual(JSON.parse(bodies[0]), registrationAccepted);

    for (const email of [verified, legacy]) {
        const notice = await waitForEmail(email, 1);
        assert.equal(notice.subject, subjects.alreadyRegistered);
        assert.equal(notice.token, undefined);
        assert.ok(notice.text.includes(`${linkOrigin}/finitude/login\n`));
        assert.ok(notice.text.includes(`${linkOrigin}/finitude/forgot-password\n`));
        assert.equal(await linkTokens().countDocuments({ email }), 0);
    }
    assert.equal((await waitForEmail(fresh, 1)).subject, subjects.registration);
    assert.equal((await waitForEmail(pending, 1)).subject, subjects.registration);
    assert.deepEqual(await users().findOne({ _id: new ObjectId(verifiedId) }), before, 'nothing about the account changes');
});

test('a legacy account is blocked with a verification link, keeps its sessions, and verifies without a password change', async () => {
    const email = 'lorem.legacy@example.test';
    const password = 'Legacy lorem ipsum 404';
    const { userId, tokens } = await legacyAccount(email, password);
    // A relay address on a linked identity does not verify the account's own email.
    await AuthIdentity.create(userId, 'apple', `synthetic-apple-${randomUUID()}`, 'relay@privaterelay.example.test');
    const storedHash = (await User.findById(userId))!.password;

    const blocked = await login(email, password);
    assert.equal(blocked.status, 403);
    assert.deepEqual(blocked.body, verificationRequired);
    assert.equal((await login(email, 'Wrong lorem ipsum 000')).status, 401);
    const mail = await waitForEmail(email, 1);
    assert.equal(mail.subject, subjects.verification);
    assert.ok(mail.text.includes(`${linkOrigin}/finitude/verify-email#token=${mail.token}\n`));
    assert.ok(mail.text.includes('Your password doesn\'t change.'));
    assert.equal(sentTo(email).length, 1, 'a wrong password sends nothing');

    // Sessions that existed before the rule keep working.
    const refreshed = await postJson('/auth/refresh', { refreshToken: tokens.refreshToken });
    assert.equal(refreshed.status, 200);
    await refreshed.text();
    const me = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { emailVerified: boolean }).emailVerified, false);

    await expectStatus(browserPost('/auth/browser/email-verification/inspect', { token: mail.token }), 200, { email });
    await expectStatus(browserPost('/auth/browser/email-verification/inspect', { token: mail.token }), 200, { email });
    const confirmed = await browserPost('/auth/browser/email-verification/confirm', { token: mail.token });
    assert.equal(confirmed.status, 204);
    assert.equal(await confirmed.text(), '');
    const verified = (await User.findById(userId))!;
    assert.equal(verified.emailVerified, true);
    assert.equal(verified.password, storedHash, 'the password does not change');
    assert.equal((await login(email, password)).status, 200);
    assert.ok(await AuthSession.findActiveById(tokens.sessionId), 'confirmation keeps other sessions');
    assert.equal(await getDb()!.collection('authIdentities').countDocuments({ userId }), 1);
    await expectStatus(browserPost('/auth/browser/email-verification/confirm', { token: mail.token }), 400, linkInvalid);
});

test('the verification-link request answers identically and mails only legacy unverified accounts', async () => {
    const legacy = 'lorem.legacy-request@example.test';
    const verified = 'lorem.verified-request@example.test';
    const pending = 'lorem.pending-request@example.test';
    await legacyAccount(legacy, 'Legacy request lorem 707');
    await verifiedAccount(verified, 'Verified request lorem 808');
    await pendingRecord(pending, 'Pending request lorem 909');
    const bodies: string[] = [];
    for (const email of [verified, pending, 'lorem.absent-request@example.test', legacy]) {
        const response = await browserPost('/auth/browser/email-verification/request', { email });
        assert.equal(response.status, 202);
        bodies.push(await response.text());
    }
    assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(JSON.parse(bodies[0]), verificationAccepted);
    assert.equal((await waitForEmail(legacy, 1)).subject, subjects.verification);
    await pause(100);
    assert.deepEqual(sentTo(verified), []);
    assert.deepEqual(sentTo(pending), []);
});

test('a legacy account whose linked identity carries its own email counts as verified', async () => {
    const proven = 'lorem.proven@example.test';
    const unproven = 'lorem.unproven@example.test';
    const { userId: provenId } = await legacyAccount(proven, 'Proven lorem ipsum 111');
    await AuthIdentity.create(provenId, 'apple', `synthetic-apple-${randomUUID()}`, proven);
    const { userId: unprovenId } = await legacyAccount(unproven, 'Unproven lorem ipsum 222');
    await AuthIdentity.create(unprovenId, 'apple', `synthetic-apple-${randomUUID()}`, 'other@example.test');

    const signedIn = await login(proven, 'Proven lorem ipsum 111');
    assert.equal(signedIn.status, 200);
    const me = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${signedIn.body.accessToken}` } });
    assert.equal((await me.json() as { emailVerified: boolean }).emailVerified, true);
    assert.equal((await login(unproven, 'Unproven lorem ipsum 222')).status, 403);
});

test('completing one of two live links voids the other', async () => {
    const email = 'lorem.two-links@example.test';
    await requestRegistration(email);
    await requestRegistration(email);
    const first = (await waitForEmail(email, 1)).token!;
    const second = (await waitForEmail(email, 2)).token!;
    assert.notEqual(first, second);
    await expectStatus(inspect(first), 200, { email });
    await expectStatus(inspect(second), 200, { email });
    await expectStatus(complete(second, 'Second link lorem 333', 'Lorem Second'), 201, { email });
    await expectStatus(inspect(first), 400, linkInvalid);
    await expectStatus(complete(first, 'First link lorem 444', 'Lorem First'), 400, linkInvalid);
    assert.equal((await User.findByEmail(email))!.displayName, 'Lorem Second');
});

test('expired links are rejected by inspect, complete and confirm without changes', async () => {
    const email = 'lorem.expired@example.test';
    await requestRegistration(email);
    const registration = (await waitForEmail(email, 1)).token!;
    const legacy = 'lorem.expired-legacy@example.test';
    const { userId } = await legacyAccount(legacy, 'Expired legacy lorem 555');
    assert.equal((await login(legacy, 'Expired legacy lorem 555')).status, 403);
    const verification = (await waitForEmail(legacy, 1)).token!;
    await linkTokens().updateMany({ email: { $in: [email, legacy] } }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });

    await expectStatus(inspect(registration), 400, linkInvalid);
    await expectStatus(complete(registration, 'Expired lorem ipsum 666', 'Lorem Expired'), 400, linkInvalid);
    await expectStatus(browserPost('/auth/browser/email-verification/inspect', { token: verification }), 400, linkInvalid);
    await expectStatus(browserPost('/auth/browser/email-verification/confirm', { token: verification }), 400, linkInvalid);
    assert.equal(await User.findByEmail(email), null);
    assert.equal((await User.findById(userId))!.emailVerified, undefined);
    // A link for one purpose never works for the other.
    await expectStatus(browserPost('/auth/browser/email-verification/inspect', { token: registration }), 400, linkInvalid);
});

test('concurrent completions with two links create exactly one account', async () => {
    const email = 'lorem.concurrent@example.test';
    await requestRegistration(email);
    await requestRegistration(email);
    const tokens = [(await waitForEmail(email, 1)).token!, (await waitForEmail(email, 2)).token!];
    const responses = await Promise.all(tokens.map((token, index) => complete(token, `Concurrent lorem ${index} 777`, `Lorem ${index}`)));
    const statuses = responses.map(response => response.status).sort();
    await Promise.all(responses.map(response => response.text()));
    assert.equal(statuses[0], 201);
    assert.ok([400, 409].includes(statuses[1]), `the losing completion was ${statuses[1]}`);
    assert.equal(await users().countDocuments({ email }), 1);
});

test('a failed replacement rolls back completely and the same link works on retry', async () => {
    const email = 'lorem.rollback@example.test';
    const attackerPassword = 'Rollback attacker lorem 888';
    const { userId, sessionId } = await pendingRecord(email, attackerPassword);
    await requestRegistration(email);
    const { token } = await waitForEmail(email, 1);
    const restore = failSessionCleanup(userId);
    try {
        await expectStatus(complete(token!, 'Rollback owner lorem 999', 'Owner Rollback'), 500);
    } finally { restore(); }
    const unchanged = (await users().findOne({ _id: new ObjectId(userId) }))!;
    assert.equal(unchanged.emailVerified, false);
    assert.equal(await bcrypt.compare(attackerPassword, unchanged.password), true);
    assert.ok(await AuthSession.findActiveById(sessionId));
    assert.deepEqual(await accessCounts(userId), { identities: 1, passkeys: 1, challenges: 1, codes: 1 });
    await expectStatus(inspect(token!), 200, { email });

    await expectStatus(complete(token!, 'Rollback owner lorem 999', 'Owner Rollback'), 201, { email });
    assert.equal((await users().findOne({ _id: new ObjectId(userId) }))!.emailVerified, true);
});

test('a failed new-account completion leaves no account and keeps the link usable', async () => {
    const email = 'lorem.rollback-new@example.test';
    await requestRegistration(email);
    const { token } = await waitForEmail(email, 1);
    const original = Collection.prototype.deleteMany;
    Collection.prototype.deleteMany = async function (filter, ...args) {
        if (this.collectionName === 'emailLinkTokens') throw new Error('Synthetic cleanup failure');
        return original.call(this, filter, ...args);
    } as typeof original;
    try {
        await expectStatus(complete(token!, 'Rollback new lorem 121', 'Lorem Rollback'), 500);
    } finally { Collection.prototype.deleteMany = original; }
    assert.equal(await User.findByEmail(email), null);
    await expectStatus(inspect(token!), 200, { email });
    await expectStatus(complete(token!, 'Rollback new lorem 121', 'Lorem Rollback'), 201, { email });
});

test('each address receives at most three link emails per window, with unchanged responses', async () => {
    const email = 'lorem.budget@example.test';
    const attackerPassword = 'Budget attacker lorem 131';
    await pendingRecord(email, attackerPassword);
    const bodies = [];
    for (let attempt = 0; attempt < 4; attempt += 1) bodies.push(await requestRegistration(email));
    assert.equal(new Set(bodies).size, 1);
    await waitForEmail(email, 3);
    await waitForEvent('auth_link_email_suppressed', 1);
    assert.equal(sentTo(email).length, 3);
    assert.equal(await linkTokens().countDocuments({ email }), 3, 'a suppressed email writes no token');

    const blocked = await login(email, attackerPassword);
    assert.equal(blocked.status, 403);
    assert.deepEqual(blocked.body, verificationRequired, 'the sign-in answer does not reveal the budget');
    await waitForEvent('auth_link_email_suppressed', 2);
    assert.equal(sentTo(email).length, 3);
});

/** Synthetic DNS for one test: listed domains fail with a `node:dns` code, every other domain has an MX host. */
const failingDomains = (codes: Record<string, string>): MxResolver => async domain => {
    const code = codes[domain];
    if (code) throw Object.assign(new Error(`synthetic ${code}`), { code });
    return [{ exchange: `mx.${domain}`, priority: 10 }];
};

test('requests for a domain that cannot receive mail get one 422 for every account state and change nothing', async t => {
    const previous = setEmailDomainResolver(failingDomains({ 'typo.example.test': 'ENOTFOUND' }));
    t.after(() => setEmailDomainResolver(previous));
    const fresh = 'lorem.fresh@typo.example.test';
    const verified = 'lorem.verified@typo.example.test';
    const legacy = 'lorem.legacy@typo.example.test';
    const pending = 'lorem.pending@typo.example.test';
    const legacyPassword = 'Typo legacy lorem 252';
    const verifiedId = await verifiedAccount(verified, 'Typo verified lorem 262');
    await legacyAccount(legacy, legacyPassword);
    const { userId: pendingId } = await pendingRecord(pending, 'Typo pending lorem 242');
    const pendingBefore = await accessCounts(pendingId);

    const rejectedBodies = new Set<string>();
    const expectRejected = async (response: Promise<Response>) => {
        const body = await expectStatus(response, 422, domainUndeliverable);
        rejectedBodies.add(JSON.stringify(body));
    };
    // Three requests for the fresh address would spend its whole link-email budget if they counted.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await expectRejected(browserPost('/auth/browser/registration/request', { email: fresh }));
    }
    await expectRejected(browserPost('/auth/browser/registration/request', { email: verified }));
    await expectRejected(browserPost('/auth/browser/registration/request', { email: pending }));
    await expectRejected(browserPost('/auth/browser/email-verification/request', { email: legacy }));
    await expectRejected(browserPost('/auth/browser/email-verification/request', { email: fresh }));
    await expectRejected(postJson('/auth/password/forgot', { email: verified }));
    await expectRejected(postJson('/auth/password/forgot', { email: fresh }));
    await expectRejected(browserPost('/auth/browser/password/forgot', { email: pending }));
    await expectRejected(browserPost('/auth/browser/password/forgot', { email: fresh }));
    assert.equal(rejectedBodies.size, 1, 'the rejection is identical with and without an account');
    assert.equal(eventCount('auth_email_domain_rejected'), 11);

    // A sign-in still answers 403 and skips the email at send time (defense in depth).
    const blocked = await login(legacy, legacyPassword);
    assert.equal(blocked.status, 403);
    assert.deepEqual(blocked.body, verificationRequired, 'the sign-in answer does not reveal the skipped email');
    await waitForEvent('auth_email_undeliverable_domain', 1);
    await pause(50);
    assert.deepEqual(sent.filter(mail => mail.recipient.endsWith('@typo.example.test')), []);
    assert.equal(await linkTokens().countDocuments({ email: { $in: [fresh, verified, legacy, pending] } }), 0);
    assert.equal(await getDb()!.collection('authActionTokens').countDocuments({ userId: verifiedId }), 0);
    assert.deepEqual(await accessCounts(pendingId), pendingBefore, 'the pending record keeps every slot it had');

    // Once the domain receives mail, the address still has its full link-email budget.
    setEmailDomainResolver(failingDomains({}));
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.deepEqual(JSON.parse(await requestRegistration(fresh)), registrationAccepted);
    }
    await waitForEmail(fresh, 3);
    assert.equal(eventCount('auth_link_email_suppressed'), 0);
});

test('an undeliverable request never replaces a delivered reset code, and a DNS failure still sends', async t => {
    const email = 'lorem.code-kept@mail.example.test';
    const password = 'Code kept lorem 272';
    await verifiedAccount(email, password);
    const previous = setEmailDomainResolver(failingDomains({}));
    t.after(() => setEmailDomainResolver(previous));
    await expectStatus(postJson('/auth/password/forgot', { email }), 202, recoveryAccepted);
    const { code } = await waitForEmail(email, 1);

    // The domain later stops resolving (a fresh resolver also drops the cached verdict).
    setEmailDomainResolver(failingDomains({ 'mail.example.test': 'ENODATA' }));
    await expectStatus(postJson('/auth/password/forgot', { email }), 422, domainUndeliverable);
    await expectStatus(browserPost('/auth/browser/password/forgot', { email }), 422, domainUndeliverable);
    await pause(50);
    assert.equal(sentTo(email).length, 1);
    assert.equal(eventCount('auth_email_domain_rejected'), 2);
    await expectStatus(postJson('/auth/password/reset', { email, code, password: 'Code kept replacement 282' }), 204);

    setEmailDomainResolver(failingDomains({ 'mail.example.test': 'ESERVFAIL' }));
    await expectStatus(postJson('/auth/password/forgot', { email }), 202, recoveryAccepted);
    assert.equal((await waitForEmail(email, 2)).subject, subjects.reset, 'a resolver failure fails open');
    assert.equal(eventCount('auth_email_domain_check_failed'), 1);
});

test('retired code-based endpoints answer 410 without writes or email, and the old sign-up page redirects', async () => {
    const email = 'lorem.retired@example.test';
    const usersBefore = await users().countDocuments();
    const body = { email, password: 'Retired lorem ipsum 141', displayName: 'Lorem Retired', code: '123456' };
    for (const [method, path] of [
        ['POST', '/auth/signup'], ['PUT', '/auth/signup'], ['POST', '/auth/email/verify'],
        ['POST', '/auth/email/resend-verification'], ['POST', '/auth/browser/register'],
        ['POST', '/auth/browser/email/verify'], ['POST', '/auth/browser/email/resend-verification']
    ]) {
        const response = await fetch(`${baseUrl}${path}`, {
            method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        await expectStatus(response, 410, retired);
    }
    assert.equal(eventCount('retired_registration_endpoint'), 7);
    for (const method of ['GET', 'POST']) {
        const response = await fetch(`${baseUrl}/auth/signup-web`, {
            method,
            redirect: 'manual',
            ...(method === 'POST' ? {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ email, password: body.password, username: 'lorem' })
            } : {})
        });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/finitude/register');
    }
    await pause(50);
    assert.equal(await users().countDocuments(), usersBefore);
    assert.equal(await linkTokens().countDocuments({ email }), 0);
    assert.deepEqual(sentTo(email), []);
});

test('password recovery sends pending records a registration link and verifies legacy accounts on reset', async () => {
    const pending = 'lorem.recovery-pending@example.test';
    const { userId: pendingId } = await pendingRecord(pending, 'Recovery pending lorem 151');
    await expectStatus(browserPost('/auth/browser/password/forgot', { email: pending }), 202, recoveryAccepted);
    const pendingMail = await waitForEmail(pending, 1);
    assert.equal(pendingMail.subject, subjects.registration);
    assert.ok(pendingMail.token);
    assert.equal(await getDb()!.collection('authActionTokens').countDocuments({ userId: pendingId, purpose: 'resetPassword' }), 0);

    const legacy = 'lorem.recovery-legacy@example.test';
    const { userId: legacyId, tokens } = await legacyAccount(legacy, 'Recovery legacy lorem 161');
    await AuthIdentity.create(legacyId, 'apple', `synthetic-apple-${randomUUID()}`, 'squatter@example.test');
    await Passkey.create({ userId: legacyId, credentialId: `synthetic-${randomUUID()}`, publicKey: 'synthetic',
        counter: 0, transports: [], deviceType: 'singleDevice', backedUp: false });
    await PasskeyChallenge.issue('register', 'synthetic-enrollment', legacyId);
    await expectStatus(browserPost('/auth/browser/password/forgot', { email: legacy }), 202, recoveryAccepted);
    const legacyMail = await waitForEmail(legacy, 1);
    assert.equal(legacyMail.subject, subjects.reset);
    assert.ok(legacyMail.code);
    const reset = await browserPost('/auth/browser/password/reset', { email: legacy, code: legacyMail.code, password: 'Recovered legacy lorem 171' });
    assert.equal(reset.status, 204);
    await reset.text();
    assert.equal((await User.findById(legacyId))!.emailVerified, true);
    assert.equal(await AuthSession.findActiveById(tokens.sessionId), null);
    assert.deepEqual(await accessCounts(legacyId), { identities: 0, passkeys: 0, challenges: 0, codes: 1 });
    assert.equal((await login(legacy, 'Recovered legacy lorem 171')).status, 200);

    const verified = 'lorem.recovery-verified@example.test';
    const verifiedId = await verifiedAccount(verified, 'Recovery verified lorem 181');
    await AuthIdentity.create(verifiedId, 'google', `synthetic-google-${randomUUID()}`, verified);
    await expectStatus(postJson('/auth/password/forgot', { email: verified }), 202, recoveryAccepted);
    const verifiedMail = await waitForEmail(verified, 1);
    await expectStatus(postJson('/auth/password/reset', { email: verified, code: verifiedMail.code, password: 'Recovered verified lorem 191' }), 204);
    assert.equal(await getDb()!.collection('authIdentities').countDocuments({ userId: verifiedId }), 1);
});

test('a reset never applies to a pending record', async () => {
    const email = 'lorem.reset-pending@example.test';
    const password = 'Reset pending lorem 202';
    const { userId, sessionId } = await pendingRecord(email, password);
    const code = await AuthActionToken.issue(userId, 'resetPassword', 15);
    await expectStatus(postJson('/auth/password/reset', { email, code, password: 'Reset pending other 212' }), 400,
        { message: 'The reset code is invalid or expired.' });
    const unchanged = (await users().findOne({ _id: new ObjectId(userId) }))!;
    assert.equal(unchanged.emailVerified, false);
    assert.equal(await bcrypt.compare(password, unchanged.password), true);
    assert.ok(await AuthSession.findActiveById(sessionId));
    const slot = await getDb()!.collection('authActionTokens').findOne({ userId, purpose: 'resetPassword' });
    assert.equal(slot?.consumedAt, undefined);
});

test('five wrong reset codes void the code and leave the password unchanged', async () => {
    const email = 'lorem.reset-attempts@example.test';
    const password = 'Reset attempts lorem 404';
    await verifiedAccount(email, password);
    await expectStatus(postJson('/auth/password/forgot', { email }), 202, recoveryAccepted);
    const { code } = await waitForEmail(email, 1);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
        await expectStatus(postJson('/auth/password/reset', { email, code: wrong, password: 'Replacement ipsum 505' }), 400);
    }
    await expectStatus(postJson('/auth/password/reset', { email, code, password: 'Replacement ipsum 505' }), 400);
    assert.equal(await bcrypt.compare(password, (await User.findByEmail(email))!.password), true);
});

test('a passkey sign-in for a legacy account is blocked with a link; unverified sessions cannot add methods', async () => {
    const email = 'lorem.passkey@example.test';
    const { userId, tokens } = await legacyAccount(email, 'Passkey legacy lorem 222');
    const authenticator = softwarePasskey();
    await Passkey.create({ userId, credentialId: authenticator.credentialId, publicKey: authenticator.publicKey,
        counter: 0, transports: ['internal'], deviceType: 'multiDevice', backedUp: true });

    const options = await expectStatus(postJson('/auth/passkeys/authenticate/options', {}), 200);
    const verified = await postJson('/auth/passkeys/authenticate/verify', {
        flowId: options.flowId, credential: authenticator.assertion(options.options.challenge, 1)
    });
    await expectStatus(verified, 403, verificationRequired);
    assert.equal((await waitForEmail(email, 1)).subject, subjects.verification);
    assert.equal(await getDb()!.collection('authSessions').countDocuments({ userId, revokedAt: { $exists: false } }), 1,
        'only the pre-existing session remains');

    const bearer = { Authorization: `Bearer ${tokens.accessToken}` };
    const enroll = await postJson('/auth/passkeys/register/options', {}, bearer);
    const enrollBody = await expectStatus(enroll, 403);
    assert.equal(enrollBody.code, 'email_verification_required');
    assert.equal(enrollBody.message, 'Verify your email before adding a sign-in method.');
    const subject = `synthetic-google-${randomUUID()}`;
    await withGoogleIdentity({ sub: subject, email: 'lorem.linked@example.test' }, async () => {
        const linked = await postJson('/auth/google', { identityToken: 'synthetic-google-token', nonce: 'synthetic-nonce' }, bearer);
        const linkBody = await expectStatus(linked, 403);
        assert.equal(linkBody.code, 'email_verification_required');
    });
    assert.equal(await AuthIdentity.find('google', subject), null);
    await pause(50);
    assert.equal(sentTo(email).length, 1, 'adding a method sends no email');
});

test('Google sign-in whose verified email matches a pending record replaces it and signs in', async () => {
    const email = 'lorem.google-owner@example.test';
    const { userId, sessionId } = await pendingRecord(email, 'Google squatter lorem 232');
    const subject = `synthetic-google-${randomUUID()}`;
    const body = await withGoogleIdentity({ sub: subject, email }, async () =>
        expectStatus(postJson('/auth/google', { identityToken: 'synthetic-google-token', nonce: 'synthetic-nonce' }), 200));
    assert.equal(body.userId, userId);
    assert.ok(body.accessToken && body.refreshToken);
    const replaced = (await users().findOne({ _id: new ObjectId(userId) }))!;
    assert.equal(replaced.emailVerified, true);
    assert.equal(replaced.password, '');
    assert.equal(replaced.pendingRegistration, undefined);
    assert.match(replaced.username, /^google_[0-9a-f]{20}$/);
    assert.equal(await AuthSession.findActiveById(sessionId), null);
    const identities = await getDb()!.collection('authIdentities').find({ userId }).toArray();
    assert.deepEqual(identities.map(identity => [identity.provider, identity.providerSubject]), [['google', subject]]);
    assert.equal(await getDb()!.collection('passkeys').countDocuments({ userId }), 0);
    assert.equal(eventCount('federated_account_replaced_pending'), 1);
});

test('account deletion removes the account\'s email links', async () => {
    const email = 'lorem.deleted@example.test';
    const { userId } = await legacyAccount(email, 'Deleted legacy lorem 242');
    await expectStatus(browserPost('/auth/browser/email-verification/request', { email }), 202, verificationAccepted);
    await waitForEmail(email, 1);
    assert.equal(await linkTokens().countDocuments({ userId }), 1);
    assert.equal((await deleteListenerAccountData(userId)).status, 'deleted');
    assert.equal(await linkTokens().countDocuments({ userId }), 0);
});
