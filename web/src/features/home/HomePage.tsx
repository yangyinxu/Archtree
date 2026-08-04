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
  { title: 'Quiet focus', meta: 'Space between every note', query: 'ambient', art: styles.moodArtMint },
  { title: 'After dark', meta: 'Low light, deep color', query: 'night', art: styles.moodArtViolet },
  { title: 'Slow mornings', meta: 'A softer way to begin', query: 'morning', art: styles.moodArtWarm }
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
            <div className={`${styles.moodArt} ${mood.art}`} aria-hidden="true" />
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

  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="home-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Finitude on the web</p>
          <h1 className={styles.title} id="home-title">Leave room for the music.</h1>
          <p className={styles.lede}>
            Find albums and soundtracks for the pace you are in—then keep listening as you move through Finitude.
          </p>
          <div className={styles.actions}>
            <Link className={styles.primaryLink} to="/search">Explore music</Link>
            <Link className={styles.secondaryLink} to={viewerId ? '/library' : '/login'}>
              {viewerId ? 'Open Library' : 'Log in'}
            </Link>
          </div>
        </div>
        <div className={styles.heroArt} aria-hidden="true" />
      </section>

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
            <div className={styles.actions}>
              <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => home.refetch()} type="button">Try again</button>
            </div>
          </div>
        </section>
      ) : home.data.sections.length > 0 ? (
        <div className={styles.sectionStack} aria-label={home.data.title || 'Home collections'}>
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
