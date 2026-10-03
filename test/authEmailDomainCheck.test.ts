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
import { setEmailDomainResolver, type MxRecord, type MxResolver } from '../src/services/emailDomainDeliverability';
import { syntheticMxResolver } from './support/syntheticMxResolver';

/**
 * Authentication email routes with persistence, SES and DNS replaced by
 * in-memory fakes. A request whose domain cannot receive mail is rejected with
 * `422 email_domain_undeliverable` before any account work, identically for
 * every account state; deliverable and unknown domains keep the generic `202`.
 * Nothing here opens MongoDB, DNS or a network client other than the loopback
 * test server.
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

const domainUndeliverable = {
    code: 'email_domain_undeliverable',
    message: 'This email domain cannot receive email. Check the address and try again.'
};
const generic = {
    registration: { message: 'Check your email for the next step.' },
    verification: { message: 'If this address needs verification, a link has been sent.' },
    recovery: { message: 'If the account can use this action, an email has been sent.' }
};

const dnsError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });

/** Synthetic DNS: one deliverable domain, three that cannot receive mail, and one whose resolver fails. */
const dnsAnswers: Record<string, MxRecord[] | Error> = {
    'mail.example.test': [{ exchange: 'mx.mail.example.test', priority: 10 }],
    'typo.example.test': dnsError('ENOTFOUND'),
    'nomx.example.test': dnsError('ENODATA'),
    'nullmx.example.test': [{ exchange: '', priority: 0 }],
    'dnsdown.example.test': dnsError('ESERVFAIL')
};
const undeliverableDomains = [
    { domain: 'typo.example.test', reason: 'nxdomain' },
    { domain: 'nomx.example.test', reason: 'no_mx' },
    { domain: 'nullmx.example.test', reason: 'null_mx' }
] as const;

/** Answers from `dnsAnswers` and records every domain it was asked for. */
const tableResolver = () => {
    const queries: string[] = [];
    const resolveMx: MxResolver = async domain => {
        queries.push(domain);
        const answer = dnsAnswers[domain];
        if (answer === undefined) throw dnsError('ENOTFOUND');
        if (answer instanceof Error) throw answer;
        return answer;
    };
    return { resolveMx, queries };
};

const resolversBeforeTest = new WeakMap<TestContext, MxResolver>();

/**
 * Installs a resolver, which also empties the verdict cache. A test may install
 * several; the resolver it started with is restored once, after the test.
 */
const installResolver = (t: TestContext, resolveMx: MxResolver) => {
    const previous = setEmailDomainResolver(resolveMx);
    if (resolversBeforeTest.has(t)) return;
    resolversBeforeTest.set(t, previous);
    t.after(() => setEmailDomainResolver(previous));
};

type AccountState = 'absent' | 'verified' | 'legacy' | 'pending';

interface SyntheticAccount {
    _id: { toString(): string };
    email: string;
    /** Omitted for an account created before verification existed. */
    emailVerified?: boolean;
}

const account = (id: string, email: string, state: Exclude<AccountState, 'absent'>): SyntheticAccount => ({
    _id: { toString: () => id },
    email,
    ...(state === 'verified' ? { emailVerified: true } : state === 'pending' ? { emailVerified: false } : {})
});

/**
 * Replaces persistence and the SES boundary, and records account lookups,
 * token writes, deliveries and security events.
 */
const installFakes = (t: TestContext, accounts: SyntheticAccount[]) => {
    const known = new Map(accounts.map(value => [value.email, value]));
    const accountLookups: string[] = [];
    const sent: Array<{ recipient: string; subject: string }> = [];
    const issued: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const logged: string[] = [];
    t.mock.method(User, 'findByEmail', async (email: string) => {
        accountLookups.push(email);
        return known.get(email) ?? null;
    });
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
    return { accountLookups, sent, issued, events, eventsNamed, logged, errors };
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

const post = (url: string, path: string, email: unknown) => fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ email })
});

/** Headers that legitimately differ between two otherwise identical responses. */
const volatileHeaders = new Set(['date', 'x-request-id', 'ratelimit-reset']);

/**
 * Posts from a fresh rate-limit window, so two requests can be compared on
 * everything they return: status, every stable header and the exact body.
 */
const postShape = async (url: string, path: string, email: string) => {
    resetRateLimitWindowsForTests();
    const response = await post(url, path, email);
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

/**
 * Every route that emails a submitted address, with the account states whose
 * answers must match. `delivers` lists the states that receive an email.
 */
const emailRoutes = [
    {
        name: 'registration request',
        path: '/auth/browser/registration/request',
        accepted: generic.registration,
        states: ['absent', 'verified', 'pending'],
        delivers: ['absent', 'verified', 'pending']
    },
    {
        name: 'verification-link request',
        path: '/auth/browser/email-verification/request',
        accepted: generic.verification,
        states: ['absent', 'legacy', 'verified'],
        delivers: ['legacy']
    },
    {
        name: 'app password recovery',
        path: '/auth/password/forgot',
        accepted: generic.recovery,
        states: ['absent', 'verified', 'pending'],
        delivers: ['verified', 'pending']
    },
    {
        name: 'browser password recovery',
        path: '/auth/browser/password/forgot',
        accepted: generic.recovery,
        states: ['absent', 'verified', 'legacy', 'pending'],
        delivers: ['verified', 'legacy', 'pending']
    }
] as const satisfies ReadonlyArray<{
    name: string; path: string; accepted: { message: string };
    states: readonly AccountState[]; delivers: readonly AccountState[];
}>;

/** A distinct synthetic address per route, account state and domain. */
const addressFor = (routeIndex: number, state: AccountState, domain: string) => `route${routeIndex}-${state}@${domain}`;

/** Accounts for every route and non-absent state at each listed domain. */
const accountsAt = (domains: readonly string[]) => emailRoutes.flatMap((route, routeIndex) =>
    route.states.flatMap(state => state === 'absent' ? [] : domains.map(domain =>
        account(`synthetic-${routeIndex}-${state}-${domain}`, addressFor(routeIndex, state, domain), state))));

test('every email request route rejects an undeliverable domain with 422, identically with and without an account', async t => {
    const resolver = tableResolver();
    installResolver(t, resolver.resolveMx);
    const fakes = installFakes(t, accountsAt(undeliverableDomains.map(entry => entry.domain)));
    const url = await startApplication(t);

    let rejected = 0;
    for (const [routeIndex, route] of emailRoutes.entries()) {
        for (const { domain, reason } of undeliverableDomains) {
            const absent = await postShape(url, route.path, addressFor(routeIndex, 'absent', domain));
            assert.equal(absent.status, 422, `${route.name} at ${domain}`);
            assert.deepEqual(JSON.parse(absent.body), domainUndeliverable);
            rejected += 1;
            for (const state of route.states.filter(value => value !== 'absent')) {
                const shape = await postShape(url, route.path, addressFor(routeIndex, state, domain));
                assert.deepEqual(shape, absent, `${route.name} for a ${state} account at ${domain} answers exactly like no account`);
                rejected += 1;
            }
            const event = fakes.eventsNamed('auth_email_domain_rejected').at(-1)!;
            assert.equal(event.domain, domain);
            assert.equal(event.reason, reason);
        }
    }
    await settle();

    assert.equal(fakes.eventsNamed('auth_email_domain_rejected').length, rejected);
    assert.deepEqual(fakes.accountLookups, [], 'no account is looked up for a rejected domain');
    assert.deepEqual(fakes.sent, [], 'SES is never called');
    assert.deepEqual(fakes.issued, [], 'no link token or reset code is written');
    assert.deepEqual(fakes.eventsNamed('auth_email_undeliverable_domain'), [], 'no request reached the email step');
    for (const line of fakes.logged) assert.doesNotMatch(line, /@/, 'logs never carry an address');
    assert.deepEqual(fakes.errors, []);
});

test('a rejected request spends neither per-address budget, while the per-IP limit still counts it', async t => {
    const fakes = installFakes(t, [
        account('synthetic-budget-legacy', 'route1-legacy@typo.example.test', 'legacy'),
        account('synthetic-budget-app', 'route2-verified@typo.example.test', 'verified'),
        account('synthetic-budget-web', 'route3-verified@typo.example.test', 'verified')
    ]);
    const url = await startApplication(t);
    const recipients = [
        'route0-absent@typo.example.test',
        'route1-legacy@typo.example.test',
        'route2-verified@typo.example.test',
        'route3-verified@typo.example.test'
    ];

    for (const [routeIndex, route] of emailRoutes.entries()) {
        const email = recipients[routeIndex];
        resetRateLimitWindowsForTests();
        installResolver(t, tableResolver().resolveMx);
        // Ten rejections would exhaust the per-address attempt budget (10 per window) if they counted.
        for (let attempt = 1; attempt <= 10; attempt += 1) {
            const response = await post(url, route.path, email);
            assert.equal(response.status, 422, `${route.name} rejection ${attempt}`);
            await response.text();
        }

        // The domain starts receiving mail; a fresh resolver also empties the verdict cache.
        installResolver(t, syntheticMxResolver);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const response = await post(url, route.path, email);
            assert.equal(response.status, 202, `${route.name} request ${attempt} after the rejections is admitted`);
            assert.deepEqual(await response.json(), route.accepted);
        }
        await waitFor(() => fakes.sent.filter(mail => mail.recipient === email).length === 3,
            `${route.name}: three emails, so neither the attempt budget nor the link-email budget was spent`);

        // Rejections still count per IP: 20 requests per window, then 429 whatever the domain.
        installResolver(t, tableResolver().resolveMx);
        for (let attempt = 14; attempt <= 20; attempt += 1) {
            const response = await post(url, route.path, email);
            assert.equal(response.status, 422, `${route.name} request ${attempt}`);
            await response.text();
        }
        const limited = await post(url, route.path, email);
        assert.equal(limited.status, 429, `${route.name}: the per-IP limit counts rejected requests`);
        await limited.text();
    }
    assert.deepEqual(fakes.eventsNamed('auth_link_email_suppressed'), []);
    assert.deepEqual(fakes.errors, []);
    resetRateLimitWindowsForTests();
});

test('deliverable and unknown domains keep the generic 202 and the email after the response', async t => {
    const resolver = tableResolver();
    installResolver(t, resolver.resolveMx);
    const domains = ['mail.example.test', 'dnsdown.example.test'];
    const fakes = installFakes(t, accountsAt(domains));
    const url = await startApplication(t);

    const expectedRecipients: string[] = [];
    for (const [routeIndex, route] of emailRoutes.entries()) {
        for (const domain of domains) {
            const absent = await postShape(url, route.path, addressFor(routeIndex, 'absent', domain));
            assert.equal(absent.status, 202, `${route.name} at ${domain}`);
            assert.deepEqual(JSON.parse(absent.body), route.accepted);
            for (const state of route.states.filter(value => value !== 'absent')) {
                assert.deepEqual(await postShape(url, route.path, addressFor(routeIndex, state, domain)), absent,
                    `${route.name} for a ${state} account at ${domain}`);
            }
            for (const state of route.delivers) expectedRecipients.push(addressFor(routeIndex, state, domain));
        }
    }
    await waitFor(() => fakes.sent.length === expectedRecipients.length, 'every expected email');
    await settle();

    assert.deepEqual(fakes.sent.map(mail => mail.recipient).sort(), expectedRecipients.sort());
    assert.deepEqual(fakes.eventsNamed('auth_email_domain_rejected'), []);
    assert.deepEqual(fakes.eventsNamed('auth_email_undeliverable_domain'), []);
    const failOpen = fakes.eventsNamed('auth_email_domain_check_failed');
    assert.equal(failOpen.length, expectedRecipients.filter(email => email.endsWith('@dnsdown.example.test')).length,
        'an unknown verdict is not cached, so each email re-checks, fails open and sends');
    for (const event of failOpen) assert.deepEqual([event.domain, event.reason], ['dnsdown.example.test', 'ESERVFAIL']);
    assert.deepEqual(fakes.errors, []);
});

test('the response waits only for the domain lookup, which runs before any account lookup', async t => {
    const lookups: Array<{ domain: string; answer: (records: MxRecord[] | Error) => void }> = [];
    const email = 'gated@slow.example.test';
    const fakes = installFakes(t, [account('synthetic-gated', email, 'verified')]);
    const url = await startApplication(t);

    for (const outcome of ['deliverable', 'undeliverable'] as const) {
        resetRateLimitWindowsForTests();
        // A gated resolver with an empty cache: each lookup waits until the test answers it.
        installResolver(t, domain => new Promise<MxRecord[]>((resolve, reject) => {
            lookups.push({ domain, answer: records => (records instanceof Error ? reject(records) : resolve(records)) });
        }));
        lookups.length = 0;
        let answered = false;
        const pending = post(url, '/auth/password/forgot', email).then(response => { answered = true; return response; });
        await waitFor(() => lookups.length === 1, `the ${outcome} lookup to start`);
        assert.equal(lookups[0].domain, 'slow.example.test');
        await settle();
        assert.equal(answered, false, 'no response before the domain verdict');
        assert.deepEqual(fakes.accountLookups, outcome === 'deliverable' ? [] : [email], 'no account lookup before the verdict');

        lookups[0].answer(outcome === 'deliverable' ? [{ exchange: 'mx.slow.example.test', priority: 10 }] : dnsError('ENOTFOUND'));
        const response = await pending;
        if (outcome === 'deliverable') {
            assert.equal(response.status, 202);
            assert.deepEqual(await response.json(), generic.recovery);
            await waitFor(() => fakes.sent.length === 1, 'the reset code after the response');
            assert.deepEqual(fakes.accountLookups, [email]);
            assert.equal(lookups.length, 1, 'the email check reuses the cached verdict');
        } else {
            assert.equal(response.status, 422);
            assert.deepEqual(await response.json(), domainUndeliverable);
            await settle();
            assert.deepEqual(fakes.accountLookups, [email], 'a rejected request looks up no account');
            assert.equal(fakes.sent.length, 1);
        }
    }
    assert.deepEqual(fakes.errors, []);
});

test('one DNS lookup serves repeated and concurrent requests for a domain, and the email check reuses it', async t => {
    const resolver = tableResolver();
    installResolver(t, resolver.resolveMx);
    const fakes = installFakes(t, [account('synthetic-cached', 'cached@mail.example.test', 'verified')]);
    const url = await startApplication(t);

    const concurrent = await Promise.all(['a', 'b', 'c'].map(local => {
        resetRateLimitWindowsForTests();
        return post(url, '/auth/browser/registration/request', `${local}@typo.example.test`);
    }));
    for (const response of concurrent) {
        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), domainUndeliverable);
    }
    for (const route of emailRoutes) {
        const shape = await postShape(url, route.path, 'again@typo.example.test');
        assert.equal(shape.status, 422, route.name);
    }
    assert.deepEqual(resolver.queries, ['typo.example.test'], 'concurrent and later requests share one cached lookup');

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const shape = await postShape(url, '/auth/password/forgot', 'cached@mail.example.test');
        assert.equal(shape.status, 202);
        await waitFor(() => fakes.sent.length === attempt, `reset code ${attempt}`);
    }
    assert.deepEqual(resolver.queries, ['typo.example.test', 'mail.example.test'],
        'the request check and the email check share the deliverable verdict');
    assert.deepEqual(fakes.errors, []);
});

test('the email-time check stays as defense in depth when the request check could not decide', async t => {
    const answers: Record<string, string[]> = {
        'flaky-new.example.test': ['ESERVFAIL', 'ENOTFOUND'],
        'flaky-reset.example.test': ['ESERVFAIL', 'ENODATA']
    };
    installResolver(t, async domain => {
        const code = answers[domain]?.shift();
        throw dnsError(code ?? 'ENOTFOUND');
    });
    const fakes = installFakes(t, [account('synthetic-flaky', 'recovery@flaky-reset.example.test', 'verified')]);
    const url = await startApplication(t);

    const registration = await postShape(url, '/auth/browser/registration/request', 'new@flaky-new.example.test');
    const recovery = await postShape(url, '/auth/password/forgot', 'recovery@flaky-reset.example.test');
    assert.equal(registration.status, 202, 'an unknown verdict keeps the generic answer');
    assert.equal(recovery.status, 202);
    await waitFor(() => fakes.eventsNamed('auth_email_undeliverable_domain').length === 2, 'both email-time skips');
    await settle();

    assert.deepEqual(fakes.sent, []);
    assert.deepEqual(fakes.issued, [], 'no link token or reset code for a domain found undeliverable at send time');
    assert.deepEqual(fakes.eventsNamed('auth_email_undeliverable_domain').map(event =>
        [event.domain, event.emailKind, event.reason]).sort(), [
        ['flaky-new.example.test', 'registration_link', 'nxdomain'],
        ['flaky-reset.example.test', 'password_reset_code', 'no_mx']
    ]);
    assert.deepEqual(fakes.eventsNamed('auth_email_domain_rejected'), []);
    assert.deepEqual(fakes.errors, []);
});

test('the email-time verdict is never cached, so a later request lookup cannot reveal an earlier account', async t => {
    // Under flaky DNS each domain's first lookup fails; every later lookup finds a mail host.
    const queries: string[] = [];
    installResolver(t, async domain => {
        queries.push(domain);
        if (queries.filter(query => query === domain).length === 1) throw dnsError('ESERVFAIL');
        return [{ exchange: `mx.${domain}`, priority: 10 }];
    });
    const count = (domain: string) => queries.filter(query => query === domain).length;
    // Routes that email only some account states, so their email-time check reveals an account.
    const cases = emailRoutes.flatMap((route, routeIndex) =>
        (route.delivers as readonly AccountState[]).includes('absent') ? [] : [{ route, routeIndex, state: route.delivers[0] }]);
    assert.deepEqual(cases.map(({ route }) => route.name),
        ['verification-link request', 'app password recovery', 'browser password recovery']);
    const domainsFor = (routeIndex: number) => ({
        withAccount: `account-${routeIndex}.flaky.example.test`,
        withoutAccount: `none-${routeIndex}.flaky.example.test`
    });
    const fakes = installFakes(t, cases.map(({ routeIndex, state }) => account(`synthetic-flaky-${routeIndex}`,
        addressFor(routeIndex, state, domainsFor(routeIndex).withAccount), state)));
    const url = await startApplication(t);

    for (const { route, routeIndex, state } of cases) {
        const { withAccount, withoutAccount } = domainsFor(routeIndex);
        const owner = addressFor(routeIndex, state, withAccount);
        const ownerShape = await postShape(url, route.path, owner);
        assert.equal(ownerShape.status, 202, `${route.name}: an unknown verdict keeps the generic answer`);
        assert.deepEqual(await postShape(url, route.path, addressFor(routeIndex, 'absent', withoutAccount)), ownerShape);
        await waitFor(() => fakes.sent.some(mail => mail.recipient === owner), `${route.name}: the email to the account`);
        await settle();
        assert.equal(count(withAccount), 2, `${route.name}: the email-time check looked the domain up again`);
        assert.equal(count(withoutAccount), 1, `${route.name}: no email and no email-time check without an account`);

        // The next request for any address at either domain looks it up afresh: nothing was cached at send time.
        for (const domain of [withAccount, withoutAccount]) {
            const before = count(domain);
            assert.deepEqual(await postShape(url, route.path, `probe@${domain}`), ownerShape);
            assert.equal(count(domain), before + 1, `${route.name}: the request check at ${domain} missed the cache`);
        }
        // That request check cached its own verdict, which the following request reuses.
        for (const domain of [withAccount, withoutAccount]) {
            const before = count(domain);
            assert.deepEqual(await postShape(url, route.path, `probe-again@${domain}`), ownerShape);
            assert.equal(count(domain), before, `${route.name}: the request check at ${domain} reused its cached verdict`);
        }
    }
    await settle();
    assert.deepEqual(fakes.sent.map(mail => mail.recipient).sort(),
        cases.map(({ routeIndex, state }) => addressFor(routeIndex, state, domainsFor(routeIndex).withAccount)).sort());
    assert.deepEqual(fakes.eventsNamed('auth_email_domain_check_failed'), [], 'every email-time lookup succeeded');
    assert.deepEqual(fakes.errors, []);
});

test('invalid input keeps the generic validation answer without a DNS lookup', async t => {
    const resolver = tableResolver();
    installResolver(t, resolver.resolveMx);
    const fakes = installFakes(t, []);
    const url = await startApplication(t);

    for (const route of emailRoutes) {
        for (const email of ['not-an-email', 'lorem@typo', '', 42]) {
            resetRateLimitWindowsForTests();
            const response = await post(url, route.path, email);
            assert.equal(response.status, 422, `${route.name} with ${JSON.stringify(email)}`);
            assert.deepEqual(await response.json(), { message: 'Please check the submitted fields.' });
        }
    }
    assert.deepEqual(resolver.queries, []);
    assert.deepEqual(fakes.accountLookups, []);
    assert.deepEqual(fakes.eventsNamed('auth_email_domain_rejected'), []);
});
