import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';

import { listenerHomeQuery } from '../../api/listener';
import {
  browserSessionQuery,
  browserSessionResolvingQuery
} from '../../api/session';
import { PageSection } from '../../components/PageSection';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import styles from '../../styles/Pages.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

const MoodFallback = lazy(() => import('./HomeMoodFallback'));
const PaginatedPageSection = lazy(() => import('../../components/PaginatedPageSection')
  .then((module) => ({ default: module.PaginatedPageSection })));

/** Renders the configured listener Home while retaining a useful public fallback. */
export const HomePage = () => {
  const { t } = useLocalization();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  const viewerId = session.data?.user.id;
  const home = useQuery({
    ...listenerHomeQuery(viewerId),
    enabled: session.isSuccess && !resolving.data
  });
  const homeTitle = home.data?.title.trim() || t('home.default_title');
  // Anonymous requests never render a cached private explanation.
  const sections = home.data?.sections.filter((section) => viewerId || !section.items.some((item) => item.reason)) ?? [];
  const hasConfiguredSections = sections.length > 0;

  return (
    <div className={styles.page}>
      <header className={`${styles.homeHeader} ${hasConfiguredSections ? styles.homeHeaderReady : ''}`}>
        <p className={styles.eyebrow}>Finitude</p>
        <h1 className={styles.pageTitle} id="home-title">{homeTitle}</h1>
      </header>

      {resolving.data || session.isPending || home.isPending ? (
        <section className={styles.panel} aria-busy="true" aria-label={t('home.loading.label')}>
          <div>
            <p className={styles.eyebrow}>{t('home.loading.eyebrow')}</p>
            <h2 className={styles.panelTitle}>{t('home.loading.title')}</h2>
          </div>
        </section>
      ) : session.isError || home.isError && !home.data ? (
        <section className={styles.panel} aria-live="polite">
          <div>
            <h2 className={styles.panelTitle}>{t('home.error.title')}</h2>
            <p className={styles.panelCopy}>{t('home.error.copy')}</p>
            <div className={`${styles.actions} ${styles.panelActions}`}>
              <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => home.refetch()} type="button">{t('common.action.try_again')}</button>
            </div>
          </div>
        </section>
      ) : sections.length > 0 ? (
        <div className={`${styles.sectionStack} ${styles.sectionStackReady}`} aria-label={home.data?.title || t('home.collections.label')}>
          {home.isError && <p role="alert">{t('home.error.copy')} <button type="button" onClick={() => { void home.refetch(); }}>{t('common.action.try_again')}</button></p>}
          {sections.map((section) => (
            section.presentation === 'carousel' ? (
              <PageSection
                {...section}
                key={section.id}
                onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }}
              />
            ) : (
              <Suspense key={section.id} fallback={<PageSection {...section} onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }} />}>
              <PaginatedPageSection
                onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }}
                pageSlug="home"
                section={section}
                viewerKey={viewerId}
              />
              </Suspense>
            )
          ))}
        </div>
      ) : (
        <Suspense fallback={<p aria-busy="true">{t('home.loading.label')}</p>}><MoodFallback /></Suspense>
      )}
    </div>
  );
};
