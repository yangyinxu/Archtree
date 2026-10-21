/**
 * Synthetic existing-Album reviews captured for metadata lookup (format 3) and synthetic MusicBrainz releases with per-track
 * credits, for tests of review runs, views and evidence without a database. All names and identifiers are synthetic.
 */
import { ObjectId } from 'mongodb';
import type { AdminImportDocument } from '../../src/administration/import/adminImportService';
import { SAME_AS_RELEASE_CREDIT, type LookupArtistCredit, type MusicBrainzRelease, type MusicBrainzTrack } from '../../src/administration/lookup/lookupContract';
import type { StoredLookupCandidate } from '../../src/administration/lookup/metadataLookupRecord';

export const reviewId = '0000000000000000000000b1';
export const reviewActor = '0000000000000000000000e1';
/** The manifest slot and catalog Track ID of member `index`. */
export const reviewSlot = (index: number) => `0000000b-0000-4000-a000-${String(index + 1).padStart(12, '0')}`;
export const reviewTrackId = (index: number) => `0000000000000000000b${String(index + 1).padStart(4, '0')}`;
/** A synthetic MusicBrainz ID. */
export const syntheticMbid = (index: number) => `0000000f-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** One member: its captured duration (null: none captured; `legacy`: whole seconds), and its own numbers as the draft shows them. */
export type ReviewMemberFixture = { durationMs?: number | null; legacy?: boolean; discNumber?: number | null; trackNumber?: number | null; title?: string };
/** Members with the given durations, numbered 1..n on no disc. */
export const numberedMembers = (durations: (number | null)[]): ReviewMemberFixture[] => durations.map((durationMs, index) => ({ durationMs, trackNumber: index + 1 }));

/**
 * A format-3 review of an Album titled `title` whose shown primary Artist Credits name `primaryNames` (one featured Artist Credit
 * and a label Credit are captured too, and never count as primary), with `members` in manifest order. `origins` marks draft value
 * origins; `capture: false` leaves the review without a capture, as before its first lookup admission.
 */
export function reviewLookupDocument(options: { title?: string; primaryNames?: string[]; members?: ReviewMemberFixture[]; origins?: Record<string, 'automatic' | 'administrator'>;
    capture?: boolean; id?: string } = {}): AdminImportDocument {
    const title = options.title ?? 'Synthetic Album', names = options.primaryNames ?? ['Synthetic Ensemble'], members = options.members ?? [];
    const at = new Date('2026-10-20T00:00:00Z'), slots = members.map((_member, index) => reviewSlot(index));
    const entryKey = (index: number) => `0000000c-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const subject = (name: string) => ({ name, musicBrainzId: null, revision: 'ar_synthetic' });
    const credits = [
        ...names.map((name, index) => ({ creditId: `credit-${index}`, subjectType: 'artist', subjectId: `0000000000000000000a${String(index + 1).padStart(4, '0')}`, role: 'primary',
            joinPhrase: null, entryKey: entryKey(index), subject: subject(name) })),
        { creditId: 'credit-featured', subjectType: 'artist', subjectId: '0000000000000000000a0099', role: 'featured', joinPhrase: null, entryKey: entryKey(99), subject: subject('Synthetic Guest') },
        { creditId: 'credit-label', subjectType: 'organization', subjectId: '0000000000000000000c0001', role: 'label', joinPhrase: null, entryKey: null, subject: subject('Synthetic Label') }
    ];
    const artists = [...names.map((name, index) => ({ key: entryKey(index), name, role: 'primary', joinPhrase: null, musicBrainzId: null })),
        { key: entryKey(99), name: 'Synthetic Guest', role: 'featured', joinPhrase: null, musicBrainzId: null }];
    return {
        _id: new ObjectId(options.id ?? reviewId), purpose: 'catalogReview', draftVersion: 3, actorId: reviewActor, revision: 2, createdAt: at, updatedAt: at,
        manifest: { rootLabel: '', files: slots.map((slotId, index) => ({ slotId, filename: `synthetic-${index + 1}.flac`, relativePath: '', byteLength: null })) },
        draft: {
            album: { title, artists, label: { name: 'Synthetic Label', musicBrainzId: null }, releaseDate: null, visibility: 'public', expectedTracklist: null },
            tracks: members.map((member, index) => ({ slotId: slots[index], title: member.title ?? `Synthetic Track ${index + 1}`, discNumber: member.discNumber ?? null,
                trackNumber: member.trackNumber ?? null, artists: [] }))
        },
        draftOrigins: options.origins ?? {},
        catalogSource: {
            album: { id: '0000000000000000000000a1', revision: `cr_${'a'.repeat(43)}`, title, releaseDate: null, visibility: 'public' },
            tracks: members.map((member, index) => ({ slotId: slots[index], id: reviewTrackId(index), revision: `tr_${index}`, title: member.title ?? `Synthetic Track ${index + 1}`,
                discNumber: member.discNumber ?? null, trackNumber: member.trackNumber ?? null, originalFileName: `synthetic-${index + 1}.flac` }))
        },
        catalogEvidence: Object.fromEntries(members.map((_member, index) => [reviewTrackId(index), `evidence-${index}`])),
        ...(options.capture === false ? {} : { catalogCapture: {
            capturedAt: at,
            album: { credits, artistsComplete: true, label: 'first', expectedTracklist: null },
            members: members.map((member, index) => ({ slotId: slots[index], credits: [], artistsComplete: true, attributionStatus: null,
                duration: typeof member.durationMs === 'number' ? { durationMs: member.durationMs, durationPrecisionMs: member.legacy ? 1000 : 0 } : null }))
        } }),
        analysis: { state: 'idle', generation: 0, operationId: null, actorId: null, grantExpiresAt: null, baseline: null, chunks: [], issue: null, leaseOwner: null, leaseUntil: null },
        analysisHistory: [], attemptsUsed: 0, suggestions: [], decisions: [], receipts: []
    } as unknown as AdminImportDocument;
}

/** A credit of one artist, or one that features a second, as MusicBrainz credits them. */
export const credit = (name: string, artistId: string, guest?: [string, string]): LookupArtistCredit[] => guest
    ? [{ name, joinPhrase: ' feat. ', artistId, artistName: name }, { name: guest[0], joinPhrase: '', artistId: guest[1], artistName: guest[0] }]
    : [{ name, joinPhrase: '', artistId, artistName: name }];
/** One synthetic track: its length and, optionally, its own credit (`release`: stored as equal to the release's; absent when not given). */
export type SyntheticTrack = { lengthMs: number | null; credit?: LookupArtistCredit[] | 'release' };
/**
 * A synthetic release `id` with one medium per entry of `media` (a CD unless a format is given), its tracks numbered 1..n per
 * medium, credited `releaseCredit` with an optional first label.
 */
export function syntheticRelease(id: string, media: { format?: string | null; tracks: SyntheticTrack[] }[], options: { title?: string; releaseCredit?: LookupArtistCredit[];
    label?: { name: string; labelId: string } } = {}): MusicBrainzRelease {
    const releaseCredit = options.releaseCredit ?? credit('Synthetic Ensemble', syntheticMbid(1));
    return {
        releaseId: id, releaseGroupId: null, title: options.title ?? 'Synthetic Album', status: 'Official', artistCredit: releaseCredit,
        labels: options.label ? [{ name: options.label.name, labelId: options.label.labelId, catalogNumber: null }] : [], barcode: null, barcodeText: null, country: null,
        date: { year: 2020, month: null, day: null }, primaryType: 'Album', secondaryTypes: [], trackCount: media.reduce((sum, medium) => sum + medium.tracks.length, 0),
        groupFirstReleaseDate: null, frontArtwork: false,
        media: media.map((medium, at) => ({ position: at + 1, format: medium.format === undefined ? 'CD' : medium.format, tracks: medium.tracks.map((track, index): MusicBrainzTrack => ({
            position: index + 1, number: String(index + 1), title: `Synthetic Track ${index + 1}`, lengthMs: track.lengthMs, recordingId: syntheticMbid(900 + index), isrcs: [],
            ...(track.credit === undefined ? {} : { artistCredit: track.credit === 'release' ? SAME_AS_RELEASE_CREDIT : track.credit }) })) }))
    } as MusicBrainzRelease;
}
/** A stored candidate of `release`: fetched by default, else incomplete with the given details state. */
export const storedCandidate = (release: MusicBrainzRelease, details: StoredLookupCandidate['details'] = 'fetched'): StoredLookupCandidate => ({
    key: `musicbrainz:${release.releaseId}`, source: 'musicbrainz', releaseId: release.releaseId, basis: 'albumText', summary: null,
    release: details === 'fetched' ? release : null, details
});
