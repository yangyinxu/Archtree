export const managementInventoryPageSize = 50;
export const maximumManagementInventoryPage = 10_000;

export interface ManagementInventoryPage<T> {
    items: T[];
    page: number;
    hasPrevious: boolean;
    hasNext: boolean;
}

/** Normalizes an untrusted page query to a bounded administrator inventory page. */
export const normalizeManagementInventoryPage = (value: unknown) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(Math.floor(parsed), maximumManagementInventoryPage);
};

export const managementInventoryOffset = (page: number) =>
    (page - 1) * managementInventoryPageSize;

/** Converts a limit-plus-one query result into stable pagination metadata. */
export const toManagementInventoryPage = <T>(
    records: T[],
    page: number
): ManagementInventoryPage<T> => ({
    items: records.slice(0, managementInventoryPageSize),
    page,
    hasPrevious: page > 1,
    hasNext: page < maximumManagementInventoryPage
        && records.length > managementInventoryPageSize
});
