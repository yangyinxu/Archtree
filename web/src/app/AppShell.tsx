import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { browserSessionQuery } from '../api/session';
import { listenerCapabilitiesQuery } from '../api/listenerCapabilities';
import { Avatar } from '../components/Avatar';
import { Icon, type IconName } from '../components/Icon';
import { SearchQueryProvider, useSearchQuery } from '../features/search/SearchQueryProvider';
import { useSearchHistoryRecorder } from '../features/search/useSearchHistoryRecorder';
import { RouteAnnouncer } from './RouteAnnouncer';
import styles from './AppShell.module.css';

const destinations: Array<{ label: string; path: string; icon: IconName }> = [
  { label: 'Home', path: '/', icon: 'home' },
  { label: 'Search', path: '/search', icon: 'search' },
  { label: 'Library', path: '/library', icon: 'library' }
];

const PlaylistSidebar = lazy(() => import('../features/playlists/PlaylistSidebar'));
const ShellPanelResizers = lazy(() => import('./ShellPanelResizers').then((module) => ({
  default: module.ShellPanelResizers
})));
const NowPlayingAside = lazy(() => import('../components/NowPlayingAside').then((module) => ({
  default: module.NowPlayingAside
})));
const PlayerBar = lazy(() => import('../components/PlayerBar').then((module) => ({
  default: module.PlayerBar
})));

/** Activates the shell skip link without changing the routed URL. */
const skipToMainContent = (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  document.getElementById('main-content')?.focus({ preventScroll: true });
};

const PrimaryNavigation = ({ mobile = false }: { mobile?: boolean }) => {
  const location = useLocation();
  return (
    <nav className={mobile ? styles.mobileNavigation : styles.navigation} aria-label="Primary">
      {destinations.map((destination) => {
        const libraryOwnsRoute = destination.path === '/library'
          && (location.pathname === '/playlists' || location.pathname.startsWith('/playlists/'));
        return (
          <NavLink
            aria-current={libraryOwnsRoute ? 'page' : undefined}
            aria-label={destination.label}
            className={({ isActive }) => `${styles.navigationLink} ${isActive || libraryOwnsRoute ? styles.active : ''}`}
            end={destination.path === '/'}
            key={destination.path}
            to={destination.path}
          >
            <Icon name={destination.icon} />
            <span>{destination.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
};

const TopSearch = () => {
  const input = useRef<HTMLInputElement>(null);
  const { recordSubmittedQuery } = useSearchHistoryRecorder();
  const {
    commitDraft,
    draftQuery,
    finishComposition,
    isComposing,
    startComposition,
    updateDraft
  } = useSearchQuery();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isComposing) return;
    const normalized = commitDraft();
    if (normalized) recordSubmittedQuery(normalized);
  };

  const preventCompositionSubmit = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  };

  const expandCompactSearch = (event: MouseEvent<HTMLButtonElement>) => {
    if (window.matchMedia?.('(max-width: 479px)').matches && document.activeElement !== input.current) {
      event.preventDefault();
      input.current?.focus();
    }
  };

  return (
    <form className={styles.search} role="search" aria-label="Global search" onSubmit={submit}>
      <button
        className={styles.searchSubmit}
        onClick={expandCompactSearch}
        type="submit"
        aria-label="Submit search"
      >
        <Icon name="search" />
      </button>
      <label className="visually-hidden" htmlFor="shell-search">Search artists, albums, and soundtracks</label>
      <input
        enterKeyHint="search"
        id="shell-search"
        name="q"
        onChange={(event) => updateDraft(event.currentTarget.value)}
        onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
        onCompositionStart={startComposition}
        onKeyDown={preventCompositionSubmit}
        placeholder="Search music"
        ref={input}
        type="search"
        value={draftQuery}
      />
    </form>
  );
};

const AccountEntry = () => {
  const session = useQuery(browserSessionQuery());
  const user = session.data?.user;
  const label = user?.displayName.trim() || user?.email || (session.isPending ? 'Checking account' : 'Log in');

  return (
    <Link className={styles.account} to={user ? '/account' : '/login'} aria-label={label}>
      <Avatar
        avatar={user?.avatar}
        displayName={user?.displayName}
        email={user?.email}
        viewerId={user?.id}
      />
      <span>{label}</span>
    </Link>
  );
};

/** Keeps navigation, route content, and the single player mounted together. */
const AppShellContent = () => {
  const navigate = useNavigate();
  const capabilities = useQuery(listenerCapabilitiesQuery());
  const [nowPlayingOpen, setNowPlayingOpen] = useState(true);
  const [widePanelResizersEnabled, setWidePanelResizersEnabled] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      setWidePanelResizersEnabled(window.innerWidth >= 1008);
      return undefined;
    }

    const wideLayout = window.matchMedia('(min-width: 1008px)');
    const updateAvailability = () => setWidePanelResizersEnabled(wideLayout.matches);
    updateAvailability();
    wideLayout.addEventListener?.('change', updateAvailability);
    return () => wideLayout.removeEventListener?.('change', updateAvailability);
  }, []);

  return (
    <div
      className={styles.shell}
      data-now-playing-open={nowPlayingOpen}
      ref={shellRef}
    >
      <a className={styles.skipLink} href="#main-content" onClick={skipToMainContent}>Skip to main content</a>
      <RouteAnnouncer />

      <header className={styles.topbar}>
        <Link className={styles.brand} to="/" aria-label="Finitude home">
          <span className={styles.brandMark} aria-hidden="true"><Icon name="brand" /></span>
          <span className={styles.brandName}>Finitude</span>
        </Link>

        <div className={styles.topbarCenter}>
          <div className={styles.historyControls} aria-label="Page history">
            <button type="button" onClick={() => navigate(-1)} aria-label="Go back" title="Go back">
              <Icon name="arrow-left" />
            </button>
            <button type="button" onClick={() => navigate(1)} aria-label="Go forward" title="Go forward">
              <Icon name="arrow-right" />
            </button>
          </div>
          <TopSearch />
        </div>

        <AccountEntry />
      </header>

      <aside className={styles.sidebar} aria-label="Finitude Library" id="library-sidebar">
        <div className={styles.sidebarHeader}>
          <Icon name="library" />
          <span>Your Library</span>
        </div>
        <PrimaryNavigation />
        {capabilities.data?.playlists && (
          <Suspense fallback={<div className={styles.sidebarLoading} aria-hidden="true" />}>
            <PlaylistSidebar />
          </Suspense>
        )}
      </aside>

      {widePanelResizersEnabled && (
        <Suspense fallback={null}>
          <ShellPanelResizers nowPlayingOpen={nowPlayingOpen} shellRef={shellRef} />
        </Suspense>
      )}

      <div className={styles.workspace}>
        <main className={styles.main} id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <aside
        aria-hidden={!nowPlayingOpen || undefined}
        aria-label="Now Playing details"
        className={styles.nowPlayingSlot}
        id="now-playing-aside"
        inert={!nowPlayingOpen ? true : undefined}
      >
        <Suspense fallback={<div className={styles.asideLoading} aria-hidden="true" />}>
          <NowPlayingAside />
        </Suspense>
      </aside>

      <div className={styles.playerSlot}>
        <Suspense fallback={<div className={styles.playerLoading} aria-hidden="true" />}>
          <PlayerBar
            nowPlayingOpen={nowPlayingOpen}
            onToggleNowPlaying={() => setNowPlayingOpen((open) => !open)}
          />
        </Suspense>
      </div>
      <PrimaryNavigation mobile />
    </div>
  );
};

/** Shares one Search draft across the shell search field and Search page. */
export const AppShell = () => (
  <SearchQueryProvider>
    <AppShellContent />
  </SearchQueryProvider>
);
