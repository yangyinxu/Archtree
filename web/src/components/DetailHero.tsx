import type { CSSProperties, ReactNode, RefObject } from 'react';

import { neutralArtworkTone } from '../artwork/useArtworkTone';
import { hasWideCharacters, useFittedHeroTitle } from './useFittedHeroTitle';
import h from './DetailHero.module.css';

interface DetailHeroProps {
  /** Observed by CompactCatalogHeader, which appears once this header scrolls under it. */
  heroRef: RefObject<HTMLElement | null>;
  /** The artwork's hero tone, which keeps the white eyebrow, title and byline at AA contrast. */
  tone: string;
  eyebrow: string;
  title: string;
  /** The cover, rendered by the page with `h.artwork` from DetailHero.module.css. */
  artwork: ReactNode;
  byline: ReactNode;
  /** The action bar: one prominent Play first, then the page's icon actions. */
  actions: ReactNode;
}

/**
 * Shared Album and Playlist detail header: the full-bleed hero on the artwork tone (cover, type
 * label, fitted title and byline), then the action bar, whose band carries the tone down behind
 * the MediaTrack table's column header. The action bar stays inside `<header>`, where the hero
 * Play is found.
 */
export const DetailHero = ({ heroRef, tone, eyebrow, title, artwork, byline, actions }: DetailHeroProps) => {
  const fit = useFittedHeroTitle(title);
  return (
    <header className={h.header} ref={heroRef} style={{ '--tone-color': tone } as CSSProperties}>
      <div className={h.hero}>
        {artwork}
        <div className={h.copy}>
          <p className={h.eyebrow}>{eyebrow}</p>
          <h1
            className={h.title}
            data-title-size={fit.initialSize}
            data-title-wide={hasWideCharacters(title) || undefined}
            ref={fit.ref}
            title={title}
          >{title}</h1>
          <p className={h.byline}>{byline}</p>
        </div>
      </div>
      <div className={h.actionBar}>{actions}</div>
    </header>
  );
};

/** Neutral placeholder with the detail header's geometry, shown while the page's data loads. */
export const DetailHeroSkeleton = ({ label }: { label: string }) => (
  <div aria-busy="true" className={h.page}>
    <p className="visually-hidden">{label}</p>
    <header className={h.header} style={{ '--tone-color': neutralArtworkTone.hero } as CSSProperties}>
      <div className={h.hero}>
        <div className={h.skeletonArtwork} />
        <div className={h.copy}>
          <div className={h.skeletonLine} style={{ height: '3rem', width: 'min(28rem, 80%)' }} />
          <div className={h.skeletonLine} style={{ height: '0.875rem', width: '12rem' }} />
        </div>
      </div>
      <div className={h.actionBar} />
    </header>
  </div>
);
