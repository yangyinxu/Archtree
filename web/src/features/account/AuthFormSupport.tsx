import { useEffect, useRef, type ReactNode, type Ref } from 'react';

import styles from './AccountSurfaces.module.css';

interface AuthPageFrameProps {
  eyebrow: string;
  title: string;
  description?: string;
  /** Lets multi-state pages move focus to the heading when the page's state replaces its content. */
  titleRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
}

/** Keeps public account forms visually and semantically consistent. */
export const AuthPageFrame = ({ eyebrow, title, description, titleRef, children }: AuthPageFrameProps) => (
  <div className={styles.page}>
    <div className={styles.authLayout}>
      <div>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1 className={styles.pageTitle} ref={titleRef} tabIndex={titleRef ? -1 : undefined}>{title}</h1>
        {description && <p className={styles.lede}>{description}</p>}
      </div>
      {children}
    </div>
  </div>
);

/**
 * Moves focus to a page heading when an asynchronous state change replaces the
 * focused content (for example a link check finishing or a form giving way to
 * an invalid-link notice). The first state is left alone so the route's own
 * focus handling applies.
 */
export const useFocusOnStateChange = (stateKey: string, enabled = true) => {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previous = useRef(stateKey);

  useEffect(() => {
    if (previous.current === stateKey) return;
    previous.current = stateKey;
    if (enabled) titleRef.current?.focus();
  }, [enabled, stateKey]);

  return titleRef;
};

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
export const privateAccountActionError = (_error: unknown, localizedFallback: string) => localizedFallback;

/** Verification errors are safe to surface because they do not confirm account existence. */
export const verificationActionError = (_error: unknown, localizedFallback: string) => localizedFallback;

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
