import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { listenerSearchQuery } from '../../api/listener';
import { ContentCard } from '../../components/ContentCard';
import { Icon } from '../../components/Icon';
import { PageSection } from '../../components/PageSection';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import {
  clearSearchHistory,
  readSearchHistory,
  searchHistoryChangedEvent
} from './searchHistory';
import { useSearchQuery } from './SearchQueryProvider';
import { useSearchHistoryRecorder } from './useSearchHistoryRecorder';
import styles from '../../styles/Pages.module.css';

const suggestions = ['Ambient', 'Piano', 'Soundtracks', 'Evening', 'Acoustic'];

/** Provides grouped, cancellable public Search with account-scoped local history. */
export const SearchPage = () => {
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
    || results.data.albums.length
    || results.data.audioTracks.length
  ));

  return (
    <div className={styles.page}>
      <p className={styles.eyebrow}>Find your next listen</p>
      <h1 className={styles.pageTitle}>Search</h1>
      <p className={styles.lede}>Artists, albums, and soundtracks meet in one clear result view.</p>

      <form className={styles.searchForm} role="search" aria-label="Search results" onSubmit={submit}>
        <Icon name="search" />
        <label className="visually-hidden" htmlFor="page-search">Search artists, albums, and soundtracks</label>
        <input
          enterKeyHint="search"
          id="page-search"
          onChange={(event) => updateDraft(event.currentTarget.value)}
          onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
          onCompositionStart={startComposition}
          onKeyDown={submitFromInput}
          placeholder="What do you want to hear?"
          type="search"
          value={draftQuery}
        />
      </form>

      {activeQuery ? (
        <section className={styles.searchResults} aria-labelledby="results-title" aria-busy={results.isPending}>
          <h2 className={styles.sectionTitle} id="results-title">Results for “{activeQuery}”</h2>
          {results.isPending ? (
            <div className={styles.compactState}>Searching the listening room…</div>
          ) : results.isError ? (
            <div className={styles.compactState} role="alert">
              <p>Search is unavailable right now.</p>
              <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => results.refetch()} type="button">Try again</button>
            </div>
          ) : !hasResults ? (
            <div className={styles.compactState}>
              <p>No artists, albums, or soundtracks matched this search.</p>
            </div>
          ) : (
            <div className={styles.resultGroups}>
              {results.data.artists.length > 0 && (
                <section aria-labelledby="artist-results-title">
                  <h3 className={styles.resultHeading} id="artist-results-title">Artists</h3>
                  <ul className={styles.resultGrid}>
                    {results.data.artists.map((artist) => (
                      <li key={artist.id}><ContentCard item={artist} /></li>
                    ))}
                  </ul>
                </section>
              )}
              {results.data.albums.length > 0 && (
                <PageSection id="search-albums" items={results.data.albums} presentation="grid" title="Albums" />
              )}
              {results.data.audioTracks.length > 0 && (
                <PageSection
                  id="search-soundtracks"
                  items={results.data.audioTracks}
                  onPlay={(track) => { void launchStandalonePlayback(track, viewerId); }}
                  presentation="list"
                  title="Soundtracks"
                />
              )}
            </div>
          )}
        </section>
      ) : (
        <section className={styles.section} aria-labelledby="browse-title">
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle} id="browse-title">
              {history.length > 0 ? 'Recent searches' : 'Try a listening mood'}
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
                Clear
              </button>
            )}
          </div>
          <div className={styles.chipList}>
            {(history.length > 0 ? history : suggestions).map((suggestion) => (
              <Link
                className={styles.chip}
                key={suggestion}
                onClick={() => {
                  cancelPendingPreview();
                  recordSubmittedQuery(suggestion);
                }}
                replace={isPreview}
                state={null}
                to={`?q=${encodeURIComponent(suggestion)}`}
              >
                {suggestion}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
