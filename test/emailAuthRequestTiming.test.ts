import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before, type TestContext } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createApp } from '../src/app';
import AuthActionToken from '../src/models/authActionToken';
import User from '../src/models/user';
import { ServerLifecycle } from '../src/services/serverLifecycleService';

const acceptedMessage = { message: 'If the account can use this action, an email has been sent.' };
const emailEnvironment = {
    AUTH_EMAIL_FROM: 'auth@example.test',
    AUTH_CODE_PEPPER: 'synthetic-unit-test-pepper',
    AWS_REGION: 'us-east-1'
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
    emailVerified: boolean;
}

const syntheticAccount = (id: string, email: string, emailVerified: boolean): SyntheticAccount => ({
    _id: { toString: () => id },
    email,
    emailVerified
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
    t.mock.method(User.prototype, 'save', async function (this: { email: string }) {
        const created = syntheticAccount(`synthetic-created-${known.size}`, this.email, false);
        known.set(created.email, created);
        return { insertedId: created._id };
    });
    t.mock.method(AuthActionToken, 'issue', async () => '135790');
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

test('verification resend and JSON registration answer before their account work completes', async t => {
    const unverified = 'unverified-listener@example.test';
    const created = 'created-listener@example.test';
    const fakes = installAccountFakes(
        t,
        [syntheticAccount('synthetic-unverified', unverified, false)],
        'delivered'
    );
    const app = await startApplication(t);

    const resent = await postJson(`${app.url}/auth/email/resend-verification`, { email: unverified });
    assert.equal(resent.status, 202);
    assert.deepEqual(await resent.json(), acceptedMessage);
    fakes.timeline.push('resend-response-received');

    const registered = await postJson(`${app.url}/auth/signup`, {
        email: created,
        password: 'Lorem ipsum dolor sit amet',
        displayName: 'Lorem Ipsum'
    });
    assert.equal(registered.status, 202);
    assert.deepEqual(await registered.json(), acceptedMessage);
    fakes.timeline.push('registration-response-received');

    const stopped = app.stop(fakes.timeline);
    // Registration hashes the password after its response, then reaches the gated send.
    await waitFor(() => fakes.recipients.length === 2, 'both gated deliveries to start');
    await settleShutdownAttempt();
    assert.deepEqual(fakes.timeline, [
        'resend-response-received',
        'registration-response-received',
        'security:email_registration_created'
    ]);

    fakes.releaseDelivery();
    assert.equal(await stopped, 'graceful');
    assert.deepEqual(fakes.timeline.slice(3), ['email-delivered', 'email-delivered', 'database-closed']);
    assert.deepEqual(fakes.recipients, [unverified, created]);
    assert.deepEqual(fakes.errors, []);
});

test('registration work after the response still holds its concurrency slot until it settles', async t => {
    const fakes = installAccountFakes(t, [], 'delivered');
    const app = await startApplication(t);
    const register = (email: string) => postJson(`${app.url}/auth/signup`, {
        email,
        password: 'Lorem ipsum dolor sit amet',
        displayName: 'Lorem Ipsum'
    });

    const first = await register('first-slot@example.test');
    const second = await register('second-slot@example.test');
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    await Promise.all([first.text(), second.text()]);
    await waitFor(() => fakes.recipients.length === 2, 'both gated deliveries to start');

    // Responding early removes client backpressure, so the limiter must keep bounding the work.
    const overflow = await register('third-slot@example.test');
    assert.equal(overflow.status, 429);
    assert.deepEqual(await overflow.json(), { message: 'Too many concurrent requests.' });

    const stopped = app.stop(fakes.timeline);
    fakes.releaseDelivery();
    assert.equal(await stopped, 'graceful');
    assert.deepEqual(fakes.recipients, ['first-slot@example.test', 'second-slot@example.test']);
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

test('Web form registration renders its generic page before account work and records late failures', async t => {
    const email = 'web-form-listener@example.test';
    const fakes = installAccountFakes(t, [], 'failed');
    const app = await startApplication(t);

    const response = await fetch(`${app.url}/auth/signup-web`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: app.url,
            'Sec-Fetch-Site': 'same-origin'
        },
        body: new URLSearchParams({
            email,
            password: 'Lorem ipsum dolor sit amet',
            username: 'Lorem Ipsum'
        })
    });
    assert.equal(response.status, 202);
    assert.match(await response.text(), /If the account can be created, a verification code has been sent/);
    fakes.timeline.push('response-received');

    await fakes.deliveryStarted;
    const stopped = app.stop(fakes.timeline);
    fakes.releaseDelivery();
    assert.equal(await stopped, 'graceful');
    assert.deepEqual(fakes.timeline, [
        'response-received',
        'security:email_registration_created',
        'email-failed',
        'security:email_registration_request_failed',
        'database-closed'
    ]);
    assert.deepEqual(fakes.recipients, [email]);
    assert.deepEqual(fakes.errors, []);
});
