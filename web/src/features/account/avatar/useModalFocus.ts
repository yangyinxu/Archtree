import { useEffect, useRef, type RefObject } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/** Focuses, traps, and restores one modal interaction without changing its visual state. */
export const useModalFocus = (
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  restoreFocusRef?: RefObject<HTMLElement | null>,
  fallbackFocusRef?: RefObject<HTMLElement | null>
) => {
  const capturedFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    capturedFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    // File pickers can restore focus after React mounts the editor, so focus on the next task.
    const focusTimer = window.setTimeout(() => initialFocusRef.current?.focus(), 0);

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !containerRef.current) return;
      const focusable = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(focusableSelector)
      );
      if (!focusable.length) {
        event.preventDefault();
        containerRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIsFocusable = focusable.includes(document.activeElement as HTMLElement);
      if (!activeIsFocusable) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', trapFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', trapFocus);
      const requested = restoreFocusRef?.current;
      const fallback = fallbackFocusRef?.current;
      const captured = capturedFocusRef.current;
      const canFocus = (element: HTMLElement | null | undefined) => Boolean(
        element?.isConnected
        && !(element instanceof HTMLButtonElement && element.disabled)
        && !(element instanceof HTMLInputElement && element.disabled)
      );
      const target = canFocus(requested)
        ? requested
        : canFocus(fallback)
          ? fallback
          : canFocus(captured)
            ? captured
            : null;
      target?.focus();
    };
  }, [containerRef, fallbackFocusRef, initialFocusRef, restoreFocusRef]);
};
