export const coverArtUrlForId = (imageId: string) => `/content/images/${imageId}`;

export const resolvedCoverArtUrl = (record: Record<string, any> | null | undefined) => {
    if (record?.coverArtId) {
        return coverArtUrlForId(String(record.coverArtId));
    }
    return String(record?.coverArtUrl ?? '').trim();
};

export const withDerivedCoverArtUrl = <T extends Record<string, any> | null>(record: T): T => {
    if (record?.coverArtId) {
        (record as Record<string, any>).coverArtUrl = coverArtUrlForId(String(record.coverArtId));
    }
    return record;
};

export const withDisplayCoverArtUrl = <T extends Record<string, any>>(
    audioTrack: T,
    album?: Record<string, any> | null
): T & { displayCoverArtUrl: string } => {
    const track = withDerivedCoverArtUrl(audioTrack);
    return Object.assign(track, {
        displayCoverArtUrl: resolvedCoverArtUrl(track) || resolvedCoverArtUrl(album)
    });
};
