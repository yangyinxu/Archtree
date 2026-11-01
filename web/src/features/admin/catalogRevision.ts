import { z } from 'zod';

/** Opaque digests bind an administrator approval to the exact saved snapshot. */
export const revision = z.string().regex(/^cr_[A-Za-z0-9_-]{43}$/);
