import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { listenerHomeQuery } from '../../api/listener';
import { browserSessionQuery } from '../../api/session';
import { PageSection } from '../../components/PageSection';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import { useSearchQuery } from '../search/SearchQueryProvider';
import { useSearchHistoryRecorder } from '../search/useSearchHistoryRecorder';
import styles from '../../styles/Pages.module.css';

const moods = [
  { title: 'Quiet focus', meta: 'Space between every note', query: 'ambient' },
  { title: 'After dark', meta: 'Low light, deep color', query: 'night' },
  { title: 'Slow mornings', meta: 'A softer way to begin', query: 'morning' }
];

const MoodFallback = () => {
  const { cancelPendingPreview } = useSearchQuery();
  const { recordSubmittedQuery } = useSearchHistoryRecorder();

  return (
    <section className={styles.section} aria-labelledby="moods-title">
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Listening moods</p>
          <h2 className={styles.sectionTitle} id="moods-title">Begin with a feeling</h2>
        </div>
        <p className={styles.sectionHint}>Explore the public catalog</p>
      </div>
      <div className={styles.cardGrid}>
        {moods.map((mood) => (
          <Link
            className={styles.moodCard}
            key={mood.title}
            onClick={() => {
              cancelPendingPreview();
              recordSubmittedQuery(mood.query);
            }}
            state={null}
            to={`/search?q=${encodeURIComponent(mood.query)}`}
          >
            <p className={styles.cardTitle}>{mood.title}</p>
            <p className={styles.cardMeta}>{mood.meta}</p>
          </Link>
        ))}
      </div>
    </section>
  );
};

/** Renders the configured listener Home while retaining a useful public fallback. */
export const HomePage = () => {
  const session = useQuery(browserSessionQuery());
  const viewerId = session.data?.user.id;
  const home = useQuery(listenerHomeQuery(viewerId));
  const homeTitle = home.data?.title.trim() || 'Made for your moment';
  const hasConfiguredSections = home.isSuccess && home.data.sections.length > 0;

  return (
    <div className={styles.page}>
      <header className={`${styles.homeHeader} ${hasConfiguredSections ? styles.homeHeaderReady : ''}`}>
        <p className={styles.eyebrow}>Finitude</p>
        <h1 className={styles.pageTitle} id="home-title">{homeTitle}</h1>
      </header>

      {home.isPending ? (
        <section className={styles.panel} aria-busy="true" aria-label="Loading Home">
          <div>
            <p className={styles.eyebrow}>Curating your room</p>
            <h2 className={styles.panelTitle}>Gathering music…</h2>
          </div>
        </section>
      ) : home.isError ? (
        <section className={styles.panel} aria-live="polite">
          <div>
            <h2 className={styles.panelTitle}>Home is taking a quiet moment</h2>
            <p className={styles.panelCopy}>The catalog could not be loaded, but Search is still available.</p>
            <div className={`${styles.actions} ${styles.panelActions}`}>
              <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => home.refetch()} type="button">Try again</button>
            </div>
          </div>
        </section>
      ) : home.data.sections.length > 0 ? (
        <div className={`${styles.sectionStack} ${styles.sectionStackReady}`} aria-label={home.data.title || 'Home collections'}>
          {home.data.sections.map((section) => (
            <PageSection
              {...section}
              key={section.id}
              onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }}
            />
          ))}
        </div>
      ) : (
        <MoodFallback />
      )}
    </div>
  );
};
