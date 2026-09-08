/**
 * Canonical public /api/listener/v1 contract, independent of persistence and HTTP.
 * Response readers strip unknown additive fields; known values and enum variants
 * remain validated. See docs/architecture.md#compatibility-policy for evolution rules.
 */
export type ListenerMediaType = 'audio' | 'video';
export type ListenerAttributionStatus = 'documented' | 'unknown';
export type ListenerCatalogCreditRole =
    | 'primary' | 'featured' | 'performer' | 'composer' | 'producer' | 'remixer'
    | 'label' | 'publisher' | 'distributor' | 'presenter' | 'legacyUnspecified';

/** Partial catalog date; absent precision is not invented by a client. */
export interface ListenerDate {
    year?: number;
    month?: number;
    day?: number;
}

/** Ready public Artist identity, excluding ownership and lifecycle metadata. */
export interface ListenerArtistSummary {
    contentType: 'artist';
    id: string;
    name: string;
    bio: string;
    artworkUrl: string;
}

/** Ready Organization identity; institution attribution remains distinct from Artists. */
export interface ListenerOrganizationSummary {
    contentType: 'organization';
    id: string;
    name: string;
    organizationType: string;
    description: string;
}

/** Allowlisted Album card metadata shared by every public composition surface. */
export interface ListenerAlbumSummary {
    contentType: 'album';
    id: string;
    title: string;
    artworkUrl: string;
    artistNames: string[];
    releaseDate: ListenerDate | null;
    credits?: ListenerCatalogCredit[];
    displayByline?: string;
    attributionStatus?: ListenerAttributionStatus;
}

/** One ready MediaTrack with exactly one active media kind and stream identity. */
export interface ListenerAudioTrackSummary {
    contentType: 'audioTrack';
    id: string;
    title: string;
    artworkUrl: string;
    artistNames: string[];
    albumId: string | null;
    albumTitle: string | null;
    duration: string | null;
    mediaType: ListenerMediaType;
    streamUrl: string;
    credits?: ListenerCatalogCredit[];
    displayByline?: string;
    attributionStatus?: ListenerAttributionStatus;
}

/** Ordered public attribution without internal credit IDs or persistence fields. */
export interface ListenerCatalogCredit {
    subjectType: 'artist' | 'organization';
    subjectId: string;
    name: string;
    role: ListenerCatalogCreditRole;
    order: number;
}

export type ListenerPlayableSummary = ListenerAlbumSummary | ListenerAudioTrackSummary;
export type ListenerPresentation = 'carousel' | 'grid' | 'list';

/** One configured presentation preserving its ordered, ready content. */
export interface ListenerHomeSection {
    id: string;
    title: string;
    presentation: ListenerPresentation;
    items: ListenerPlayableSummary[];
}

export type ListenerPageSlug = 'home' | 'library';

/** A stable ordered reference into one page-scoped collection response. */
export interface ListenerCollectionPageRef {
    contentType: 'album' | 'audioTrack';
    contentId: string;
    order: number;
}

/** Bounded Grid/List response with included summaries and an opaque continuation. */
export interface ListenerCollectionPage {
    pageItem: {
        id: string;
        pageSlug: ListenerPageSlug;
        title: string;
        presentation: 'grid' | 'list';
        mode: 'manual';
        contentType: 'album' | 'audioTrack';
    };
    items: ListenerCollectionPageRef[];
    included: {
        albums: ListenerAlbumSummary[];
        audioTracks: ListenerAudioTrackSummary[];
    };
    limit: number;
    nextCursor: string | null;
}

/** Public composition envelopes share the same allowlisted content summaries. */
export interface ListenerHome {
    title: string;
    sections: ListenerHomeSection[];
}

/** Public search groups; each result uses the same catalog DTO. */
export interface ListenerSearch {
    query: string;
    artists: ListenerArtistSummary[];
    organizations: ListenerOrganizationSummary[];
    albums: ListenerAlbumSummary[];
    audioTracks: ListenerAudioTrackSummary[];
}

/** Album detail preserves canonical ready-track ordering. */
export interface ListenerAlbum {
    album: ListenerAlbumSummary;
    tracks: ListenerAudioTrackSummary[];
}

/** Artist sections are additive for consumers predating the Credits migration. */
export interface ListenerArtist {
    artist: ListenerArtistSummary;
    albums: ListenerAlbumSummary[];
    audioTracks: ListenerAudioTrackSummary[];
    discography?: ListenerAlbumSummary[];
    collaborations?: ListenerAlbumSummary[];
    appearsOn?: ListenerAlbumSummary[];
    creditAlbums?: ListenerAlbumSummary[];
}

/** Organization detail exposes only the public institutional identity and Releases. */
export interface ListenerOrganization {
    organization: Omit<ListenerOrganizationSummary, 'contentType'>;
    releases: ListenerAlbumSummary[];
}

/** One playable MediaTrack detail response. */
export interface ListenerTrack {
    audioTrack: ListenerAudioTrackSummary;
}
