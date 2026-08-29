import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { listenerHomeQuery } from '../../api/listener';
import {
  browserSessionQuery,
  browserSessionResolvingQuery
} from '../../api/session';
import { PageSection } from '../../components/PageSection';
import { PaginatedPageSection } from '../../components/PaginatedPageSection';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import { useSearchQuery } from '../search/SearchQueryProvider';
import { useSearchHistoryRecorder } from '../search/useSearchHistoryRecorder';
import styles from '../../styles/Pages.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';

const moods: Array<{ titleKey: MessageKey; metaKey: MessageKey; query: string }> = [
  { titleKey: 'home.moods.quiet_focus.title', metaKey: 'home.moods.quiet_focus.meta', query: 'ambient' },
  { titleKey: 'home.moods.after_dark.title', metaKey: 'home.moods.after_dark.meta', query: 'night' },
  { titleKey: 'home.moods.slow_mornings.title', metaKey: 'home.moods.slow_mornings.meta', query: 'morning' }
];

const MoodFallback = () => {
  const { cancelPendingPreview } = useSearchQuery();
  const { recordSubmittedQuery } = useSearchHistoryRecorder();
  const { t } = useLocalization();

  return (
    <section className={styles.section} aria-labelledby="moods-title">
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>{t('home.moods.eyebrow')}</p>
          <h2 className={styles.sectionTitle} id="moods-title">{t('home.moods.title')}</h2>
        </div>
        <p className={styles.sectionHint}>{t('home.moods.hint')}</p>
      </div>
      <div className={styles.cardGrid}>
        {moods.map((mood) => (
          <Link
            className={styles.moodCard}
            key={mood.query}
            onClick={() => {
              cancelPendingPreview();
              recordSubmittedQuery(mood.query);
            }}
            state={null}
            to={`/search?q=${encodeURIComponent(mood.query)}`}
          >
            <p className={styles.cardTitle}>{t(mood.titleKey)}</p>
            <p className={styles.cardMeta}>{t(mood.metaKey)}</p>
          </Link>
        ))}
      </div>
    </section>
  );
};

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
  const hasConfiguredSections = home.isSuccess && home.data.sections.length > 0;

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
      ) : session.isError || home.isError ? (
        <section className={styles.panel} aria-live="polite">
          <div>
            <h2 className={styles.panelTitle}>{t('home.error.title')}</h2>
            <p className={styles.panelCopy}>{t('home.error.copy')}</p>
            <div className={`${styles.actions} ${styles.panelActions}`}>
              <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => home.refetch()} type="button">{t('common.action.try_again')}</button>
            </div>
          </div>
        </section>
      ) : home.data.sections.length > 0 ? (
        <div className={`${styles.sectionStack} ${styles.sectionStackReady}`} aria-label={home.data.title || t('home.collections.label')}>
          {home.data.sections.map((section) => (
            section.presentation === 'carousel' ? (
              <PageSection
                {...section}
                key={section.id}
                onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }}
              />
            ) : (
              <PaginatedPageSection
                key={section.id}
                onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }}
                pageSlug="home"
                section={section}
                viewerKey={viewerId}
              />
            )
          ))}
        </div>
      ) : (
        <MoodFallback />
      )}
    </div>
  );
};
