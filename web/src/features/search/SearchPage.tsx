import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { listenerSearchQuery } from '../../api/listener';
import { ContentCard } from '../../components/ContentCard';
import { Icon } from '../../components/Icon';
import { PageSection } from '../../components/PageSection';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import { LazyAddTrackToPlaylistButton } from '../playlists/LazyAddTrackToPlaylistButton';
import {
  clearSearchHistory,
  readSearchHistory,
  searchHistoryChangedEvent
} from './searchHistory';
import { useSearchQuery } from './SearchQueryProvider';
import { useSearchHistoryRecorder } from './useSearchHistoryRecorder';
import styles from '../../styles/Pages.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';

const suggestions: Array<{ query: string; labelKey: MessageKey }> = [
  { query: 'Ambient', labelKey: 'search.suggestion.ambient' },
  { query: 'Piano', labelKey: 'search.suggestion.piano' },
  { query: 'MediaTracks', labelKey: 'search.suggestion.mediatracks' },
  { query: 'Evening', labelKey: 'search.suggestion.evening' },
  { query: 'Acoustic', labelKey: 'search.suggestion.acoustic' }
];

/** Provides grouped, cancellable public Search with account-scoped local history. */
export const SearchPage = () => {
  const { t } = useLocalization();
  const {
    historyIsReady,
    recordSubmittedQuery,
    viewerId
  } = useSearchHistoryRecorder();
  const {
    activeQuery,
    cancelPendingPreview,
    commitDraft,
    draftQuery,
    finishComposition,
    isComposing,
    isPreview,
    startComposition,
    updateDraft
  } = useSearchQuery();
  const [history, setHistory] = useState<string[]>([]);
  const results = useQuery(listenerSearchQuery(activeQuery));

  useEffect(() => {
    if (!historyIsReady) {
      setHistory([]);
      return;
    }
    const refreshHistory = () => setHistory(readSearchHistory(viewerId));
    refreshHistory();
    window.addEventListener(searchHistoryChangedEvent, refreshHistory);
    return () => window.removeEventListener(searchHistoryChangedEvent, refreshHistory);
  }, [historyIsReady, viewerId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isComposing) return;
    const normalized = commitDraft();
    if (normalized) recordSubmittedQuery(normalized);
  };

  /** Prevents an IME candidate-confirmation Enter from becoming a form submit. */
  const submitFromInput = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  };

  const hasResults = Boolean(results.data && (
    results.data.artists.length
    || results.data.organizations.length
    || results.data.albums.length
    || results.data.audioTracks.length
  ));

  return (
    <div className={styles.page}>
      <p className={styles.eyebrow}>{t('search.eyebrow')}</p>
      <h1 className={styles.pageTitle}>{t('search.title')}</h1>
      <p className={styles.lede}>{t('search.lede')}</p>

      <form className={styles.searchForm} role="search" aria-label={t('search.form.label')} onSubmit={submit}>
        <Icon name="search" />
        <label className="visually-hidden" htmlFor="page-search">{t('search.field.label')}</label>
        <input
          enterKeyHint="search"
          id="page-search"
          onChange={(event) => updateDraft(event.currentTarget.value)}
          onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
          onCompositionStart={startComposition}
          onKeyDown={submitFromInput}
          placeholder={t('search.field.placeholder')}
          type="search"
          value={draftQuery}
        />
      </form>

      {activeQuery ? (
        <section className={styles.searchResults} aria-labelledby="results-title" aria-busy={results.isPending}>
          <h2 className={styles.sectionTitle} id="results-title">
            {t('search.results.title', { query: activeQuery })}
          </h2>
          {results.isPending ? (
            <div className={styles.compactState}>{t('search.searching')}</div>
          ) : results.isError ? (
            <div className={styles.compactState} role="alert">
              <p>{t('search.error')}</p>
              <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => results.refetch()} type="button">{t('common.action.try_again')}</button>
            </div>
          ) : !hasResults ? (
            <div className={styles.compactState}>
              <p>{t('search.no_results')}</p>
            </div>
          ) : (
            <div className={styles.resultGroups}>
              {results.data.artists.length > 0 && (
                <section aria-labelledby="artist-results-title">
                  <h3 className={styles.resultHeading} id="artist-results-title">{t('common.label.artists')}</h3>
                  <ul className={styles.resultGrid}>
                    {results.data.artists.map((artist) => (
                      <li key={artist.id}><ContentCard item={artist} /></li>
                    ))}
                  </ul>
                </section>
              )}
              {results.data.organizations.length > 0 && (
                <section aria-labelledby="organization-results-title">
                  <h3 className={styles.resultHeading} id="organization-results-title">{t('common.label.organizations')}</h3>
                  <ul className={styles.resultGrid}>
                    {results.data.organizations.map((organization) => (
                      <li key={organization.id}>
                        <Link
                          aria-label={t('search.organization.label', {
                            name: organization.name || t('content.title.unknown_organization')
                          })}
                          className={styles.organizationResult}
                          to={`/organizations/${encodeURIComponent(organization.id)}`}
                        >
                          <strong>{organization.name || t('content.title.unknown_organization')}</strong>
                          <span>{organization.organizationType || t('common.label.organization')}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {results.data.albums.length > 0 && (
                <PageSection id="search-albums" items={results.data.albums} presentation="grid" title={t('common.label.albums')} />
              )}
              {results.data.audioTracks.length > 0 && (
                <PageSection
                  id="search-soundtracks"
                  items={results.data.audioTracks}
                  onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }}
                  presentation="list"
                  renderTrackTrailing={(track) => (
                    <LazyAddTrackToPlaylistButton
                      accountPending={!historyIsReady}
                      track={track}
                      viewerId={viewerId}
                    />
                  )}
                  title={t('common.label.mediatracks')}
                />
              )}
            </div>
          )}
        </section>
      ) : (
        <section className={styles.section} aria-labelledby="browse-title">
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle} id="browse-title">
              {history.length > 0 ? t('search.browse.recent_title') : t('search.browse.mood_title')}
            </h2>
            {history.length > 0 && (
              <button
                className={styles.textButton}
                onClick={() => {
                  clearSearchHistory(viewerId);
                  setHistory([]);
                }}
                type="button"
              >
                {t('common.action.clear')}
              </button>
            )}
          </div>
          <div className={styles.chipList}>
            {(history.length > 0
              ? history.map((query) => ({ query, label: query }))
              : suggestions.map(({ query, labelKey }) => ({ query, label: t(labelKey) })))
              .map((suggestion) => (
              <Link
                className={styles.chip}
                key={suggestion.query}
                onClick={() => {
                  cancelPendingPreview();
                  recordSubmittedQuery(suggestion.query);
                }}
                replace={isPreview}
                state={null}
                to={`?q=${encodeURIComponent(suggestion.query)}`}
              >
                {suggestion.label}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
