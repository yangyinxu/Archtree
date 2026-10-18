import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { LookupAddress } from 'node:dns';
import type { PinnedHttpsResponse, PinnedHttpsTransport } from '../../src/administration/adminPinnedHttps';
import { METADATA_LOOKUP_RATES, metadataLookupSources, type MetadataLookupSource } from '../../src/administration/lookup/lookupContract';
import { createProcessLookupRateGate } from '../../src/administration/lookup/lookupRateGate';

/**
 * Loads recorded and synthetic metadata-lookup exchanges and serves them through a fake pinned
 * transport, so client tests exercise the real request path without DNS or sockets.
 */
export type LookupExchange = {
    url: string; status: number;
    /** Recorded files keep only content-type, location and retry-after; synthetic ones may also set content-length (null omits it) and content-encoding. */
    headers: Record<string, string | null>;
    body?: unknown; bodyText?: string; bodyBase64?: string;
    /** Synthetic only: JSON whitespace appended after `body`, for streamed-size tests. */
    bodyPadding?: number;
};
export type LookupFixtureFile = { source: MetadataLookupSource; recordedAt?: string; description: string; synthetic?: boolean; exchanges: LookupExchange[] };

export const fixtureRoot = fileURLToPath(new URL('../fixtures/metadataLookup/', import.meta.url));
export const fixtureAddress: LookupAddress = Object.freeze({ address: '8.8.8.8', family: 4 });

/** Reads one fixture file by its path under `test/fixtures/metadataLookup/`. */
export const loadLookupFixture = (file: string): LookupFixtureFile => JSON.parse(readFileSync(path.join(fixtureRoot, file), 'utf8'));

/** Every fixture file of one source, keyed by its file name. */
export const loadLookupFixtures = (source: MetadataLookupSource): Map<string, LookupFixtureFile> => new Map(readdirSync(path.join(fixtureRoot, source))
    .filter(name => name.endsWith('.json')).sort().map(name => [name, loadLookupFixture(`${source}/${name}`)]));

export const allLookupFixtureFiles = () => metadataLookupSources.flatMap(source => [...loadLookupFixtures(source).entries()].map(([name, file]) => ({ path: `${source}/${name}`, file })));

/** The exact bytes a fixture exchange serves. */
export const fixtureBytes = (exchange: LookupExchange): Buffer => {
    if (exchange.bodyBase64 !== undefined) return Buffer.from(exchange.bodyBase64, 'base64');
    if (exchange.bodyText !== undefined) return Buffer.from(exchange.bodyText, 'utf8');
    if (exchange.body !== undefined) return Buffer.from(JSON.stringify(exchange.body) + ' '.repeat(exchange.bodyPadding ?? 0), 'utf8');
    return Buffer.alloc(0);
};

/** Serves each URL's exchanges in order; an unrecorded URL is a clear test failure, never a network request. */
export const fixtureTransport = (exchanges: readonly LookupExchange[]) => {
    const queues = new Map<string, LookupExchange[]>();
    for (const exchange of exchanges) queues.set(exchange.url, [...(queues.get(exchange.url) ?? []), exchange]);
    const requests: { url: string; headers: Readonly<Record<string, string>> }[] = [];
    const lookups: string[] = [];
    const bodies: Readable[] = [];
    const transport: PinnedHttpsTransport = {
        lookup: async hostname => { lookups.push(hostname); return [fixtureAddress]; },
        request: async (url, _address, _signal, headers) => {
            requests.push({ url: url.href, headers });
            const exchange = queues.get(url.href)?.shift();
            if (!exchange) throw new Error(`No recorded exchange for ${url.href}`);
            const bytes = fixtureBytes(exchange);
            const headerValues: Record<string, string> = {};
            for (const [name, value] of Object.entries(exchange.headers)) if (value !== null) headerValues[name.toLowerCase()] = value;
            if (!('content-length' in exchange.headers) && bytes.length) headerValues['content-length'] = String(bytes.length);
            const body = Readable.from(bytes.length ? [bytes] : []);
            bodies.push(body);
            const response: PinnedHttpsResponse = {
                statusCode: exchange.status, headers: headerValues,
                rawHeaders: Object.entries(headerValues).flatMap(([name, value]) => [name, value]), body
            };
            return response;
        }
    };
    return { transport, requests, lookups, bodies };
};

/**
 * Process gate without spacing, for tests that are not about pacing. It runs on a virtual clock
 * that only its own waits advance, so a pushed Retry-After backoff is honored without real delay.
 */
export const immediateGate = () => {
    let virtualNow = 0;
    return createProcessLookupRateGate({
        rates: Object.fromEntries(metadataLookupSources.map(source => [source, { ...METADATA_LOOKUP_RATES[source], intervalMs: 0, concurrency: 100 }])),
        now: () => virtualNow,
        sleep: async (ms, signal) => { signal.throwIfAborted(); virtualNow += ms; }
    });
};

/** A complete lookup configuration with a synthetic operator contact. */
export const availableLookupConfiguration = () => ({ available: true as const, userAgent: 'Finitude/1.0 ( lookup-operator@example.test )' });
