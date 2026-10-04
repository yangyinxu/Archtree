import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before, type TestContext } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createApp } from '../src/app';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import AuthActionToken from '../src/models/authActionToken';
import AuthIdentity from '../src/models/authIdentity';
import EmailLinkToken from '../src/models/emailLinkToken';
import User from '../src/models/user';
import { ServerLifecycle } from '../src/services/serverLifecycleService';

const acceptedMessage = { message: 'If the account can use this action, an email has been sent.' };
const registrationAccepted = { message: 'Check your email for the next step.' };
const verificationAccepted = { message: 'If this address needs verification, a link has been sent.' };
const emailEnvironment = {
    AUTH_EMAIL_FROM: 'auth@example.test',
    AUTH_CODE_PEPPER: 'synthetic-unit-test-pepper',
    AWS_REGION: 'us-east-1',
    AUTH_LINK_ORIGIN: 'https://listen.example.test'
};
const originalEnvironment = new Map<string, string | undefined>();

before(() => {
    for (const [name, value] of Object.entries(emailEnvironment)) {
        originalEnvironment.set(name, process.env[name]);
        process.env[name] = value;
    }
});

after(() => {
    for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

interface SyntheticAccount {
    _id: { toString(): string };
    email: string;
    /** Omitted for an account created before verification existed. */
    emailVerified?: boolean;
}

const syntheticAccount = (id: string, email: string, emailVerified?: boolean): SyntheticAccount => ({
    _id: { toString: () => id },
    email,
    ...(emailVerified === undefined ? {} : { emailVerified })
});

/**
 * Replaces persistence and the SES boundary with in-memory fakes. Every delivery
 * waits on a gate the test opens only after it has observed the HTTP response,
 * so a handler that awaits delivery before responding fails after the fallback
 * timeout instead of hanging. Nothing here opens MongoDB or a network client.
 */
const installAccountFakes = (
    t: TestContext,
    accounts: SyntheticAccount[],
    delivery: 'delivered' | 'failed'
) => {
    const timeline: string[] = [];
    const recipients: string[] = [];
    const known = new Map(accounts.map(account => [account.email, account]));
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    const fallback = setTimeout(openGate, 2_000);
    t.after(() => clearTimeout(fallback));
    let started!: () => void;
    const deliveryStarted = new Promise<void>(resolve => { started = resolve; });

    t.mock.method(User, 'findByEmail', async (email: string) => known.get(email) ?? null);
    t.mock.method(User, 'findById', async (id: string) =>
        [...known.values()].find(account => account._id.toString() === id) ?? null);
    t.mock.method(AuthIdentity, 'hasEmailForUser', async () => false);
    t.mock.method(AuthActionToken, 'issue', async () => '135790');
    t.mock.method(EmailLinkToken, 'issue', async () => 'S'.repeat(43));
    t.mock.method(SESv2Client.prototype, 'send', async (command: any) => {
        recipients.push(String(command.input?.Destination?.ToAddresses?.[0] ?? ''));
        started();
        await gate;
        if (delivery === 'failed') {
            timeline.push('email-failed');
            throw new Error('synthetic delivery failure');
        }
        timeline.push('email-delivered');
        return {};
    });
    t.mock.method(console, 'info', (value: unknown) => {
        try {
            const record = JSON.parse(String(value));
            if (record.category === 'security') timeline.push(`security:${record.event}`);
        } catch {
            // Non-JSON diagnostics are irrelevant to the account-work timeline.
        }
    });
    const errors: string[] = [];
    t.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values.map(String).join(' ')); });

    return {
        timeline,
        recipients,
        errors,
        deliveryStarted,
        releaseDelivery: () => { clearTimeout(fallback); openGate(); }
    };
};

/** Runs the real application routes on loopback with an owned lifecycle for shutdown assertions. */
const startApplication = async (t: TestContext) => {
    // Each case starts with fresh per-IP, per-account and link-email windows.
    resetRateLimitWindowsForTests();
    const lifecycle = new ServerLifecycle();
    const server = createServer(createApp({ environment: 'test', lifecycle }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        if (server.listening) server.close();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    /** Stops admission and resolves only after tracked request work and the fake database close. */
    const stop = (timeline: string[]) => lifecycle.stop(
        server,
        async () => { timeline.push('database-closed'); },
        5_000,
        1_000
    );
    return { url, stop };
};

const postJson = (url: string, body: Record<string, unknown>) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

/** Waits long enough for an untracked database close to run if shutdown ignored pending work. */
const settleShutdownAttempt = () => new Promise(resolve => setTimeout(resolve, 50));

/** Polls a fake's observable state with a bound so a regression fails instead of hanging. */
const waitFor = async (condition: () => boolean, description: string) => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

test('password recovery answers before account email delivery, and shutdown waits for that delivery', async t => {
    const email = 'recovery-listener@example.test';
    const fakes = installAccountFakes(t, [syntheticAccount('synthetic-recovery', email, true)], 'delivered');
    const app = await startApplication(t);

    const response = await postJson(`${app.url}/auth/password/forgot`, { email });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), acceptedMessage);
    fakes.timeline.push('response-received');

    await fakes.deliveryStarted;
    const stopped = app.stop(fakes.timeline);
    await settleShutdownAttempt();
    assert.deepEqual(fakes.timeline, ['response-received'], 'shutdown must not close storage under pending delivery');

    fakes.releaseDelivery();
    assert.equal(await stopped, 'graceful');
    assert.deepEqual(fakes.timeline, ['response-received', 'email-delivered', 'database-closed']);
    assert.deepEqual(fakes.recipients, [email]);
    assert.deepEqual(fakes.errors, []);
});

test('registration and verification-link requests answer before their account work completes', async t => {
    const created = 'created-listener@example.test';
    const legacy = 'legacy-listener@example.test';
    const fakes = installAccountFakes(t, [syntheticAccount('synthetic-legacy', legacy)], 'delivered');
    const app = await startApplication(t);

    const registered = await postJson(`${app.url}/auth/browser/registration/request`, { email: created });
    assert.equal(registered.status, 202);
    assert.deepEqual(await registered.json(), registrationAccepted);
    fakes.timeline.push('registration-response-received');

    const verification = await postJson(`${app.url}/auth/browser/email-verification/request`, { email: legacy });
    assert.equal(verification.status, 202);
    assert.deepEqual(await verification.json(), verificationAccepted);
    fakes.timeline.push('verification-response-received');

    const stopped = app.stop(fakes.timeline);
    await waitFor(() => fakes.recipients.length === 2, 'both gated deliveries to start');
    await settleShutdownAttempt();
    assert.deepEqual(fakes.timeline, ['registration-response-received', 'verification-response-received'],
        'shutdown must not close storage under pending delivery');

    fakes.releaseDelivery();
    assert.equal(await stopped, 'graceful');
    assert.deepEqual(fakes.timeline.slice(2), ['email-delivered', 'email-delivered', 'database-closed']);
    assert.deepEqual(fakes.recipients, [created, legacy]);
    assert.deepEqual(fakes.errors, []);
});

test('registration requests take no concurrency slot, so pending account work never causes 429', async t => {
    const fakes = installAccountFakes(t, [syntheticAccount('synthetic-known', 'known-slot@example.test', true)], 'delivered');
    const app = await startApplication(t);
    // The password concurrency limit admits two requests per client; every
    // request below stays in flight on the closed delivery gate.
    const emails = ['first-slot@example.test', 'known-slot@example.test', 'third-slot@example.test', 'fourth-slot@example.test'];
    for (const email of emails) {
        const response = await postJson(`${app.url}/auth/browser/registration/request`, { email });
        assert.equal(response.status, 202, email);
        assert.deepEqual(await response.json(), registrationAccepted);
    }
    await waitFor(() => fakes.recipients.length === emails.length, 'every gated delivery to start');
    const stopped = app.stop(fakes.timeline);
    fakes.releaseDelivery();
    assert.equal(await stopped, 'graceful');
    assert.deepEqual(fakes.recipients, emails);
    assert.deepEqual(fakes.errors, []);
});

test('a delivery failure after the uniform response is recorded without a second response', async t => {
    const email = 'failed-recovery@example.test';
    const fakes = installAccountFakes(t, [syntheticAccount('synthetic-failed', email, true)], 'failed');
    const app = await startApplication(t);

    const known = await postJson(`${app.url}/auth/password/forgot`, { email });
    const unknown = await postJson(`${app.url}/auth/password/forgot`, { email: 'absent-listener@example.test' });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(await known.json(), acceptedMessage);
    assert.deepEqual(await unknown.json(), acceptedMessage);
    fakes.timeline.push('responses-received');

    await fakes.deliveryStarted;
    const stopped = app.stop(fakes.timeline);
    fakes.releaseDelivery();
    assert.equal(await stopped, 'graceful');
    assert.deepEqual(fakes.timeline, [
        'responses-received',
        'email-failed',
        'security:password_recovery_request_failed',
        'database-closed'
    ]);
    assert.deepEqual(fakes.recipients, [email]);
    // A late failure must not reach the application error boundary after headers were sent.
    assert.deepEqual(fakes.errors, []);
});

test('a registration delivery failure after the uniform response is recorded once', async t => {
    const email = 'failed-registration@example.test';
    const fakes = installAccountFakes(t, [], 'failed');
    const app = await startApplication(t);

    const response = await postJson(`${app.url}/auth/browser/registration/request`, { email });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), registrationAccepted);
    fakes.timeline.push('response-received');

    await fakes.deliveryStarted;
    const stopped = app.stop(fakes.timeline);
    fakes.releaseDelivery();
    assert.equal(await stopped, 'graceful');
    assert.deepEqual(fakes.timeline, [
        'response-received',
        'email-failed',
        'security:email_registration_request_failed',
        'database-closed'
    ]);
    assert.deepEqual(fakes.recipients, [email]);
    assert.deepEqual(fakes.errors, []);
});
