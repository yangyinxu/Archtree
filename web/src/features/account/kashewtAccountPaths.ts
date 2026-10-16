/**
 * Kashewt account pages served by the backend outside this app. Sign-up,
 * emailed links and password recovery belong to the shared Kashewt account,
 * so the app opens them as full-page links, never as client-side routes
 * (they sit outside the `/finitude` router basename).
 */
export const kashewtAccountPaths = {
  register: '/account/register',
  verifyEmail: '/account/verify-email',
  forgotPassword: '/account/forgot-password'
} as const;
