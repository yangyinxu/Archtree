import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';

/**
 * Decides whether an email address's domain can receive mail, so
 * authentication email is never sent to an address that cannot receive it
 * (a mistyped or nonexistent domain). Only DNS MX records count:
 *
 * - `deliverable`: at least one MX record names a mail host, i.e. is not the
 *   RFC 7505 null MX (exchange ".").
 * - `undeliverable`: the domain does not exist (`ENOTFOUND`, NXDOMAIN), has no
 *   MX records (`ENODATA`), publishes only a null MX, or is not a valid
 *   hostname at all.
 * - `unknown`: any other DNS failure (timeout, SERVFAIL, refused, network).
 *   Callers fail open and send, so a resolver outage never blocks sign-up or
 *   recovery.
 *
 * There is deliberately no fallback to A/AAAA records (the RFC 5321 implicit
 * MX): mistyped domains are often parked with only an A record, while domains
 * that really accept mail publish MX records.
 */

/** One MX answer as `node:dns` reports it; a null MX has exchange "" (or "."). */
export interface MxRecord {
    exchange: string;
    priority: number;
}

/** Resolves a normalized ASCII domain's MX records, rejecting with a `node:dns` error code. */
export type MxResolver = (domain: string) => Promise<MxRecord[]>;

/** Why a domain counts as unable to receive mail. */
export type UndeliverableReason = 'nxdomain' | 'no_mx' | 'null_mx' | 'invalid_domain';

export type DomainDeliverability =
    | { status: 'deliverable'; domain: string }
    | { status: 'undeliverable'; domain: string | null; reason: UndeliverableReason }
    /** `reason` is a `node:dns` error code or `timeout`; never anything from the address. */
    | { status: 'unknown'; domain: string; reason: string };

export interface EmailDomainDeliverabilityOptions {
    resolveMx: MxResolver;
    /** Most domains kept in the verdict cache; the oldest entry is evicted first. */
    maxEntries?: number;
    /** How long a deliverable verdict is reused. */
    positiveTtlMs?: number;
    /** How long an undeliverable verdict is reused; short, so a newly fixed domain recovers quickly. */
    negativeTtlMs?: number;
    /** Upper bound for one lookup; slower answers count as `unknown`. */
    timeoutMs?: number;
    now?: () => number;
}

export const emailDomainDeliverabilityDefaults = Object.freeze({
    maxEntries: 1_000,
    positiveTtlMs: 60 * 60_000,
    negativeTtlMs: 10 * 60_000,
    timeoutMs: 3_000
});

/** Lowercase LDH labels (underscores tolerated), 1 to 63 characters each, at most 253 in total. */
const asciiHostname = /^(?=.{1,253}$)(?:[a-z0-9_-]{1,63}\.)*[a-z0-9_-]{1,63}$/;
/** Any ASCII character other than a letter, digit, `.`, `-` or `_`. */
const disallowedAscii = /(?![A-Za-z0-9._-])[\x00-\x7f]/;

/**
 * Returns the address's domain in the form DNS is queried with, or null when
 * it has none: the text after the last `@`, trimmed, without one trailing root
 * dot, lowercased, and converted to punycode when it is internationalized
 * (`münchen.de` becomes `xn--mnchen-3ya.de`).
 */
export const emailAddressDomain = (address: string): string | null => {
    // Stored account emails are untyped database values; coerce instead of throwing.
    const value = String(address ?? '');
    const at = value.lastIndexOf('@');
    if (at < 0) return null;
    let domain = value.slice(at + 1).trim();
    if (domain.endsWith('.')) domain = domain.slice(0, -1);
    // domainToASCII parses a URL host: it would percent-decode and drop anything after
    // `/`, `?` or `#`, so ASCII punctuation is rejected before it can be reinterpreted.
    if (!domain || disallowedAscii.test(domain)) return null;
    const ascii = domainToASCII(domain);
    return asciiHostname.test(ascii) ? ascii : null;
};

/** A null MX ("." in zone files, "" from c-ares) says the domain accepts no mail (RFC 7505). */
const isNullMx = (record: MxRecord) => {
    const exchange = String(record?.exchange ?? '').trim();
    return exchange === '' || exchange === '.';
};

/** Keeps only a well-formed `node:dns` error code, so a log line never carries resolver text. */
const dnsErrorCode = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'EUNKNOWN';
};

class LookupTimeoutError extends Error {}

/**
 * Creates a checker with its own bounded cache. Deliverable and undeliverable
 * verdicts are cached for their TTLs; `unknown` is never cached, so the next
 * request retries. Concurrent checks for one domain share a single lookup.
 */
export const createEmailDomainDeliverability = (options: EmailDomainDeliverabilityOptions) => {
    const {
        resolveMx,
        maxEntries = emailDomainDeliverabilityDefaults.maxEntries,
        positiveTtlMs = emailDomainDeliverabilityDefaults.positiveTtlMs,
        negativeTtlMs = emailDomainDeliverabilityDefaults.negativeTtlMs,
        timeoutMs = emailDomainDeliverabilityDefaults.timeoutMs,
        now = Date.now
    } = options;
    const cache = new Map<string, { verdict: DomainDeliverability; expiresAt: number }>();
    const pending = new Map<string, Promise<DomainDeliverability>>();

    const remember = (domain: string, verdict: DomainDeliverability) => {
        if (verdict.status === 'unknown') return;
        cache.delete(domain);
        cache.set(domain, {
            verdict,
            expiresAt: now() + (verdict.status === 'deliverable' ? positiveTtlMs : negativeTtlMs)
        });
        // A Map iterates in insertion order, so its first key is the oldest entry.
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
    };

    const lookUp = async (domain: string): Promise<DomainDeliverability> => {
        let timer: NodeJS.Timeout | undefined;
        try {
            const records = await Promise.race([
                resolveMx(domain),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new LookupTimeoutError()), timeoutMs);
                })
            ]);
            if (!Array.isArray(records)) return { status: 'unknown', domain, reason: 'EBADRESP' };
            if (records.some(record => !isNullMx(record))) return { status: 'deliverable', domain };
            return { status: 'undeliverable', domain, reason: records.length ? 'null_mx' : 'no_mx' };
        } catch (error) {
            if (error instanceof LookupTimeoutError) return { status: 'unknown', domain, reason: 'timeout' };
            const code = dnsErrorCode(error);
            if (code === 'ENOTFOUND') return { status: 'undeliverable', domain, reason: 'nxdomain' };
            if (code === 'ENODATA') return { status: 'undeliverable', domain, reason: 'no_mx' };
            return { status: 'unknown', domain, reason: code };
        } finally {
            clearTimeout(timer);
        }
    };

    /** Resolves the verdict for an address's domain; it never rejects. */
    const check = (address: string): Promise<DomainDeliverability> => {
        const domain = emailAddressDomain(address);
        if (!domain) return Promise.resolve({ status: 'undeliverable', domain: null, reason: 'invalid_domain' });
        const cached = cache.get(domain);
        if (cached && cached.expiresAt > now()) return Promise.resolve(cached.verdict);
        if (cached) cache.delete(domain);
        const inFlight = pending.get(domain);
        if (inFlight) return inFlight;
        const lookup = lookUp(domain).then(verdict => {
            remember(domain, verdict);
            pending.delete(domain);
            return verdict;
        });
        pending.set(domain, lookup);
        return lookup;
    };

    return { check, cachedDomainCount: () => cache.size };
};

let systemResolver: Resolver | undefined;

/**
 * Production lookups use the host's configured name servers through
 * `node:dns/promises`. The checker stops waiting after its 3-second bound; the
 * resolver's own retries (`tries` counts per name server) may keep an abandoned
 * query running a few seconds longer on hosts with several name servers, which
 * is harmless because it never blocks a response. The resolver is created on
 * first use; importing this module opens nothing.
 */
export const systemMxResolver: MxResolver = domain => {
    systemResolver ??= new Resolver({ timeout: 1_000, tries: 2 });
    return systemResolver.resolveMx(domain);
};

let activeResolver: MxResolver = systemMxResolver;
let shared = createEmailDomainDeliverability({ resolveMx: activeResolver });

/** Checks an address with the process-wide checker shared by every authentication email. */
export const checkEmailDomainDeliverability = (address: string) => shared.check(address);

/**
 * Replaces the resolver behind the shared checker and starts with an empty
 * cache. Returns the previous resolver so a test can restore it; the server
 * test runner installs a synthetic resolver this way, so tests never query
 * real DNS.
 */
export const setEmailDomainResolver = (resolver: MxResolver): MxResolver => {
    const previous = activeResolver;
    activeResolver = resolver;
    shared = createEmailDomainDeliverability({ resolveMx: resolver });
    return previous;
};
