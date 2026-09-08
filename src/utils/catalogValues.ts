

/** Keeps first occurrence order when normalizing a set of nonempty catalog references. */
export const uniqueStrings = (values: string[]) => {
    return [...new Set(values.filter(Boolean))];
};

/** Normalizes a catalog identifier for view and form adapters without reading storage. */
export const contentId = (item: any) => String(item?._id ?? '');
