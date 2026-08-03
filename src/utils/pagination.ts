const maximumOffset = 1_000_000;

/** Converts an untrusted query value to a finite integer limit. */
export const boundedLimit = (value: unknown, fallback: number, maximum: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(Math.floor(parsed), maximum));
};

/** Converts an untrusted query value to a bounded non-negative integer offset. */
export const boundedOffset = (value: unknown) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(Math.floor(parsed), maximumOffset));
};
