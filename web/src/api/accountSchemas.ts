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
/** Emailed link tokens are 32 random bytes in base64url, read only from the URL fragment. */
export const emailLinkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const emailActionInputSchema = z
  .object({
    email: emailSchema
  })
  .strict();

export const resetPasswordInputSchema = z
  .object({
    email: emailSchema,
    code: z.string().trim().regex(/^\d{6}$/),
    password: passwordSchema
  })
  .strict();

export const emailLinkTokenInputSchema = z
  .object({
    token: emailLinkTokenSchema
  })
  .strict();

/** Mirrors the server rule: 1 to 80 characters after trimming, without control characters. */
export const registrationDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\u0000-\u001f\u007f]*$/);

export const completeRegistrationInputSchema = z
  .object({
    token: emailLinkTokenSchema,
    password: passwordSchema,
    displayName: registrationDisplayNameSchema
  })
  .strict();

/** The only data a link inspection or completion may reveal is the address the link was mailed to. */
export const emailLinkAddressSchema = z
  .object({
    email: z.string().email()
  })
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
export type EmailActionInput = z.infer<typeof emailActionInputSchema>;
export type EmailLinkTokenInput = z.infer<typeof emailLinkTokenInputSchema>;
export type CompleteRegistrationInput = z.infer<typeof completeRegistrationInputSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type AccountSessions = z.infer<typeof accountSessionsSchema>;
