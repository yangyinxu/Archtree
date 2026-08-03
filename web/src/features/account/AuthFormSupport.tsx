import { useEffect, useRef, type ReactNode } from 'react';

import { ApiError } from '../../api/client';
import styles from '../../styles/Pages.module.css';

interface AuthPageFrameProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}

/** Keeps public account forms visually and semantically consistent. */
export const AuthPageFrame = ({ eyebrow, title, description, children }: AuthPageFrameProps) => (
  <div className={styles.page}>
    <div className={styles.authLayout}>
      <div>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1 className={styles.pageTitle}>{title}</h1>
        <p className={styles.lede}>{description}</p>
      </div>
      {children}
    </div>
  </div>
);

interface AuthFormFeedbackProps {
  error?: string;
  status?: string;
  focusKey?: number;
}

/** Announces async form outcomes and moves focus to actionable errors. */
export const AuthFormFeedback = ({ error, status, focusKey }: AuthFormFeedbackProps) => {
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error, focusKey]);

  return (
    <>
      {error && (
        <p className={styles.error} ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </p>
      )}
      {status && (
        <p className={styles.success} role="status" aria-live="polite" aria-atomic="true">
          {status}
        </p>
      )}
    </>
  );
};

/** Reduces unexpected server details to a stable account-safe failure message. */
export const privateAccountActionError = (error: unknown) => {
  if (error instanceof ApiError && error.kind === 'network') return error.message;
  return 'Finitude could not complete that request. Please try again.';
};

/** Verification errors are safe to surface because they do not confirm account existence. */
export const verificationActionError = (error: unknown) => error instanceof ApiError
  ? error.message
  : 'Finitude could not check that code. Please try again.';

export const emailFromRouteState = (state: unknown) => {
  if (!state || typeof state !== 'object' || !('email' in state)) return '';
  const value = (state as { email?: unknown }).email;
  return typeof value === 'string' ? value.trim().slice(0, 254) : '';
};

export const noticeFromRouteState = (state: unknown) => {
  if (!state || typeof state !== 'object' || !('notice' in state)) return '';
  const value = (state as { notice?: unknown }).notice;
  return typeof value === 'string' ? value.trim().slice(0, 240) : '';
};
