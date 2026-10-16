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

const passwordSchema = z.string().min(12).max(256);

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
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type AccountSessions = z.infer<typeof accountSessionsSchema>;
