export const escapeRegex = (value: string) => {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

export const boundedSearchQuery = (value: unknown, maximumLength: number = 100) => {
    return String(value ?? '').trim().slice(0, maximumLength);
};
