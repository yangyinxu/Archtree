export const coverArtUrlForId = (imageId: string) => `/content/images/${imageId}`;

export const withDerivedCoverArtUrl = <T extends Record<string, any> | null>(record: T): T => {
    if (record?.coverArtId) {
        (record as Record<string, any>).coverArtUrl = coverArtUrlForId(String(record.coverArtId));
    }
    return record;
};
