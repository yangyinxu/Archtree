import { z } from 'zod';

/** Public account identity intentionally excludes credentials and session IDs. */
export const browserSessionUserSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().email(),
    role: z.string().min(1),
    displayName: z.string(),
    avatarRevision: z.number().int().nonnegative(),
    avatar: z
      .object({
        assetId: z.string().min(1).optional(),
        revision: z.number().int().nonnegative()
      })
      .strict()
      .nullable(),
    emailVerified: z.boolean(),
    authenticationMethods: z.array(z.enum(['password', 'apple', 'google', 'passkey'])).optional()
  })
  .strict();

export const browserSessionSchema = z
  .object({
    user: browserSessionUserSchema
  })
  .strict();

export const loginInputSchema = z
  .object({
    identifier: z.string().trim().min(1),
    password: z.string().min(1)
  })
  .strict();

export const apiErrorPayloadSchema = z
  .object({
    message: z.string().optional(),
    error: z.string().optional(),
    code: z.string().optional(),
    requiresAvatarDeletion: z.boolean().optional()
  })
  .passthrough()
  .transform((payload) => ({
    ...payload,
    // Preserve the typed recovery signal through the shared ApiError boundary.
    code: payload.code ?? (payload.requiresAvatarDeletion ? 'requires_avatar_deletion' : undefined)
  }));

export type BrowserSession = z.infer<typeof browserSessionSchema>;
export type BrowserSessionUser = z.infer<typeof browserSessionUserSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
