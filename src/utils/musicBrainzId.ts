/**
 * MusicBrainz IDs an Artist or Organization may keep as private import provenance: the format check, the placeholder identities
 * that are never kept, and the unique index both collections enforce. Pure, no I/O. Owner rules: docs/business-rules.md (Catalog
 * Visibility and Administration; Administrator Album Imports).
 */

const musicBrainzIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Lowercase 8-4-4-4-12 hex UUID; the nil UUID is refused. The UUID version is not enforced: real MusicBrainz IDs include
 * version-3 UUIDs. Uppercase input is accepted and returned lowercase.
 */
export const normalizeMusicBrainzId = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length !== 36) return null;
    const id = value.toLowerCase();
    return musicBrainzIdPattern.test(id) && id !== '00000000-0000-0000-0000-000000000000' ? id : null;
};

/**
 * Special purpose artists, including the documented subsets that have their own ID
 * (https://musicbrainz.org/doc/Style/Unknown_and_untitled/Special_purpose_artist, read 2026-10-19): Various Artists, [unknown],
 * [anonymous], [traditional], [data], [dialogue], [no artist], MusicBrainz Test Artist, then [Disney], [theatre], [church chimes]
 * and [language instruction].
 */
export const MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS: readonly string[] = Object.freeze([
    '89ad4ac3-39f7-470e-963a-56509c546377', '125ec42a-7229-4250-afc5-e057484327fe', 'f731ccc4-e22a-43af-a747-64213329e088',
    '9be7f096-97ec-4615-8957-8d40b5dcbc41', '33cf029c-63b0-41a0-9855-be2a3665fb3b', '314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc',
    'eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61', '7e84f845-ac16-41fe-9ff8-df12eb32af55', '66ea0139-149f-4a0c-8fbf-5ea9ec4a6e49',
    'a0ef7e1d-44ff-4039-9435-7d5fefdeecc9', '90068d37-bae7-4292-be4a-704c145bd616', '80a8851f-444c-4539-892b-ad2a49292aa9'
]);
/**
 * Special purpose labels (https://musicbrainz.org/doc/Style/Unknown_and_untitled/Special_purpose_label, read 2026-10-19):
 * [no label], [unknown] and MusicBrainz Test Label.
 */
export const MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS: readonly string[] = Object.freeze([
    '157afde4-4bf5-4039-8ad2-5a15acc85176', '46caaa9e-3e26-49b5-827c-64ccc73c1b07', '02442aba-cf00-445c-877e-f0eaa504d8c2'
]);
const specialPurpose = new Set<string>([...MUSICBRAINZ_SPECIAL_PURPOSE_ARTIST_IDS, ...MUSICBRAINZ_SPECIAL_PURPOSE_LABEL_IDS]);

/** True for any special purpose artist or label ID; both lists form one blocklist for Artists and Organizations alike. */
export const isSpecialPurposeMusicBrainzId = (id: string): boolean => specialPurpose.has(id.toLowerCase());
/** A well-formed ID that is no placeholder identity, lowercase; anything else is null. */
export const keepableMusicBrainzId = (value: unknown): string | null => {
    const id = normalizeMusicBrainzId(value);
    return id && !specialPurpose.has(id) ? id : null;
};

/** Index names of the unique partial MusicBrainz ID indexes (databaseIndexes.ts). */
export const MUSICBRAINZ_ID_INDEX_NAMES = Object.freeze({ artists: 'artist_musicbrainz_id', organizations: 'organization_musicbrainz_id' });
/** Only stored string IDs are indexed, so any number of records without an ID (absent or null) coexist. */
export const musicBrainzIdPartialFilter = { musicBrainzId: { $type: 'string' as const } };

/**
 * A duplicate key on a MusicBrainz ID index: code 11000 whose key pattern names `musicBrainzId`, or whose message names one of
 * the index names above. A duplicate `_id` (or any other index) is not.
 */
export function isMusicBrainzIdDuplicateKey(error: unknown): boolean {
    if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 11000) return false;
    const keyPattern = (error as { keyPattern?: unknown }).keyPattern;
    if (keyPattern && typeof keyPattern === 'object' && Object.prototype.hasOwnProperty.call(keyPattern, 'musicBrainzId')) return true;
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && Object.values(MUSICBRAINZ_ID_INDEX_NAMES).some(name => message.includes(name));
}
