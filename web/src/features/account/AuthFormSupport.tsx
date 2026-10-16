import { useEffect, useRef } from 'react';

import styles from './AccountSurfaces.module.css';

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
