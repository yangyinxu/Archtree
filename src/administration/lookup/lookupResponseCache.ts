/**
 * Process-local LRU of validated lookup answers, bounded by entries, approximate bytes (the raw body
 * length) and age. Values are deep-frozen, so a cached `null` (a 404 answer) is as safe to share as a
 * parsed release. Failures are never stored; callers only `set` complete answers.
 */
export interface LookupResponseCache {
    /** A miss is `undefined`; a hit wraps the value, which may itself be `null`. */
    get(key: string): { value: unknown } | undefined;
    set(key: string, value: unknown, bytes: number): void;
    clear(): void;
}

export type LookupResponseCacheOptions = { maxEntries?: number; maxBytes?: number; ttlMs?: number; now?: () => number };

const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nested of Object.values(value)) deepFreeze(nested);
    }
    return value;
};

export const createLookupResponseCache = ({ maxEntries = 128, maxBytes = 8 * 1024 * 1024, ttlMs = 15 * 60 * 1000, now = Date.now }: LookupResponseCacheOptions = {}): LookupResponseCache => {
    const entries = new Map<string, { value: unknown; bytes: number; expiresAt: number }>();
    let totalBytes = 0;
    const remove = (key: string) => {
        const entry = entries.get(key);
        if (!entry) return;
        entries.delete(key); totalBytes -= entry.bytes;
    };
    return {
        get(key) {
            const entry = entries.get(key);
            if (!entry) return undefined;
            if (entry.expiresAt <= now()) { remove(key); return undefined; }
            // Re-insert to mark the entry as most recently used.
            entries.delete(key); entries.set(key, entry);
            return { value: entry.value };
        },
        set(key, value, bytes) {
            remove(key);
            const size = Math.max(0, Math.ceil(Number.isFinite(bytes) ? bytes : maxBytes + 1));
            if (size > maxBytes || maxEntries < 1) return;
            entries.set(key, { value: deepFreeze(value), bytes: size, expiresAt: now() + ttlMs });
            totalBytes += size;
            for (const oldest of entries.keys()) {
                if (entries.size <= maxEntries && totalBytes <= maxBytes) break;
                remove(oldest);
            }
        },
        clear() { entries.clear(); totalBytes = 0; }
    };
};
