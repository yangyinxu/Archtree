import { Link } from 'react-router';
import { useSearchQuery } from '../search/SearchQueryProvider';
import { useSearchHistoryRecorder } from '../search/useSearchHistoryRecorder';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import styles from '../../styles/Pages.module.css';

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

export default MoodFallback;
