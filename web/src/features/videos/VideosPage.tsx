import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { getListenerVideos, listenerVideosQueryKey } from '../../api/listenerVideos';
import { browserSessionQuery } from '../../api/session';
// The Grid reuses PageSection, not ContentCard alone, so the shared card chunk is not split for this route.
import { PageSection } from '../../components/PageSection';
import { useLocalization } from '../../localization/LocalizationProvider';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import pageStyles from '../../styles/Pages.module.css';
import styles from './VideosPage.module.css';

/** Lists every public Video newest first as a 16:9 card Grid, loading further pages on request. */
export const VideosPage = () => {
  const { t } = useLocalization();
  const viewerId = useQuery(browserSessionQuery()).data?.user.id;
  const videos = useInfiniteQuery({
    queryKey: listenerVideosQueryKey,
    queryFn: ({ pageParam, signal }) => getListenerVideos(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
  });
  const title = t('common.label.video');

  return (
    <div className={`${pageStyles.page} ${styles.page}`}>
      {/* Like Home, the visible heading belongs to the Grid once it renders. */}
      <header className={`${pageStyles.homeHeader} ${videos.data ? pageStyles.homeHeaderReady : ''}`}>
        <h1 className={pageStyles.pageTitle}>{title}</h1>
      </header>

      {videos.isPending ? (
        <section className={pageStyles.panel} aria-busy="true">
          <p className={pageStyles.panelTitle}>{t('home.loading.title')}</p>
        </section>
      ) : videos.isError && !videos.data ? (
        <section className={pageStyles.panel} role="alert">
          <div>
            <p className={pageStyles.panelCopy}>{t('home.error.copy')}</p>
            <div className={`${pageStyles.actions} ${pageStyles.panelActions}`}>
              <button className={`${pageStyles.button} ${pageStyles.buttonSecondary}`} onClick={() => { void videos.refetch(); }} type="button">
                {t('common.action.try_again')}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          {videos.isRefetchError && (
            <section className={pageStyles.panel} role="alert">
              <p className={pageStyles.panelCopy}>{t('home.error.copy')}</p>
              <button className={`${pageStyles.button} ${pageStyles.buttonSecondary}`} onClick={() => { void videos.refetch(); }} type="button">
                {t('common.action.try_again')}
              </button>
            </section>
          )}
          <PageSection
            cardFrame="wide"
            id="videos"
            items={videos.data.pages.flatMap((page) => page.items)}
            onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }}
            presentation="grid"
            title={title}
          />
          {(videos.hasNextPage || videos.isFetchNextPageError) && (
            <div className={styles.pagination}>
              {videos.isFetchNextPageError && <p role="alert">{t('home.error.copy')}</p>}
              <button
                className={`${pageStyles.button} ${pageStyles.buttonSecondary}`}
                disabled={videos.isFetchingNextPage}
                onClick={() => { void videos.fetchNextPage(); }}
                type="button"
              >
                {videos.isFetchingNextPage ? t('common.state.loading_more') : t('common.action.load_more')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
