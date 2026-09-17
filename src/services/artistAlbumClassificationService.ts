import { catalogCreditRollout } from '../config/catalogCreditRollout';
import { CatalogCredit, classifyArtistAlbumCredit, normalizeCatalogCredits, validateAttribution } from '../models/catalogCredit';

/** Reads canonical attribution without interpreting malformed or intentionally empty Credits as legacy. */
export const validStoredCredits = (owner: any): CatalogCredit[] | null => {
    if (!catalogCreditRollout().readsEnabled || !Array.isArray(owner?.credits)) return null;
    try {
        const credits = normalizeCatalogCredits(owner.credits);
        validateAttribution(owner.attributionStatus, credits);
        return credits;
    } catch { return null; }
};

/** Artist pages and dynamic Album carousels share precedence and the unmigrated-only fallback. */
export const artistAlbumSection = (artist: any, album: any, tracks: any[]) => {
    const artistId = String(artist._id).toLowerCase();
    const albumId = String(album._id).toLowerCase();
    const relatedTracks = tracks.filter(track => String(track.albumId ?? '').toLowerCase() === albumId);
    const rollout = catalogCreditRollout();
    const canonical = rollout.readsEnabled && rollout.sectionsEnabled;
    // An explicit unmigrated Album relationship represents primary credit, so
    // it must participate at primary precedence even when its tracks migrated first.
    if ((!canonical || album.credits === undefined)
        && (Array.isArray(artist.albumIds) ? artist.albumIds : []).some((id: unknown) => String(id).toLowerCase() === albumId)) return 'discography';
    const section = canonical ? classifyArtistAlbumCredit(artistId, validStoredCredits(album) ?? [],
        relatedTracks.flatMap(track => validStoredCredits(track) ?? [])) : null;
    if (section && section !== 'credits') return section;
    // Legacy track participation has Appears On precedence over composer/producer Credits.
    if (relatedTracks.some(track => (!canonical || track.credits === undefined)
        && (Array.isArray(track.artistIds) ? track.artistIds : []).some((id: unknown) => String(id).toLowerCase() === artistId))) return 'appearsOn';
    return section;
};
