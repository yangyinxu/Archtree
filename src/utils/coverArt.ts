export const coverArtUrlForId = (imageId: string) => `/content/images/${imageId}`;

export const withDerivedCoverArtUrl = <T extends Record<string, any> | null>(record: T): T => {
    if (record?.coverArtId) {
        record.coverArtUrl = coverArtUrlForId(String(record.coverArtId));
    }
    return record;
};
