import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before, type TestContext } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createApp } from '../src/app';
import { consumeLinkEmailBudget, resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import AuthActionToken from '../src/models/authActionToken';
import AuthIdentity from '../src/models/authIdentity';
import EmailLinkToken from '../src/models/emailLinkToken';
import User from '../src/models/user';
import { setEmailDomainResolver, type MxRecord, type MxResolver } from '../src/services/emailDomainDeliverability';

/**
 * Authentication email routes with persistence, SES and DNS replaced by
 * in-memory fakes: a domain that cannot receive mail gets the same response as
 * one that can, and no token, code or email. Nothing here opens MongoDB, DNS
 * or a network client other than the loopback test server.
 */
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

const dnsError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });

/** Synthetic DNS: one deliverable domain, three that cannot receive mail, and one whose resolver fails. */
const dnsAnswers: Record<string, MxRecord[] | Error> = {
    'mail.example.test': [{ exchange: 'mx.mail.example.test', priority: 10 }],
    'typo.example.test': dnsError('ENOTFOUND'),
    'nomx.example.test': dnsError('ENODATA'),
    'nullmx.example.test': [{ exchange: '', priority: 0 }],
    'dnsdown.example.test': dnsError('ESERVFAIL')
};

const installResolver = (t: TestContext, resolveMx: MxResolver) => {
    const previous = setEmailDomainResolver(resolveMx);
    t.after(() => setEmailDomainResolver(previous));
};

const tableResolver: MxResolver = async domain => {
    const answer = dnsAnswers[domain];
    if (answer === undefined) throw dnsError('ENOTFOUND');
    if (answer instanceof Error) throw answer;
    return answer;
};

interface SyntheticAccount {
    _id: { toString(): string };
    email: string;
    /** Omitted for an account created before verification existed. */
    emailVerified?: boolean;
}

const account = (id: string, email: string, emailVerified?: boolean): SyntheticAccount => ({
    _id: { toString: () => id },
    email,
    ...(emailVerified === undefined ? {} : { emailVerified })
});

/** Replaces persistence and the SES boundary, and records security events and token writes. */
const installFakes = (t: TestContext, accounts: SyntheticAccount[]) => {
    const known = new Map(accounts.map(value => [value.email, value]));
    const sent: Array<{ recipient: string; subject: string }> = [];
    const issued: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const logged: string[] = [];
    t.mock.method(User, 'findByEmail', async (email: string) => known.get(email) ?? null);
    t.mock.method(User, 'findById', async (id: string) =>
        [...known.values()].find(value => value._id.toString() === id) ?? null);
    t.mock.method(AuthIdentity, 'hasEmailForUser', async () => false);
    t.mock.method(AuthActionToken, 'issue', async (userId: string) => {
        issued.push(`resetPassword:${userId}`);
        return '135790';
    });
    t.mock.method(EmailLinkToken, 'issue', async (purpose: string, email: string) => {
        issued.push(`${purpose}:${email}`);
        return 'S'.repeat(43);
    });
    t.mock.method(SESv2Client.prototype, 'send', async (command: any) => {
        sent.push({
            recipient: String(command.input?.Destination?.ToAddresses?.[0] ?? ''),
            subject: String(command.input?.Content?.Simple?.Subject?.Data ?? '')
        });
        return {};
    });
    t.mock.method(console, 'info', (value: unknown) => {
        logged.push(String(value));
        try {
            const record = JSON.parse(String(value));
            if (record.category === 'security') events.push(record);
        } catch {
            // Non-JSON diagnostics are irrelevant here.
        }
    });
    const errors: string[] = [];
    t.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values.map(String).join(' ')); });
    const eventsNamed = (name: string) => events.filter(record => record.event === name);
    return { sent, issued, events, eventsNamed, logged, errors };
};

const startApplication = async (t: TestContext) => {
    const server = createServer(createApp({ environment: 'test' }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        if (server.listening) server.close();
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** Headers that legitimately differ between two otherwise identical responses. */
const volatileHeaders = new Set(['date', 'x-request-id', 'ratelimit-reset']);

/**
 * Posts from a fresh rate-limit window, so two requests can be compared on
 * everything they return: status, every stable header and the exact body.
 */
const postShape = async (url: string, path: string, email: string) => {
    resetRateLimitWindowsForTests();
    const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url, 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ email })
    });
    return {
        status: response.status,
        headers: [...response.headers].filter(([name]) => !volatileHeaders.has(name)),
        body: await response.text()
    };
};

/** Polls a fake's observable state with a bound so a regression fails instead of hanging. */
const waitFor = async (condition: () => boolean, description: string) => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test('every authentication email skips a domain that cannot receive mail, with an identical response', async t => {
    installResolver(t, tableResolver);
    const flows = [
        { name: 'registration link', path: '/auth/browser/registration/request', local: 'new-listener', state: 'absent', kind: 'registration_link' },
        { name: 'already-registered notice', path: '/auth/browser/registration/request', local: 'verified-listener', state: 'verified', kind: 'already_registered_notice' },
        { name: 'verification link', path: '/auth/browser/email-verification/request', local: 'legacy-listener', state: 'legacy', kind: 'verification_link' },
        { name: 'app reset code', path: '/auth/password/forgot', local: 'app-recovery', state: 'verified', kind: 'password_reset_code' },
        { name: 'browser reset code', path: '/auth/browser/password/forgot', local: 'web-recovery', state: 'verified', kind: 'password_reset_code' },
        { name: 'recovery registration link', path: '/auth/browser/password/forgot', local: 'pending-recovery', state: 'pending', kind: 'registration_link' }
    ] as const;
    const undeliverableDomains = ['typo.example.test', 'nomx.example.test', 'nullmx.example.test'];
    const accounts = flows.flatMap((flow, index) => ['mail.example.test', ...undeliverableDomains].map(domain => {
        const email = `${flow.local}@${domain}`;
        const id = `synthetic-${index}-${domain}`;
        if (flow.state === 'verified') return account(id, email, true);
        if (flow.state === 'pending') return account(id, email, false);
        if (flow.state === 'legacy') return account(id, email);
        return null;
    })).filter((value): value is SyntheticAccount => value !== null);
    const fakes = installFakes(t, accounts);
    const url = await startApplication(t);

    let skipped = 0;
    for (const flow of flows) {
        const delivered = `${flow.local}@mail.example.test`;
        const control = await postShape(url, flow.path, delivered);
        assert.equal(control.status, 202, flow.name);
        await waitFor(() => fakes.sent.some(mail => mail.recipient === delivered), `${flow.name} delivery`);

        for (const domain of undeliverableDomains) {
            const shape = await postShape(url, flow.path, `${flow.local}@${domain}`);
            assert.deepEqual(shape, control, `${flow.name} at ${domain} answers exactly like a deliverable address`);
            skipped += 1;
            await waitFor(() => fakes.eventsNamed('auth_email_undeliverable_domain').length === skipped, `${flow.name} skip at ${domain}`);
            const event = fakes.eventsNamed('auth_email_undeliverable_domain').at(-1)!;
            assert.equal(event.domain, domain);
            assert.equal(event.emailKind, flow.kind);
        }
    }
    await settle();

    assert.deepEqual(fakes.sent.map(mail => mail.recipient), flows.map(flow => `${flow.local}@mail.example.test`),
        'SES is called only for the deliverable domain');
    assert.ok(fakes.issued.length > 0);
    for (const entry of fakes.issued) assert.ok(!undeliverableDomains.some(domain => entry.endsWith(domain)), entry);
    assert.equal(fakes.issued.filter(entry => entry.startsWith('resetPassword:')).length, 2,
        'reset codes are issued (replacing an earlier code) only for the deliverable addresses');
    assert.deepEqual(fakes.eventsNamed('auth_email_undeliverable_domain').map(event => event.reason),
        flows.flatMap(() => ['nxdomain', 'no_mx', 'null_mx']));
    for (const line of fakes.logged) assert.doesNotMatch(line, /@/, 'logs never carry an address');
    assert.deepEqual(fakes.eventsNamed('auth_email_domain_check_failed'), []);
    assert.deepEqual(fakes.errors, []);
});

test('the uniform response is sent before the domain lookup, so DNS never adds latency', async t => {
    let releaseLookup!: () => void;
    const lookups: string[] = [];
    installResolver(t, domain => {
        lookups.push(domain);
        return new Promise<MxRecord[]>((_resolve, reject) => {
            releaseLookup = () => reject(dnsError('ENOTFOUND'));
        });
    });
    const fakes = installFakes(t, []);
    const url = await startApplication(t);

    const response = await postShape(url, '/auth/browser/registration/request', 'lorem@slow-typo.example.test');
    assert.equal(response.status, 202);
    assert.deepEqual(JSON.parse(response.body), { message: 'Check your email for the next step.' });
    await waitFor(() => lookups.length === 1, 'the lookup to start after the response');
    assert.deepEqual(fakes.eventsNamed('auth_email_undeliverable_domain'), [], 'the lookup is still pending');

    releaseLookup();
    await waitFor(() => fakes.eventsNamed('auth_email_undeliverable_domain').length === 1, 'the skip');
    assert.deepEqual(fakes.sent, []);
    assert.deepEqual(fakes.issued, [], 'no link token is written for a domain that cannot receive it');
});

test('a DNS failure other than a missing domain or MX fails open and sends the email', async t => {
    installResolver(t, tableResolver);
    const fakes = installFakes(t, [account('synthetic-dns-down', 'recovery@dnsdown.example.test', true)]);
    const url = await startApplication(t);

    const registration = await postShape(url, '/auth/browser/registration/request', 'new@dnsdown.example.test');
    const recovery = await postShape(url, '/auth/password/forgot', 'recovery@dnsdown.example.test');
    assert.equal(registration.status, 202);
    assert.equal(recovery.status, 202);
    await waitFor(() => fakes.sent.length === 2, 'both fail-open deliveries');
    assert.deepEqual(fakes.sent.map(mail => mail.subject).sort(), ['Finish creating your Finitude account', 'Reset your Finitude password']);
    assert.deepEqual(fakes.issued.sort(), ['registration:new@dnsdown.example.test', 'resetPassword:synthetic-dns-down']);
    assert.deepEqual(fakes.eventsNamed('auth_email_domain_check_failed').map(event =>
        [event.domain, event.emailKind, event.reason]).sort(), [
        ['dnsdown.example.test', 'password_reset_code', 'ESERVFAIL'],
        ['dnsdown.example.test', 'registration_link', 'ESERVFAIL']
    ]);
    assert.deepEqual(fakes.eventsNamed('auth_email_undeliverable_domain'), []);
    assert.deepEqual(fakes.errors, []);
});

test('a skipped link email still spends the address budget, so the domain check cannot reset it', async t => {
    installResolver(t, tableResolver);
    const fakes = installFakes(t, []);
    const url = await startApplication(t);
    resetRateLimitWindowsForTests();
    const email = 'budget@typo.example.test';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await fetch(`${url}/auth/browser/registration/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: url, 'Sec-Fetch-Site': 'same-origin' },
            body: JSON.stringify({ email })
        });
        assert.equal(response.status, 202);
        await response.text();
        await waitFor(() => fakes.eventsNamed('auth_email_undeliverable_domain').length === attempt, `skip ${attempt}`);
    }
    assert.equal(consumeLinkEmailBudget(email), false, 'three skipped emails spent the whole budget');
    assert.deepEqual(fakes.eventsNamed('auth_link_email_suppressed'), []);
    assert.deepEqual(fakes.sent, []);
    resetRateLimitWindowsForTests();
});
