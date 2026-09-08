import { z } from 'zod';

/** Account-route validators stay outside the persistent browser-session module. */
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

export type BrowserAuthenticationCapabilities = z.infer<typeof browserAuthenticationCapabilitiesSchema>;
export type RegisterInput = z.infer<typeof registerInputSchema>;
export type EmailActionInput = z.infer<typeof emailActionInputSchema>;
export type VerificationInput = z.infer<typeof verificationInputSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type AccountSessions = z.infer<typeof accountSessionsSchema>;
