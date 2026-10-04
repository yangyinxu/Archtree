import type { CSSProperties } from 'react';
import type { SocialCard } from '../../api/social';
import styles from './SocialPage.module.css';

/** FNV-1a keeps a seed's hue identical across sessions and devices without storing a color anywhere. */
export const socialIconHue = (seed: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 0x01000193);
  return (hash >>> 0) % 360;
};

/** The first user-perceived character, so a flag or a letter with a combining mark is never cut in half. */
export const socialInitial = (alias: string) => {
  const first: string | undefined = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter().segment(alias)[Symbol.iterator]().next().value?.segment : [...alias][0];
  return (first ?? '·').toLocaleUpperCase();
};

/**
 * A social identity's generated icon: the nickname's first character on a color derived from the generated-icon
 * seed. Social cards carry no image, so a private account avatar can never appear here, and the seed's color keeps
 * two people with the same initial apart. Decorative, because the nickname is always shown beside it. A missing card
 * (a blocked profile) keeps the neutral placeholder.
 */
export const SocialAvatar = ({ profile }: { profile: Pick<SocialCard, 'alias' | 'iconSeed'> | null }) => <span aria-hidden="true"
  className={profile ? `${styles.avatar} ${styles.generatedAvatar}` : styles.avatar}
  style={profile ? { '--avatar-hue': socialIconHue(profile.iconSeed) } as CSSProperties : undefined}>{profile ? socialInitial(profile.alias) : '·'}</span>;
