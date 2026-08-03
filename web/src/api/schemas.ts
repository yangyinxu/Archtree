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

/** Advertises only authentication methods that have a complete browser-cookie flow. */
export const browserAuthenticationCapabilitiesSchema = z
  .object({
    password: z.boolean(),
    emailRegistration: z.boolean(),
    apple: z.boolean(),
    google: z.boolean(),
    passkey: z.boolean()
  })
  .strict();

export const acceptedAuthenticationActionSchema = z
  .object({
    message: z.string().min(1)
  })
  .strict();

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z.string().min(12).max(256);

export const registerInputSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().max(80).optional()
  })
  .strict();

export const emailActionInputSchema = z
  .object({
    email: emailSchema
  })
  .strict();

export const verificationInputSchema = z
  .object({
    email: emailSchema,
    code: z.string().trim().regex(/^\d{6}$/)
  })
  .strict();

export const resetPasswordInputSchema = verificationInputSchema
  .extend({ password: passwordSchema })
  .strict();

export const changePasswordInputSchema = z
  .object({
    currentPassword: z.string().max(256).optional(),
    newPassword: passwordSchema
  })
  .strict();

/** Active-session metadata deliberately exposes friendly device labels for account control. */
export const accountSessionsSchema = z
  .object({
    sessions: z.array(z.object({
      id: z.string().min(1),
      createdAt: z.string().datetime(),
      lastUsedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      userAgent: z.string(),
      deviceName: z.string().min(1),
      deviceType: z.string().min(1),
      isCurrent: z.boolean()
    }).strict())
  })
  .strict();

export const apiErrorPayloadSchema = z
  .object({
    message: z.string().optional(),
    error: z.string().optional(),
    code: z.string().optional()
  })
  .passthrough();

export type BrowserSession = z.infer<typeof browserSessionSchema>;
export type BrowserSessionUser = z.infer<typeof browserSessionUserSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type BrowserAuthenticationCapabilities = z.infer<typeof browserAuthenticationCapabilitiesSchema>;
export type RegisterInput = z.infer<typeof registerInputSchema>;
export type EmailActionInput = z.infer<typeof emailActionInputSchema>;
export type VerificationInput = z.infer<typeof verificationInputSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type AccountSessions = z.infer<typeof accountSessionsSchema>;
