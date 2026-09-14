import { z } from 'zod';

/** Public allowlists shared by social identity and room projections. */
export const socialIdSchema = z.string().regex(/^s_[a-f0-9]{32}$/);
export const socialRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const socialCardSchema = z.object({
  socialId: socialIdSchema, handle: z.string().regex(/^[a-z][a-z0-9_]{2,23}$/),
  alias: z.string().min(1).max(200), iconSeed: z.string().min(1).max(100)
}).strict();
export const socialProfileSchema = socialCardSchema.extend({
  active: z.boolean(), discoverable: z.boolean(), revision: socialRevisionSchema
}).strict();
export const socialPageSchema = z.object({
  items: z.array(z.object({ socialId: socialIdSchema, profile: socialCardSchema.nullable(), revision: socialRevisionSchema }).strict()).max(50),
  nextCursor: z.string().min(1).max(512).nullable()
}).strict();
export const socialOutcomeSchema = z.object({
  commandId: z.string().min(16).max(80), outcome: z.enum(['applied', 'noop', 'rejected']),
  code: z.string().max(100).optional(), replayed: z.boolean()
}).strict();
