/**
 * Metadata lookup runs for existing-Album reviews against fixture MusicBrainz answers (iTunes answers nothing), shared by the
 * review integration tests: the review's two searches for the Album "Existing Album" by "Existing Artist", synthetic releases
 * with a release credit, a label and per-track credits, and the worker drained until nothing is due. All names and identifiers
 * are synthetic.
 */
import { createMusicBrainzClient, musicBrainzUrls, type MusicBrainzReleaseQuery } from '../../src/administration/lookup/musicBrainzClient';
import { runMetadataLookupOnce } from '../../src/administration/lookup/metadataLookupService';
import { emptyItunesClient, fixtureTransport, immediateGate, type LookupExchange } from './metadataLookupFixtures';

export const lookupContact = 'lookup-operator@example.test';
export const lookupJson = (url: string, body: unknown): LookupExchange => ({ url, status: 200, headers: { 'content-type': 'application/json' }, body });
/** A synthetic MusicBrainz ID. */
export const lookupMbid = (index: number) => `0000000d-0000-4000-8000-${String(index).padStart(12, '0')}`;
export const reviewSearch = (query: MusicBrainzReleaseQuery, releases: [string, number][]) => lookupJson(musicBrainzUrls.releaseSearch(query).href, { count: releases.length, offset: 0,
    releases: releases.map(([id, trackCount], index) => ({ id, title: `Synthetic Release ${index}`, score: 100 - index, 'track-count': trackCount })) });
/** The review's two searches (its saved title with and without its primary Artist), each finding `releases`. */
export const reviewSearches = (releases: [string, number][] = []) => [reviewSearch({ release: 'Existing Album', artist: 'Existing Artist' }, releases), reviewSearch({ release: 'Existing Album' }, releases)];

/** An artist a credit names: its MusicBrainz ID and credited name. */
export type CreditedArtist = [string, string];
/**
 * A release `id` titled "Looked Up Album" whose tracks (two by default, each lasting `lengths`, a minute by default) pair with the
 * review's members: credited to `releaseArtists` (Existing Artist by default) with `label` (Looked Up Label by default; null: none),
 * each track crediting its own artists (`tracks`, joined by ` & `; null: no stored track credit), with an alias answer (`aliases`,
 * none by default) for every artist and the label its run asks for.
 */
export function creditedRelease(id: string, options: { releaseArtists?: CreditedArtist[]; label?: CreditedArtist | null; tracks?: (CreditedArtist[] | null)[];
    aliases?: Record<string, string[]>; lengths?: number[] } = {}): LookupExchange[] {
    const releaseArtists = options.releaseArtists ?? [[lookupMbid(30), 'Existing Artist']], label = options.label === undefined ? [lookupMbid(40), 'Looked Up Label'] as CreditedArtist : options.label;
    const tracks = options.tracks ?? (options.lengths ?? [60_000, 60_000]).map(() => null), length = (index: number) => options.lengths?.[index] ?? 60_000;
    const credit = (artists: CreditedArtist[]) => artists.map(([artistId, name], index) => ({ name, joinphrase: index < artists.length - 1 ? ' & ' : '', artist: { id: artistId, name } }));
    const artistIds = new Map<string, string>([...releaseArtists, ...tracks.flatMap(artists => artists ?? [])].map(([artistId, name]) => [artistId, name]));
    for (const [artistId, name] of releaseArtists) artistIds.set(artistId, name);
    return [lookupJson(musicBrainzUrls.release(id).href, { id, title: 'Looked Up Album', date: '2019-04-01', 'artist-credit': credit(releaseArtists),
        ...(label ? { 'label-info': [{ 'catalog-number': 'SYN-1', label: { id: label[0], name: label[1] } }] } : {}),
        media: [{ position: 1, format: 'CD', tracks: tracks.map((artists, index) => ({ position: index + 1, number: String(index + 1), title: `Looked Up Track ${index + 1}`, length: length(index),
            recording: { id: lookupMbid(900 + index), length: length(index) }, ...(artists ? { 'artist-credit': credit(artists) } : {}) })) }] }),
        ...releaseArtists.map(([artistId, name]) => lookupJson(musicBrainzUrls.artistAliases(artistId).href, { id: artistId, name, aliases: (options.aliases?.[artistId] ?? []).map(alias => ({ name: alias })) })),
        ...(label ? [lookupJson(musicBrainzUrls.labelAliases(label[0]).href, { id: label[0], name: label[1], aliases: [] })] : []),
        ...[...artistIds].filter(([artistId]) => !releaseArtists.some(([released]) => released === artistId))
            .map(([artistId, name]) => lookupJson(musicBrainzUrls.artistAliases(artistId).href, { id: artistId, name, aliases: (options.aliases?.[artistId] ?? []).map(alias => ({ name: alias })) }))];
}
/** A two-track release credited to Existing Artist with a label, whose one-minute tracks pair with the review's members. */
export const pairableRelease = (id: string) => creditedRelease(id);
/**
 * A two-track release like pairableRelease whose tracks credit their own artists (an artist ID and name each; null: no stored
 * credit), with every alias answer its run asks for.
 */
export const trackCreditedRelease = (id: string, trackArtists: (CreditedArtist | null)[]) => creditedRelease(id, { tracks: trackArtists.map(artist => artist ? [artist] : null) });

/** Runs the lookup worker over fixture MusicBrainz answers (iTunes answers nothing) until nothing is due; returns what was sent. */
export async function drainLookup(exchanges: LookupExchange[]) {
    const fixture = fixtureTransport(exchanges), musicBrainz = createMusicBrainzClient({ gate: immediateGate(), transport: fixture.transport, sleep: async () => undefined });
    for (let tick = 0; tick < 10 && await runMetadataLookupOnce({ musicBrainz, itunes: emptyItunesClient() }); tick++);
    return fixture.requests;
}
/** Runs `work` with the metadata lookup operator contact configured. */
export async function withLookup(work: () => Promise<void>) {
    process.env.FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT = lookupContact;
    try { await work(); } finally { delete process.env.FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT; }
}
