import { Icon } from './Icon';
import styles from './Avatar.module.css';

const initialsFor = (displayName: string, email: string) => {
  const source = displayName.trim() || email.trim();
  if (!source) return '';
  const words = source.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase();
};

/** Uses deterministic identity text while private avatar delivery is unavailable. */
export const Avatar = ({ displayName = '', email = '' }: { displayName?: string; email?: string }) => {
  const initials = initialsFor(displayName, email);
  return (
    <span className={styles.avatar} aria-hidden="true">
      {initials || <Icon name="account" />}
    </span>
  );
};
