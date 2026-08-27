import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';

import { ApiError } from '../api/client';
import {
  type AudioTrackSummary,
  type HomeSection
} from '../api/contentSchemas';
import {
  collectionPageSummaries,
  type ListenerPageSlug
} from '../api/collectionSchemas';
import {
  getListenerCollectionPage,
  listenerCollectionQueryKey,
  type ListenerCollectionContinuation
} from '../api/listenerCollections';
import { useLocalization } from '../localization/LocalizationProvider';
import { PageSection } from './PageSection';
import styles from './PageSection.module.css';

const restartableCursorCodes = new Set([
  'collection_cursor_mismatch',
  'invalid_collection_cursor',
  'stale_collection_cursor'
]);

const isRestartableCursorError = (error: unknown) => error instanceof ApiError
  && restartableCursorCodes.has(error.code ?? '');

export interface PaginatedPageSectionProps {
  section: HomeSection;
  pageSlug: ListenerPageSlug;
  viewerKey?: string | null;
  onPlay?: (audioTrack: AudioTrackSummary) => void;
}

interface CollectionPageParam {
  cursor?: string;
  continuation?: ListenerCollectionContinuation;
}

/** Loads a Grid/List independently so large collections never bloat the parent page. */
export const PaginatedPageSection = ({
  section,
  pageSlug,
  viewerKey,
  onPlay
}: PaginatedPageSectionProps) => {
  const { t } = useLocalization();
  const [restartGeneration, setRestartGeneration] = useState(0);
  const collection = useInfiniteQuery({
    queryKey: [
      ...listenerCollectionQueryKey(pageSlug, section.id, viewerKey),
      restartGeneration
    ],
    queryFn: ({ pageParam, signal }) => getListenerCollectionPage(
      pageSlug,
      section.id,
      viewerKey,
      {
        limit: 20,
        cursor: pageParam.cursor,
        continuation: pageParam.continuation
      },
      signal
    ),
    initialPageParam: {} as CollectionPageParam,
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      if (!lastPage.nextCursor) return undefined;
      const afterOrder = allPages.flatMap((page) => page.items).at(-1)?.order;
      return {
        cursor: lastPage.nextCursor,
        continuation: {
          pageItem: allPages[0].pageItem,
          afterOrder,
          usedCursors: [
            ...(lastPageParam.continuation?.usedCursors ?? []),
            lastPage.nextCursor
          ]
        }
      } satisfies CollectionPageParam;
    },
    enabled: pageSlug === 'home' || Boolean(viewerKey),
    retry: (failureCount, error) => failureCount < 1
      && !isRestartableCursorError(error)
      && !(error instanceof ApiError && error.kind === 'http' && (error.status ?? 500) < 500)
  });

  const items = useMemo(() => (
    collection.data?.pages.flatMap(collectionPageSummaries) ?? []
  ), [collection.data]);
  const firstPage = collection.data?.pages[0];
  const title = firstPage?.pageItem.title || section.title;
  const presentation = firstPage?.pageItem.presentation || section.presentation;
  const deviceLocalOnly = collection.error instanceof ApiError
    && collection.error.code === 'collection_source_not_server_backed';
  const paginationError = collection.isFetchNextPageError && !deviceLocalOnly
    ? collection.error
    : null;
  const restartRequired = isRestartableCursorError(paginationError);

  const initialState = collection.isPending ? (
    <p className={styles.collectionState} aria-busy="true">
      {t('home.loading.title')}
    </p>
  ) : collection.isError && !collection.data && !deviceLocalOnly ? (
    <div className={styles.collectionState} role="alert">
      <p>{t('home.error.copy')}</p>
      <button onClick={() => collection.refetch()} type="button">
        {t('common.action.try_again')}
      </button>
    </div>
  ) : undefined;

  const footer = collection.data && !deviceLocalOnly
    && (collection.hasNextPage || paginationError) ? (
    <div className={styles.pagination}>
      {paginationError && (
        <p className={styles.paginationError} role="alert">
          {t('home.error.copy')}
        </p>
      )}
      <button
        disabled={collection.isFetchingNextPage}
        onClick={() => {
          if (restartRequired) {
            setRestartGeneration((current) => current + 1);
            return;
          }
          void collection.fetchNextPage();
        }}
        type="button"
      >
        {collection.isFetchingNextPage
          ? t('common.state.loading_more')
          : restartRequired
            ? t('common.action.retry')
            : t('common.action.load_more')}
      </button>
    </div>
  ) : undefined;

  if (initialState) {
    const headingId = `listener-section-${section.id}`;
    return (
      <section className={styles.section} aria-labelledby={headingId}>
        <h2 className={styles.title} id={headingId}>{title}</h2>
        {initialState}
      </section>
    );
  }

  return (
    <div>
      <PageSection
        id={section.id}
        items={deviceLocalOnly ? [] : items}
        onPlay={onPlay}
        presentation={presentation}
        title={title}
      />
      {footer}
    </div>
  );
};
