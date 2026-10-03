import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import test from 'node:test';
import {
    checkEmailDomainDeliverability,
    createEmailDomainDeliverability,
    emailAddressDomain,
    emailDomainDeliverabilityDefaults,
    setEmailDomainResolver,
    systemMxResolver,
    type MxRecord,
    type MxResolver
} from '../src/services/emailDomainDeliverability';
import { syntheticMxResolver } from './support/syntheticMxResolver';

/** MX-domain rules with injected resolvers and clocks; nothing here sends a DNS query. */
const dnsError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });
const mx = (exchange: string, priority = 10): MxRecord => ({ exchange, priority });

/** A resolver that answers from a table and records every domain it was asked for. */
const tableResolver = (answers: Record<string, MxRecord[] | Error>) => {
    const queries: string[] = [];
    const resolveMx: MxResolver = async domain => {
        queries.push(domain);
        const answer = answers[domain];
        if (answer === undefined) throw dnsError('ENOTFOUND');
        if (answer instanceof Error) throw answer;
        return answer;
    };
    return { resolveMx, queries };
};

/** A controllable clock for TTL assertions. */
const clock = (start = 1_000_000) => {
    let current = start;
    return { now: () => current, advance: (milliseconds: number) => { current += milliseconds; } };
};

test('the address domain is trimmed, lowercased, stripped of one root dot and converted to punycode', () => {
    assert.equal(emailAddressDomain('Lorem@Example.COM'), 'example.com');
    assert.equal(emailAddressDomain('lorem@example.com.'), 'example.com');
    assert.equal(emailAddressDomain(' lorem@Mail.Example.test. '), 'mail.example.test');
    assert.equal(emailAddressDomain('lorem@münchen.de'), 'xn--mnchen-3ya.de');
    assert.equal(emailAddressDomain('LOREM@MÜNCHEN.DE'), 'xn--mnchen-3ya.de');
    assert.equal(emailAddressDomain('lorem@xn--mnchen-3ya.de'), 'xn--mnchen-3ya.de');
    assert.equal(emailAddressDomain('lorem@ｅｘａｍｐｌｅ.com'), 'example.com', 'IDNA maps full-width letters');
    assert.equal(emailAddressDomain('"ipsum@dolor"@example.com'), 'example.com', 'the last @ starts the domain');
    for (const address of ['no-at-sign.example.com', 'lorem@', 'lorem@.', 'lorem@example.com..', 'lorem@example..com',
        'lorem@exa mple.com', 'lorem@ex%61mple.com', 'lorem@[127.0.0.1]', 'lorem@example.com/path',
        `lorem@${'a'.repeat(64)}.com`, `lorem@${'abcdefghi.'.repeat(26)}com`]) {
        assert.equal(emailAddressDomain(address), null, address);
    }
    assert.equal(emailAddressDomain(undefined as unknown as string), null, 'an untyped stored value never throws');
});

test('a domain with at least one MX host is deliverable, and only the normalized domain is queried', async () => {
    const resolver = tableResolver({
        'example.com': [mx('mx1.example.com'), mx('mx2.example.com', 20)],
        'mixed.example.com': [mx('', 0), mx('mx.mixed.example.com')],
        'xn--mnchen-3ya.de': [mx('mail.xn--mnchen-3ya.de')]
    });
    const checker = createEmailDomainDeliverability({ resolveMx: resolver.resolveMx });
    assert.deepEqual(await checker.check('Lorem@Example.com.'), { status: 'deliverable', domain: 'example.com' });
    assert.deepEqual(await checker.check('lorem@mixed.example.com'), { status: 'deliverable', domain: 'mixed.example.com' });
    assert.deepEqual(await checker.check('lorem@MÜNCHEN.de'), { status: 'deliverable', domain: 'xn--mnchen-3ya.de' });
    assert.deepEqual(resolver.queries, ['example.com', 'mixed.example.com', 'xn--mnchen-3ya.de']);
});

test('no domain, no MX records, a null MX or an invalid domain is undeliverable without A/AAAA fallback', async () => {
    const resolver = tableResolver({
        'nodata.example.com': dnsError('ENODATA'),
        'empty.example.com': [],
        'nullmx.example.com': [mx('', 0)],
        'dotted-nullmx.example.com': [mx('.', 0)]
    });
    const checker = createEmailDomainDeliverability({ resolveMx: resolver.resolveMx });
    assert.deepEqual(await checker.check('lorem@nxdomain.example.com'),
        { status: 'undeliverable', domain: 'nxdomain.example.com', reason: 'nxdomain' });
    assert.deepEqual(await checker.check('lorem@nodata.example.com'),
        { status: 'undeliverable', domain: 'nodata.example.com', reason: 'no_mx' });
    assert.deepEqual(await checker.check('lorem@empty.example.com'),
        { status: 'undeliverable', domain: 'empty.example.com', reason: 'no_mx' });
    assert.deepEqual(await checker.check('lorem@nullmx.example.com'),
        { status: 'undeliverable', domain: 'nullmx.example.com', reason: 'null_mx' });
    assert.deepEqual(await checker.check('lorem@dotted-nullmx.example.com'),
        { status: 'undeliverable', domain: 'dotted-nullmx.example.com', reason: 'null_mx' });
    assert.deepEqual(await checker.check('lorem@example..com'), { status: 'undeliverable', domain: null, reason: 'invalid_domain' });
    // Only MX queries are made; an invalid domain makes none.
    assert.deepEqual(resolver.queries, ['nxdomain.example.com', 'nodata.example.com', 'empty.example.com',
        'nullmx.example.com', 'dotted-nullmx.example.com']);
});

test('timeouts, SERVFAIL and other resolver failures are unknown, so callers fail open', async () => {
    const resolver = tableResolver({
        'timeout.example.com': dnsError('ETIMEOUT'),
        'servfail.example.com': dnsError('ESERVFAIL'),
        'refused.example.com': dnsError('EREFUSED'),
        'network.example.com': dnsError('ECONNREFUSED'),
        'opaque.example.com': new Error('resolver text that must not be logged'),
        'odd-code.example.com': Object.assign(new Error('x'), { code: 'lorem ipsum@example.com' })
    });
    const checker = createEmailDomainDeliverability({ resolveMx: resolver.resolveMx });
    for (const [domain, reason] of [['timeout.example.com', 'ETIMEOUT'], ['servfail.example.com', 'ESERVFAIL'],
        ['refused.example.com', 'EREFUSED'], ['network.example.com', 'ECONNREFUSED'],
        ['opaque.example.com', 'EUNKNOWN'], ['odd-code.example.com', 'EUNKNOWN']]) {
        assert.deepEqual(await checker.check(`lorem@${domain}`), { status: 'unknown', domain, reason });
    }
    const malformed = createEmailDomainDeliverability({ resolveMx: async () => null as unknown as MxRecord[] });
    assert.deepEqual(await malformed.check('lorem@example.com'), { status: 'unknown', domain: 'example.com', reason: 'EBADRESP' });
    const throwing = createEmailDomainDeliverability({ resolveMx: () => { throw dnsError('ECANCELLED'); } });
    assert.deepEqual(await throwing.check('lorem@example.com'), { status: 'unknown', domain: 'example.com', reason: 'ECANCELLED' });
});

test('a lookup slower than the timeout is unknown instead of holding the request work', async () => {
    assert.equal(emailDomainDeliverabilityDefaults.timeoutMs, 3_000);
    const checker = createEmailDomainDeliverability({ resolveMx: () => new Promise<MxRecord[]>(() => undefined), timeoutMs: 20 });
    const started = Date.now();
    assert.deepEqual(await checker.check('lorem@slow.example.com'), { status: 'unknown', domain: 'slow.example.com', reason: 'timeout' });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(checker.cachedDomainCount(), 0, 'a timeout is not cached');
});

test('verdicts are cached for one hour when deliverable and ten minutes when undeliverable; failures are retried', async () => {
    assert.equal(emailDomainDeliverabilityDefaults.positiveTtlMs, 60 * 60_000);
    assert.equal(emailDomainDeliverabilityDefaults.negativeTtlMs, 10 * 60_000);
    const time = clock();
    const answers: Record<string, MxRecord[] | Error> = {
        'good.example.com': [mx('mx.good.example.com')],
        'down.example.com': dnsError('ESERVFAIL')
    };
    const resolver = tableResolver(answers);
    const checker = createEmailDomainDeliverability({ resolveMx: resolver.resolveMx, now: time.now });
    const count = (domain: string) => resolver.queries.filter(query => query === domain).length;

    await checker.check('a@good.example.com');
    await checker.check('B@GOOD.example.com.');
    await checker.check('a@typo.example.com');
    assert.equal(count('good.example.com'), 1, 'address variants share one cache entry');
    assert.equal(count('typo.example.com'), 1);

    time.advance(10 * 60_000 - 1);
    await checker.check('a@typo.example.com');
    assert.equal(count('typo.example.com'), 1, 'still within the negative TTL');
    time.advance(1);
    answers['typo.example.com'] = [mx('mx.typo.example.com')];
    assert.equal((await checker.check('a@typo.example.com')).status, 'deliverable', 'a fixed domain recovers after ten minutes');
    assert.equal(count('typo.example.com'), 2);

    time.advance(50 * 60_000 - 1);
    await checker.check('a@good.example.com');
    assert.equal(count('good.example.com'), 1, 'still within the positive TTL');
    time.advance(1);
    await checker.check('a@good.example.com');
    assert.equal(count('good.example.com'), 2, 'refreshed after one hour');

    await checker.check('a@down.example.com');
    await checker.check('a@down.example.com');
    assert.equal(count('down.example.com'), 2, 'unknown verdicts are never cached');
});

test('the cache is bounded and evicts its oldest domain first', async () => {
    assert.equal(emailDomainDeliverabilityDefaults.maxEntries, 1_000);
    const resolver = tableResolver({});
    const checker = createEmailDomainDeliverability({ resolveMx: resolver.resolveMx, maxEntries: 3 });
    for (const label of ['one', 'two', 'three', 'four']) await checker.check(`lorem@${label}.example.com`);
    assert.equal(checker.cachedDomainCount(), 3);
    await checker.check('lorem@four.example.com');
    await checker.check('lorem@two.example.com');
    assert.equal(resolver.queries.length, 4, 'recent domains are still cached');
    await checker.check('lorem@one.example.com');
    assert.equal(resolver.queries.length, 5, 'the oldest domain was evicted');
    assert.equal(checker.cachedDomainCount(), 3);
});

test('concurrent checks for one domain share a single lookup, including a failed one', async () => {
    const queries: string[] = [];
    let settle!: (records: MxRecord[] | Error) => void;
    const resolveMx: MxResolver = domain => {
        queries.push(domain);
        return new Promise<MxRecord[]>((resolve, reject) => {
            settle = answer => (answer instanceof Error ? reject(answer) : resolve(answer));
        });
    };
    const checker = createEmailDomainDeliverability({ resolveMx });

    const waiting = ['a@example.com', 'B@Example.com', 'c@example.com.'].map(address => checker.check(address));
    assert.deepEqual(queries, ['example.com']);
    settle([mx('mx.example.com')]);
    for (const verdict of await Promise.all(waiting)) assert.deepEqual(verdict, { status: 'deliverable', domain: 'example.com' });

    const failing = [checker.check('a@flaky.example.com'), checker.check('b@flaky.example.com')];
    assert.deepEqual(queries, ['example.com', 'flaky.example.com']);
    settle(dnsError('ETIMEOUT'));
    for (const verdict of await Promise.all(failing)) assert.equal(verdict.status, 'unknown');
    const retry = checker.check('a@flaky.example.com');
    assert.deepEqual(queries, ['example.com', 'flaky.example.com', 'flaky.example.com'], 'the next request retries');
    settle([mx('mx.flaky.example.com')]);
    assert.equal((await retry).status, 'deliverable');
});

/** A resolver whose queries each wait until the test answers them, in the order they were made. */
const gatedResolver = () => {
    const queries: Array<{ domain: string; answer: (records: MxRecord[] | Error) => void }> = [];
    const resolveMx: MxResolver = domain => new Promise<MxRecord[]>((resolve, reject) => {
        queries.push({ domain, answer: records => (records instanceof Error ? reject(records) : resolve(records)) });
    });
    return { resolveMx, queries };
};

const readOnly = { cache: 'read-only' } as const;

test('a read-only check looks a missing domain up without caching the verdict, and reuses a cached one', async () => {
    const resolver = tableResolver({
        'good.example.com': [mx('mx.good.example.com')],
        'down.example.com': dnsError('ESERVFAIL')
    });
    const checker = createEmailDomainDeliverability({ resolveMx: resolver.resolveMx });
    const count = (domain: string) => resolver.queries.filter(query => query === domain).length;

    // Miss: the lookup runs and answers, but no verdict of any kind is cached.
    assert.deepEqual(await checker.check('a@good.example.com', readOnly), { status: 'deliverable', domain: 'good.example.com' });
    assert.deepEqual(await checker.check('a@typo.example.com', readOnly),
        { status: 'undeliverable', domain: 'typo.example.com', reason: 'nxdomain' });
    assert.deepEqual(await checker.check('a@down.example.com', readOnly),
        { status: 'unknown', domain: 'down.example.com', reason: 'ESERVFAIL' });
    assert.deepEqual(await checker.check('a@example..com', readOnly), { status: 'undeliverable', domain: null, reason: 'invalid_domain' });
    assert.equal(checker.cachedDomainCount(), 0);
    await checker.check('b@good.example.com', readOnly);
    assert.equal(count('good.example.com'), 2, 'the next read-only check looks up again');

    // A request-time (read-write) check still finds nothing cached, then caches as before.
    await checker.check('c@good.example.com');
    assert.equal(count('good.example.com'), 3, 'the request-time check missed the cache');
    assert.equal(checker.cachedDomainCount(), 1);
    await checker.check('d@good.example.com');
    assert.equal(count('good.example.com'), 3, 'the request-time verdict is cached');

    // Hit: a read-only check reuses a request-time verdict without a lookup.
    assert.deepEqual(await checker.check('e@good.example.com', readOnly), { status: 'deliverable', domain: 'good.example.com' });
    await checker.check('b@typo.example.com');
    assert.deepEqual(await checker.check('c@typo.example.com', readOnly),
        { status: 'undeliverable', domain: 'typo.example.com', reason: 'nxdomain' });
    assert.equal(count('good.example.com'), 3);
    assert.equal(count('typo.example.com'), 2, 'one read-only miss and one request-time lookup; the read-only hit made none');
    assert.equal(checker.cachedDomainCount(), 2);
});

test('a read-only check leaves expired entries and the eviction order untouched', async () => {
    const time = clock();
    const answers: Record<string, MxRecord[] | Error> = {
        'a.example.com': [mx('mx.a.example.com')],
        'b.example.com': [mx('mx.b.example.com')],
        'c.example.com': [mx('mx.c.example.com')]
    };
    const resolver = tableResolver(answers);
    const checker = createEmailDomainDeliverability({ resolveMx: resolver.resolveMx, maxEntries: 2, now: time.now });
    const count = (domain: string) => resolver.queries.filter(query => query === domain).length;

    await checker.check('x@typo.example.com');
    await checker.check('x@a.example.com');
    time.advance(10 * 60_000);
    answers['typo.example.com'] = [mx('mx.typo.example.com')];
    assert.equal((await checker.check('y@typo.example.com', readOnly)).status, 'deliverable', 'an expired verdict is not reused');
    assert.equal(count('typo.example.com'), 2);
    assert.equal(checker.cachedDomainCount(), 2, 'the expired entry was not deleted');
    await checker.check('z@typo.example.com');
    assert.equal(count('typo.example.com'), 3, 'nor replaced: the request-time check still finds it expired');

    // The full cache holds a.example.com, then typo.example.com.
    await checker.check('x@b.example.com', readOnly);
    await checker.check('y@a.example.com', readOnly);
    await checker.check('z@a.example.com');
    assert.equal(count('a.example.com'), 1, 'a read-only miss evicted nothing');
    await checker.check('x@c.example.com');
    await checker.check('w@typo.example.com');
    assert.equal(count('typo.example.com'), 3, 'a read-only hit did not refresh a.example.com, so it was evicted first');
    await checker.check('w@a.example.com');
    assert.equal(count('a.example.com'), 2);
    assert.equal(count('b.example.com'), 1);
});

test('coalescing never lets a read-only lookup reach the cache', async () => {
    const resolver = gatedResolver();
    const checker = createEmailDomainDeliverability({ resolveMx: resolver.resolveMx });
    const domains = () => resolver.queries.map(query => query.domain);
    const deliverable = { status: 'deliverable', domain: 'example.com' };

    // Read-only checks share one lookup; a request-time check never joins it and starts its own.
    const sendTime = [checker.check('a@example.com', readOnly), checker.check('B@Example.com', readOnly)];
    assert.deepEqual(domains(), ['example.com']);
    const requestTime = checker.check('c@example.com');
    assert.deepEqual(domains(), ['example.com', 'example.com'], 'the request-time check did not join the read-only lookup');
    // A later read-only check joins a lookup in flight instead of starting a third.
    const joined = checker.check('d@example.com', readOnly);
    assert.equal(resolver.queries.length, 2);

    resolver.queries[0].answer([mx('mx.example.com')]);
    for (const verdict of await Promise.all(sendTime)) assert.deepEqual(verdict, deliverable);
    assert.equal(checker.cachedDomainCount(), 0, 'the read-only verdict was not cached while the request-time lookup waited');
    resolver.queries[1].answer([mx('mx.example.com')]);
    assert.deepEqual(await requestTime, deliverable);
    assert.deepEqual(await joined, deliverable);
    assert.equal(checker.cachedDomainCount(), 1, 'only the request-time lookup cached its verdict');
    assert.deepEqual(await checker.check('e@example.com', readOnly), deliverable);
    assert.equal(resolver.queries.length, 2, 'later checks reuse the request-time verdict');

    // A read-only check that joins a request-time lookup in flight adds no lookup and no cache write.
    const requestFirst = checker.check('a@joined.example.com');
    const sendJoins = checker.check('b@joined.example.com', readOnly);
    assert.equal(resolver.queries.length, 3);
    resolver.queries[2].answer(dnsError('ENOTFOUND'));
    const nxdomain = { status: 'undeliverable', domain: 'joined.example.com', reason: 'nxdomain' };
    assert.deepEqual(await sendJoins, nxdomain);
    assert.deepEqual(await requestFirst, nxdomain);
    assert.equal(checker.cachedDomainCount(), 2);

    // A read-only lookup that succeeds alongside a failed request-time lookup is cached in neither settle order.
    for (const order of ['read-only settles first', 'request-time settles first']) {
        const domain = order.startsWith('read-only') ? 'early.flaky.example.com' : 'late.flaky.example.com';
        const send = checker.check(`a@${domain}`, readOnly);
        const request = checker.check(`b@${domain}`);
        const [sendLookup, requestLookup] = resolver.queries.slice(-2);
        assert.deepEqual([sendLookup.domain, requestLookup.domain], [domain, domain], order);
        const answerSend = () => sendLookup.answer([mx(`mx.${domain}`)]);
        const answerRequest = () => requestLookup.answer(dnsError('ESERVFAIL'));
        if (order.startsWith('read-only')) {
            answerSend();
            assert.equal((await send).status, 'deliverable');
            answerRequest();
        } else {
            answerRequest();
            assert.equal((await request).status, 'unknown');
            answerSend();
        }
        assert.deepEqual([(await send).status, (await request).status], ['deliverable', 'unknown'], order);
        assert.equal(checker.cachedDomainCount(), 2, `${order}: neither verdict was cached`);

        // The settled read-only lookup is no longer shared: the next read-only check looks up again.
        const queriesBefore = resolver.queries.length;
        const again = checker.check(`c@${domain}`, readOnly);
        assert.equal(resolver.queries.length, queriesBefore + 1, order);
        resolver.queries.at(-1)!.answer([mx(`mx.${domain}`)]);
        assert.equal((await again).status, 'deliverable');
        assert.equal(checker.cachedDomainCount(), 2, order);
    }
    // The next request-time check looks up afresh and caches its own verdict.
    const retry = checker.check('d@late.flaky.example.com');
    assert.equal(resolver.queries.at(-1)!.domain, 'late.flaky.example.com');
    resolver.queries.at(-1)!.answer([mx('mx.late.flaky.example.com')]);
    assert.equal((await retry).status, 'deliverable');
    assert.equal(checker.cachedDomainCount(), 3);
});

test('the shared checker caches only from read-write checks', async t => {
    const resolver = tableResolver({ 'mail.example.com': [mx('mx.mail.example.com')] });
    const previous = setEmailDomainResolver(resolver.resolveMx);
    t.after(() => setEmailDomainResolver(previous));
    await checkEmailDomainDeliverability('a@mail.example.com', readOnly);
    await checkEmailDomainDeliverability('b@mail.example.com', readOnly);
    assert.equal(resolver.queries.length, 2, 'read-only checks cache nothing');
    await checkEmailDomainDeliverability('c@mail.example.com');
    await checkEmailDomainDeliverability('d@mail.example.com', readOnly);
    await checkEmailDomainDeliverability('e@mail.example.com');
    assert.equal(resolver.queries.length, 3, 'the default check caches, and both modes reuse its verdict');
});

test('production lookups use node:dns/promises resolveMx; server tests install a synthetic resolver instead', async t => {
    const systemQueries: string[] = [];
    t.mock.method(Resolver.prototype, 'resolveMx', async (domain: string) => {
        systemQueries.push(domain);
        return [mx(`mx.${domain}`)];
    });
    assert.deepEqual(await systemMxResolver('example.com'), [mx('mx.example.com')]);
    assert.deepEqual(systemQueries, ['example.com']);

    // `.invalid` never exists in real DNS, so a deliverable verdict proves the synthetic resolver answered.
    assert.deepEqual(await checkEmailDomainDeliverability('lorem@absent.invalid'), { status: 'deliverable', domain: 'absent.invalid' });
    assert.deepEqual(systemQueries, ['example.com'], 'the shared checker made no system DNS query');

    const replaced = tableResolver({});
    const previous = setEmailDomainResolver(replaced.resolveMx);
    t.after(() => setEmailDomainResolver(previous));
    assert.equal(previous, syntheticMxResolver);
    assert.equal((await checkEmailDomainDeliverability('lorem@absent.invalid')).status, 'undeliverable',
        'replacing the resolver also drops cached verdicts');
    assert.deepEqual(replaced.queries, ['absent.invalid']);
});
