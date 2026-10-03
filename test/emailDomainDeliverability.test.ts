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
