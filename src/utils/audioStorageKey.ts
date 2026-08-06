/** Allows only the legacy root key or a versioned key bound to one Soundtrack identity. */
export const isAudioObjectKeyForTrack = (value: unknown, audioTrackId: string) => {
    if (typeof value !== 'string') return false;
    const normalizedTrackId = audioTrackId.toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(normalizedTrackId)) return false;
    if (value === normalizedTrackId) return true;
    const match = /^audio\/([0-9a-f]{24})\/([0-9a-f]{24})$/i.exec(value);
    return Boolean(match && match[1].toLowerCase() === normalizedTrackId);
};

/** Restricts MongoDB queries to a ready object bound to the row's `_id`. */
export const readyAudioObjectFilter = {
    uploadStatus: 'ready',
    $expr: {
        $let: {
            vars: {
                storageKey: {
                    $convert: {
                        input: '$s3Key',
                        to: 'string',
                        onError: '',
                        onNull: ''
                    }
                },
                trackId: { $toString: '$_id' }
            },
            in: {
                $or: [
                    { $eq: ['$$storageKey', '$$trackId'] },
                    {
                        $and: [
                            {
                                $regexMatch: {
                                    input: '$$storageKey',
                                    regex: /^audio\/[0-9a-f]{24}\/[0-9a-f]{24}$/i
                                }
                            },
                            {
                                $eq: [
                                    {
                                        $toLower: {
                                            $arrayElemAt: [
                                                { $split: ['$$storageKey', '/'] },
                                                1
                                            ]
                                        }
                                    },
                                    '$$trackId'
                                ]
                            }
                        ]
                    }
                ]
            }
        }
    }
} as const;

/** Treats legacy rows as published while hiding new rows until catalog linking commits. */
export const publishedAudioTrackFilter = {
    $or: [
        { publicationStatus: 'ready' },
        { publicationStatus: { $exists: false } }
    ]
} as const;

/** Restricts public/reference queries to published, identity-bound ready audio. */
export const readyAudioStorageFilter = {
    ...readyAudioObjectFilter,
    ...publishedAudioTrackFilter
} as const;
