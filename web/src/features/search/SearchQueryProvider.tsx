import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';

const searchDebounceMilliseconds = 300;
const searchPath = '/search';

type SearchRouteState = {
  searchPreview?: boolean;
};

type SearchQueryContextValue = {
  activeQuery: string;
  cancelPendingPreview: () => void;
  commitDraft: () => string;
  draftQuery: string;
  finishComposition: (value: string) => void;
  isComposing: boolean;
  isPreview: boolean;
  startComposition: () => void;
  updateDraft: (value: string) => void;
};

const SearchQueryContext = createContext<SearchQueryContextValue | null>(null);

const normalizeQuery = (query: string) => query.trim();

const matchesSearchPath = (pathname: string) => Boolean(matchPath({
  path: searchPath,
  end: true
}, pathname));

const queryFromLocation = (pathname: string, search: string) => (
  matchesSearchPath(pathname)
    ? normalizeQuery(new URLSearchParams(search).get('q') ?? '')
    : ''
);

const isSearchPreview = (state: unknown) => Boolean(
  state
  && typeof state === 'object'
  && (state as SearchRouteState).searchPreview === true
);

const searchDestination = (query: string) => (
  query ? `${searchPath}?q=${encodeURIComponent(query)}` : searchPath
);

/** Shares one debounced Search draft across the shell and route-level inputs. */
export const SearchQueryProvider = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const activeQuery = useMemo(
    () => queryFromLocation(location.pathname, location.search),
    [location.pathname, location.search]
  );
  const isSearchRoute = matchesSearchPath(location.pathname);
  const isPreview = isSearchRoute && isSearchPreview(location.state);
  const [draftQuery, setDraftQuery] = useState(activeQuery);
  const [isComposing, setIsComposing] = useState(false);
  const previewTimer = useRef<number | null>(null);

  const cancelPendingPreview = useCallback(() => {
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
  }, []);

  useEffect(() => {
    setDraftQuery(activeQuery);
    setIsComposing(false);
  }, [activeQuery, location.pathname]);

  useEffect(() => {
    cancelPendingPreview();
    if (isComposing) return;
    const normalized = normalizeQuery(draftQuery);
    if ((isSearchRoute && normalized === activeQuery) || (!isSearchRoute && !normalized)) return;

    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      navigate(searchDestination(normalized), {
        replace: isSearchRoute && isPreview,
        state: { searchPreview: true } satisfies SearchRouteState
      });
    }, searchDebounceMilliseconds);
    return cancelPendingPreview;
  }, [
    activeQuery,
    cancelPendingPreview,
    draftQuery,
    isComposing,
    isPreview,
    isSearchRoute,
    navigate
  ]);

  const updateDraft = useCallback((value: string) => setDraftQuery(value), []);
  const startComposition = useCallback(() => setIsComposing(true), []);
  const finishComposition = useCallback((value: string) => {
    setDraftQuery(value);
    setIsComposing(false);
  }, []);

  const commitDraft = useCallback(() => {
    cancelPendingPreview();
    const normalized = normalizeQuery(draftQuery);
    const isAlreadyCommitted = isSearchRoute
      && !isPreview
      && normalized === activeQuery;
    if (!isAlreadyCommitted) {
      navigate(searchDestination(normalized), {
        replace: isPreview,
        state: null
      });
    }
    return normalized;
  }, [activeQuery, cancelPendingPreview, draftQuery, isPreview, isSearchRoute, navigate]);

  const value = useMemo<SearchQueryContextValue>(() => ({
    activeQuery,
    cancelPendingPreview,
    commitDraft,
    draftQuery,
    finishComposition,
    isComposing,
    isPreview,
    startComposition,
    updateDraft
  }), [
    activeQuery,
    cancelPendingPreview,
    commitDraft,
    draftQuery,
    finishComposition,
    isComposing,
    isPreview,
    startComposition,
    updateDraft
  ]);

  return <SearchQueryContext.Provider value={value}>{children}</SearchQueryContext.Provider>;
};

/** Returns the shared draft controller required by both listener Search inputs. */
export const useSearchQuery = () => {
  const context = useContext(SearchQueryContext);
  if (!context) throw new Error('useSearchQuery requires SearchQueryProvider');
  return context;
};
