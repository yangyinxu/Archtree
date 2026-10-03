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
const registrationAccepted = { message: 'Check your email for the next step.' };
const retiredBody = {
    code: 'email_registration_moved',
    message: 'Email sign-up has moved to the Finitude website. Create your account there, then sign in.'
};

let baseUrl = '';
let harness: MongoReplicaSetHarness | undefined;
let server: Server | undefined;
let originalSesSend: typeof SESv2Client.prototype.send;
const originalEnvironment = new Map<string, string | undefined>();
const deliveredCodes = new Map<string, string[]>();
const deliveredLinks = new Map<string, string[]>();
const deliveryAttempts = new Map<string, number>();
const failedRecipients = new Set<string>();

const closeServer = (value?: Server) => new Promise<void>((resolve, reject) => {
    if (!value) return resolve();
    value.close((error) => error ? reject(error) : resolve());
});

/** Captures test codes and link tokens at the mail boundary without logging or persisting them. */
const installEmailCapture = () => {
    originalSesSend = SESv2Client.prototype.send;
    SESv2Client.prototype.send = (async (command: any) => {
        const recipient = String(command.input?.Destination?.ToAddresses?.[0] ?? '');
        const text = String(command.input?.Content?.Simple?.Body?.Text?.Data ?? '');
        const code = text.match(/\b(\d{6})\b/)?.[1];
        const token = text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
        assert.ok(recipient, 'the auth email has a recipient');
        deliveryAttempts.set(recipient, (deliveryAttempts.get(recipient) ?? 0) + 1);
        if (failedRecipients.has(recipient)) {
            throw new Error('simulated email delivery failure');
        }
        if (code) deliveredCodes.set(recipient, [...(deliveredCodes.get(recipient) ?? []), code]);
        if (token) deliveredLinks.set(recipient, [...(deliveredLinks.get(recipient) ?? []), token]);
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

/**
 * Generic email responses are sent before account work, so assertions about a
 * code or account wait for the mail boundary instead of the HTTP response.
 */
const expectDeliveryAttempt = async (email: string, request: () => Promise<Response>) => {
    const expected = (deliveryAttempts.get(email) ?? 0) + 1;
    const response = await request();
    const deadline = Date.now() + 10_000;
    while ((deliveryAttempts.get(email) ?? 0) < expected) {
        assert.ok(Date.now() < deadline, `an email delivery was attempted for ${email}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return response;
};

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
    setTestEnvironment('AUTH_LINK_ORIGIN', 'https://listen.example.test');
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

test('browser registration requests require same-origin JSON and answer generically', async () => {
    const email = 'new-listener@example.com';
    const crossSite = await browserPost('/auth/browser/registration/request', { email }, 'https://attacker.example');
    assert.equal(crossSite.status, 403);

    const formEncoded = await fetch(`${baseUrl}/auth/browser/registration/request`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: baseUrl,
            'Sec-Fetch-Site': 'same-origin'
        },
        body: `email=${encodeURIComponent(email)}`
    });
    assert.equal(formEncoded.status, 415);

    const invalid = await browserPost('/auth/browser/registration/request', { email: 'not-an-email' });
    assert.equal(invalid.status, 422);

    const requested = await expectDeliveryAttempt(email, () => browserPost('/auth/browser/registration/request', { email }));
    assert.equal(requested.status, 202);
    assert.equal(requested.headers.get('cache-control'), 'no-store');
    assert.equal(requested.headers.get('set-cookie'), null);
    assert.deepEqual(await requested.json(), registrationAccepted);
    assert.equal(await User.findByEmail(email), null, 'requesting a link creates no account');
    const token = (deliveredLinks.get(email) ?? []).at(-1)!;
    assert.ok(token);

    for (const path of ['/auth/browser/registration/inspect', '/auth/browser/registration/complete',
        '/auth/browser/email-verification/inspect', '/auth/browser/email-verification/confirm',
        '/auth/browser/email-verification/request']) {
        const rejected = await browserPost(path, { token, email }, 'https://attacker.example');
        assert.equal(rejected.status, 403, `${path} rejects cross-site requests`);
    }
    const inspected = await browserPost('/auth/browser/registration/inspect', { token });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.headers.get('set-cookie'), null);
    assert.deepEqual(await inspected.json(), { email });

    const completed = await browserPost('/auth/browser/registration/complete', {
        token, password: 'new-listener-password', displayName: 'New Listener'
    });
    assert.equal(completed.status, 201);
    assert.equal(completed.headers.get('set-cookie'), null, 'completion installs no session (log in next)');
    assert.deepEqual(await completed.json(), { email });
    const user = await User.findByEmail(email);
    assert.equal(user?.emailVerified, true);
    assert.equal(user?.displayName, 'New Listener');
});

test('retired code-based registration routes answer 410 without side effects', async () => {
    const email = 'retired-registration@example.com';
    const body = { email, password: 'retired-registration-password', displayName: 'Retired Listener', code: '123456' };
    const attemptsBefore = deliveryAttempts.get(email) ?? 0;
    const retired: Array<[string, string, string?]> = [
        ['POST', '/auth/signup'], ['PUT', '/auth/signup'], ['POST', '/auth/email/verify'],
        ['POST', '/auth/email/resend-verification'], ['POST', '/auth/browser/register', baseUrl],
        ['POST', '/auth/browser/email/verify', baseUrl], ['POST', '/auth/browser/email/resend-verification', baseUrl],
        // A cross-site browser request also gets the retirement notice and nothing else.
        ['POST', '/auth/browser/register', 'https://attacker.example']
    ];
    for (const [method, path, origin] of retired) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 410, `${method} ${path}`);
        assert.deepEqual(await response.json(), retiredBody);
    }
    assert.equal(await User.findByEmail(email), null);
    assert.equal(await getDb()!.collection('emailLinkTokens').countDocuments({ email }), 0);
    assert.equal(deliveryAttempts.get(email) ?? 0, attemptsBefore);
});

test('the Archtree sign-up page and form redirect to Web registration without account work', async () => {
    const email = 'generic-web-registration@example.com';
    const page = await fetch(`${baseUrl}/auth/signup-web`, { redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/finitude/register');
    const form = await fetch(`${baseUrl}/auth/signup-web`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: baseUrl,
            'Sec-Fetch-Site': 'same-origin'
        },
        body: new URLSearchParams({ email, password: 'generic-web-registration-password', username: 'Generic Listener' })
    });
    assert.equal(form.status, 303);
    assert.equal(form.headers.get('location'), '/finitude/register');
    assert.equal(await User.findByEmail(email), null);
    assert.equal(deliveryAttempts.get(email), undefined);
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
    const failedKnownRequest = await expectDeliveryAttempt(
        email,
        () => browserPost('/auth/browser/password/forgot', { email })
    );
    const missingRequest = await browserPost('/auth/browser/password/forgot', {
        email: 'unknown-recovery@example.com'
    });
    assert.equal(failedKnownRequest.status, 202);
    assert.equal(missingRequest.status, 202);
    assert.deepEqual(await failedKnownRequest.json(), acceptedMessage);
    assert.deepEqual(await missingRequest.json(), acceptedMessage);

    failedRecipients.delete(email);
    const knownRequest = await expectDeliveryAttempt(
        email,
        () => browserPost('/auth/browser/password/forgot', { email })
    );
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
