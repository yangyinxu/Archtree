export type UserRole = 'admin' | 'user';

/** Grants administrative privileges only to the exact persisted admin role. */
export const normalizeUserRole = (value: unknown): UserRole =>
    value === 'admin' ? 'admin' : 'user';
