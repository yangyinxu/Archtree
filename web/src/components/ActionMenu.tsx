import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';

import styles from './ActionMenu.module.css';

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Modal-opening actions transfer focus; other actions restore the row trigger. */
  restoreFocus?: boolean;
}

export interface ActionMenuProps {
  label: string;
  items: ActionMenuItem[];
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/** Keeps trailing row actions separate, keyboard-navigable, and focus-restoring. */
export const ActionMenu = ({ label, items, triggerRef }: ActionMenuProps) => {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const localTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const resolvedTriggerRef = triggerRef ?? localTriggerRef;
  const portalHost = wrapperRef.current?.closest<HTMLElement>(
    'main, aside, nav, header, footer, section[aria-label], [role="dialog"], [role="region"]'
  ) ?? (typeof document === 'undefined' ? null : document.body);

  const enabledButtons = () => Array.from(
    menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
  );

  const focusItem = (position: 'first' | 'last') => {
    window.setTimeout(() => {
      const buttons = enabledButtons();
      (position === 'first' ? buttons[0] : buttons[buttons.length - 1])?.focus();
    }, 0);
  };

  const close = (restoreFocus = true) => {
    setOpen(false);
    setMenuPosition(null);
    if (restoreFocus) window.setTimeout(() => resolvedTriggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!wrapperRef.current?.contains(target) && !menuRef.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = resolvedTriggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const edge = 8;
      const gap = 4;
      const left = Math.min(
        Math.max(edge, triggerRect.right - menuRect.width),
        Math.max(edge, window.innerWidth - menuRect.width - edge)
      );
      const fitsBelow = triggerRect.bottom + gap + menuRect.height <= window.innerHeight - edge;
      const top = fitsBelow
        ? triggerRect.bottom + gap
        : Math.max(edge, triggerRect.top - gap - menuRect.height);
      setMenuPosition({ left, top });
    };
    positionMenu();
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [open, resolvedTriggerRef]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = enabledButtons();
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[(currentIndex + 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(currentIndex - 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <span className={styles.wrapper} ref={wrapperRef}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={styles.trigger}
        onClick={() => {
          setOpen((current) => {
            if (!current) focusItem('first');
            return !current;
          });
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) setOpen(true);
            focusItem(event.key === 'ArrowDown' ? 'first' : 'last');
          }
        }}
        ref={resolvedTriggerRef}
        type="button"
      >
        <Ellipsis aria-hidden="true" focusable="false" />
      </button>
      {open && portalHost && createPortal(
        <div
          aria-label={label}
          className={styles.menu}
          id={menuId}
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
          role="menu"
          style={menuPosition
            ? { left: menuPosition.left, top: menuPosition.top }
            : { visibility: 'hidden' }}
        >
          {items.map((item) => (
            <button
              className={item.destructive ? styles.destructive : undefined}
              disabled={item.disabled}
              key={item.label}
              onClick={() => {
                close(item.restoreFocus !== false);
                item.onSelect();
              }}
              role="menuitem"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>,
        portalHost
      )}
    </span>
  );
};
