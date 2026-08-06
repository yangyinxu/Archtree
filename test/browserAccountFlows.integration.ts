import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import bcrypt from 'bcryptjs';

import { createApp } from '../src/app';
import { getDb } from '../src/infrastructure/database';
import AuthSession from '../src/models/authSession';
import User from '../src/models/user';
import {
    MongoReplicaSetHarness,
    startMongoReplicaSet
} from './support/mongoReplicaSet';

const acceptedMessage = {
    message: 'If the account can use this action, an email has been sent.'
};

let baseUrl = '';
let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let originalSesSend: typeof SESv2Client.prototype.send;
const originalEnvironment = new Map<string, string | undefined>();
const deliveredCodes = new Map<string, string[]>();
const failedRecipients = new Set<string>();

const closeServer = (value?: Server) => new Promise<void>((resolve, reject) => {
    if (!value) return resolve();
    value.close((error) => error ? reject(error) : resolve());
});

/** Captures test codes at the mail boundary without logging or persisting plaintext codes. */
const installEmailCapture = () => {
    originalSesSend = SESv2Client.prototype.send;
    SESv2Client.prototype.send = (async (command: any) => {
        const recipient = String(command.input?.Destination?.ToAddresses?.[0] ?? '');
        const text = String(command.input?.Content?.Simple?.Body?.Text?.Data ?? '');
        const code = text.match(/\b(\d{6})\b/)?.[1];
        assert.ok(recipient && code, 'the auth email contains a recipient and six-digit code');
        if (failedRecipients.has(recipient)) {
            throw new Error('simulated email delivery failure');
        }
        deliveredCodes.set(recipient, [...(deliveredCodes.get(recipient) ?? []), code]);
        return {} as any;
    }) as typeof SESv2Client.prototype.send;
};

const setTestEnvironment = (name: string, value: string) => {
    originalEnvironment.set(name, process.env[name]);
    process.env[name] = value;
};

const browserPost = (
    pathname: string,
    body: Record<string, unknown>,
    origin = baseUrl
) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'Sec-Fetch-Site': origin === baseUrl ? 'same-origin' : 'cross-site'
    },
    body: JSON.stringify(body)
});

const latestCode = (email: string) => {
    const codes = deliveredCodes.get(email) ?? [];
    assert.ok(codes.length > 0, `a code was delivered to ${email}`);
    return codes[codes.length - 1];
};

before(async () => {
    setTestEnvironment('AUTH_EMAIL_FROM', 'auth@example.com');
    setTestEnvironment('AUTH_CODE_PEPPER', 'integration-code-pepper');
    setTestEnvironment('AWS_REGION', 'us-east-1');
    setTestEnvironment('JWT_SECRET', 'integration-jwt-secret');
    setTestEnvironment('APPLE_CLIENT_IDS', 'com.example.native');
    setTestEnvironment('GOOGLE_CLIENT_IDS', 'native-google-client');
    setTestEnvironment('WEBAUTHN_RP_ID', 'listener.example.com');
    setTestEnvironment('WEBAUTHN_ORIGIN', 'https://listener.example.com');
    installEmailCapture();

    harness = await startMongoReplicaSet('archtree-browser-account-flows-test');
    const app = createApp({ environment: 'test' });
    server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    await closeServer(server);
    await harness?.stop();
    SESv2Client.prototype.send = originalSesSend;
    for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

test('browser capability discovery excludes native-only providers', async () => {
    const appCapabilities = await fetch(`${baseUrl}/auth/capabilities`);
    assert.equal(appCapabilities.status, 200);
    assert.deepEqual(await appCapabilities.json(), {
        password: true,
        emailRegistration: true,
        apple: true,
        google: true,
        passkey: true
    });

    const browserCapabilities = await fetch(`${baseUrl}/auth/browser/capabilities`);
    assert.equal(browserCapabilities.status, 200);
    assert.equal(browserCapabilities.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await browserCapabilities.json(), {
        password: true,
        emailRegistration: true,
        apple: false,
        google: false,
        passkey: false
    });
});

test('browser registration and verification require same-origin JSON and single-use codes', async () => {
    const email = 'new-listener@example.com';
    const registration = {
        email,
        password: 'new-listener-password',
        displayName: 'New Listener'
    };
    const crossSite = await browserPost(
        '/auth/browser/register',
        registration,
        'https://attacker.example'
    );
    assert.equal(crossSite.status, 403);

    const formEncoded = await fetch(`${baseUrl}/auth/browser/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: baseUrl,
            'Sec-Fetch-Site': 'same-origin'
        },
        body: `email=${encodeURIComponent(email)}`
    });
    assert.equal(formEncoded.status, 415);

    const created = await browserPost('/auth/browser/register', registration);
    assert.equal(created.status, 202);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal(created.headers.get('set-cookie'), null);
    assert.deepEqual(await created.json(), acceptedMessage);
    const user = await User.findByEmail(email);
    assert.ok(user);
    assert.equal(user.emailVerified, false);
    const staleCode = latestCode(email);

    const resent = await browserPost('/auth/browser/email/resend-verification', { email });
    const missingResend = await browserPost('/auth/browser/email/resend-verification', {
        email: 'missing-listener@example.com'
    });
    assert.equal(resent.status, 202);
    assert.equal(missingResend.status, 202);
    assert.deepEqual(await resent.json(), acceptedMessage);
    assert.deepEqual(await missingResend.json(), acceptedMessage);

    const invalidExisting = await browserPost('/auth/browser/email/verify', {
        email,
        code: staleCode
    });
    const invalidMissing = await browserPost('/auth/browser/email/verify', {
        email: 'missing-listener@example.com',
        code: staleCode
    });
    assert.equal(invalidExisting.status, 400);
    assert.equal(invalidMissing.status, 400);
    assert.deepEqual(await invalidExisting.json(), await invalidMissing.json());

    const verificationCode = latestCode(email);
    const verified = await browserPost('/auth/browser/email/verify', {
        email,
        code: verificationCode
    });
    assert.equal(verified.status, 204);
    assert.equal(await verified.text(), '');
    assert.equal((await User.findByEmail(email))?.emailVerified, true);

    const reused = await browserPost('/auth/browser/email/verify', {
        email,
        code: verificationCode
    });
    assert.equal(reused.status, 400);
});

test('retired PUT registration is identical across account states and has no side effects', async () => {
    const email = 'retired-registration@example.com';
    const submit = (candidateEmail: string) => fetch(`${baseUrl}/auth/signup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: candidateEmail,
            password: 'retired-registration-password',
            username: 'Retired Listener'
        })
    });

    const missingAccount = await submit(email);
    const existingAccount = await submit('new-listener@example.com');
    assert.equal(missingAccount.status, 405);
    assert.equal(existingAccount.status, 405);
    assert.equal(missingAccount.headers.get('allow'), 'POST');
    assert.equal(existingAccount.headers.get('allow'), 'POST');
    const missingBody = await missingAccount.json();
    const existingBody = await existingAccount.json();
    assert.deepEqual(missingBody, existingBody);
    assert.deepEqual(missingBody, {
        message: 'Use POST /auth/signup.'
    });
    assert.equal(await User.findByEmail(email), null);
    assert.deepEqual(deliveredCodes.get(email), undefined);
});

test('Web form registration stays generic across delivery and account states', async () => {
    const email = 'generic-web-registration@example.com';
    const submit = () => fetch(`${baseUrl}/auth/signup-web`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: baseUrl,
            'Sec-Fetch-Site': 'same-origin'
        },
        body: new URLSearchParams({
            email,
            password: 'generic-web-registration-password',
            username: 'Generic Listener'
        })
    });

    failedRecipients.add(email);
    const newAccount = await submit();
    assert.equal(newAccount.status, 202);
    const genericBody = await newAccount.text();
    assert.match(genericBody, /If the account can be created, a verification code has been sent/);
    assert.doesNotMatch(genericBody, /Creating the account failed/);
    assert.equal((await User.findByEmail(email))?.emailVerified, false);

    const existingUnverified = await submit();
    assert.equal(existingUnverified.status, 202);
    assert.equal(await existingUnverified.text(), genericBody);

    const user = await User.findByEmail(email);
    assert.ok(user);
    await User.markEmailVerified(user._id.toString());
    const existingVerified = await submit();
    assert.equal(existingVerified.status, 202);
    assert.equal(await existingVerified.text(), genericBody);
    failedRecipients.delete(email);
});

test('password recovery is non-enumerating and reset revokes every session', async () => {
    const email = 'new-listener@example.com';
    const user = await User.findByEmail(email);
    assert.ok(user);
    const userId = user._id.toString();
    const activeSessionId = await AuthSession.create(
        userId,
        'pre-reset-refresh-hash',
        new Date(Date.now() + 60_000)
    );

    failedRecipients.add(email);
    const failedKnownRequest = await browserPost('/auth/browser/password/forgot', { email });
    const missingRequest = await browserPost('/auth/browser/password/forgot', {
        email: 'unknown-recovery@example.com'
    });
    assert.equal(failedKnownRequest.status, 202);
    assert.equal(missingRequest.status, 202);
    assert.deepEqual(await failedKnownRequest.json(), acceptedMessage);
    assert.deepEqual(await missingRequest.json(), acceptedMessage);

    failedRecipients.delete(email);
    const knownRequest = await browserPost('/auth/browser/password/forgot', { email });
    assert.equal(knownRequest.status, 202);
    assert.deepEqual(await knownRequest.json(), acceptedMessage);

    const resetCode = latestCode(email);
    const invalidExisting = await browserPost('/auth/browser/password/reset', {
        email,
        code: '000000',
        password: 'replacement-password-one'
    });
    const invalidMissing = await browserPost('/auth/browser/password/reset', {
        email: 'unknown-recovery@example.com',
        code: '000000',
        password: 'replacement-password-one'
    });
    assert.equal(invalidExisting.status, 400);
    assert.equal(invalidMissing.status, 400);
    assert.deepEqual(await invalidExisting.json(), await invalidMissing.json());

    const reset = await browserPost('/auth/browser/password/reset', {
        email,
        code: resetCode,
        password: 'replacement-password-two'
    });
    assert.equal(reset.status, 204);
    assert.equal(reset.headers.get('set-cookie'), null);
    assert.equal(await reset.text(), '');
    const updated = await User.findByEmail(email);
    assert.ok(updated);
    assert.equal(await bcrypt.compare('replacement-password-two', updated.password), true);
    assert.equal(await AuthSession.findActiveById(activeSessionId), null);

    const reused = await browserPost('/auth/browser/password/reset', {
        email,
        code: resetCode,
        password: 'replacement-password-three'
    });
    assert.equal(reused.status, 400);
});
