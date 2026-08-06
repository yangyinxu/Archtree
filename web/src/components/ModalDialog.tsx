import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

import styles from './ModalDialog.module.css';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export interface ModalDialogProps {
  children: ReactNode;
  title: string;
  kicker?: string;
  description?: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  closeDisabled?: boolean;
  wide?: boolean;
}

/** Provides one focus-trapped, Escape-aware modal boundary for listener workflows. */
export const ModalDialog = ({
  children,
  title,
  kicker,
  description,
  initialFocusRef,
  returnFocusRef,
  onClose,
  closeDisabled = false,
  wide = false
}: ModalDialogProps) => {
  const dialogRef = useRef<HTMLElement>(null);
  const capturedFocusRef = useRef<HTMLElement | null>(null);
  const closeDisabledRef = useRef(closeDisabled);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  // Pending-state renders must not tear down the focus trap or return focus
  // behind the overlay. The document listener reads the current values.
  closeDisabledRef.current = closeDisabled;
  onCloseRef.current = onClose;

  useEffect(() => {
    capturedFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => {
      (initialFocusRef.current ?? dialogRef.current)?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!closeDisabledRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!focusable.includes(active as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      const target = returnFocusRef?.current?.isConnected
        ? returnFocusRef.current
        : capturedFocusRef.current?.isConnected
          ? capturedFocusRef.current
          : null;
      target?.focus();
    };
  }, [initialFocusRef, returnFocusRef]);

  useEffect(() => {
    if (!closeDisabled) return;
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      const active = document.activeElement;
      if (!dialog) return;
      const activeDisabled = active instanceof HTMLElement
        && active.matches('button:disabled, input:disabled, select:disabled, textarea:disabled');
      if (!dialog.contains(active) || activeDisabled) dialog.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [closeDisabled]);

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closeDisabled) onClose();
      }}
      role="presentation"
    >
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`${styles.dialog} ${wide ? styles.wide : ''}`}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div>
            {kicker && <p className={styles.kicker}>{kicker}</p>}
            <h2 id={titleId}>{title}</h2>
            {description && <p className={styles.description} id={descriptionId}>{description}</p>}
          </div>
        </header>
        {children}
      </section>
    </div>
  );
};
