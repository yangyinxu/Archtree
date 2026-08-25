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
import { useLocalization } from '../localization/LocalizationProvider';
import type { MessageKey } from '../localization/contract';
import { playerStore, usePlayer } from '../player';
import styles from './AppShell.module.css';

const destinations: Array<{ labelKey: MessageKey; path: string; icon: IconName }> = [
  { labelKey: 'shell.nav.home', path: '/', icon: 'home' },
  { labelKey: 'shell.nav.search', path: '/search', icon: 'search' },
  { labelKey: 'shell.nav.library', path: '/library', icon: 'library' }
];

const PlaylistSidebar = lazy(() => import('../features/playlists/PlaylistSidebar'));
const LanguageSelector = lazy(() => import('../localization/LanguageSelector').then((module) => ({
  default: module.LanguageSelector
})));
const ShellPanelResizers = lazy(() => import('./ShellPanelResizers').then((module) => ({
  default: module.ShellPanelResizers
})));
const NowPlayingAside = lazy(() => import('../components/NowPlayingAside').then((module) => ({
  default: module.NowPlayingAside
})));
const PlayerBar = lazy(() => import('../components/PlayerBar').then((module) => ({
  default: module.PlayerBar
})));
const VideoTheater = lazy(() => import('../components/VideoTheater'));

/** Activates the shell skip link without changing the routed URL. */
const skipToMainContent = (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  document.getElementById('main-content')?.focus({ preventScroll: true });
};

const PrimaryNavigation = ({ mobile = false }: { mobile?: boolean }) => {
  const location = useLocation();
  const { t } = useLocalization();
  return (
    <nav
      className={mobile ? styles.mobileNavigation : styles.navigation}
      aria-label={t('shell.nav.primary_label')}
    >
      {destinations.map((destination) => {
        const label = t(destination.labelKey);
        const libraryOwnsRoute = destination.path === '/library'
          && (location.pathname === '/playlists' || location.pathname.startsWith('/playlists/'));
        return (
          <NavLink
            aria-current={libraryOwnsRoute ? 'page' : undefined}
            aria-label={label}
            className={({ isActive }) => `${styles.navigationLink} ${isActive || libraryOwnsRoute ? styles.active : ''}`}
            end={destination.path === '/'}
            key={destination.path}
            to={destination.path}
          >
            <Icon name={destination.icon} />
            <span>{label}</span>
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
  const { t } = useLocalization();

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
    <form className={styles.search} role="search" aria-label={t('shell.search.global_label')} onSubmit={submit}>
      <button
        className={styles.searchSubmit}
        onClick={expandCompactSearch}
        type="submit"
        aria-label={t('shell.search.submit_label')}
      >
        <Icon name="search" />
      </button>
      <label className="visually-hidden" htmlFor="shell-search">{t('shell.search.field_label')}</label>
      <input
        enterKeyHint="search"
        id="shell-search"
        name="q"
        onChange={(event) => updateDraft(event.currentTarget.value)}
        onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
        onCompositionStart={startComposition}
        onKeyDown={preventCompositionSubmit}
        placeholder={t('shell.search.placeholder')}
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
  const { t } = useLocalization();
  const label = user?.displayName.trim()
    || user?.email
    || (session.isPending ? t('shell.account.checking') : t('shell.account.log_in'));

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
  const player = usePlayer(playerStore);
  const { t } = useLocalization();
  const videoPlaying = player.currentItem?.mediaType === 'video';
  const effectiveNowPlayingOpen = videoPlaying || nowPlayingOpen;

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
      data-now-playing-open={effectiveNowPlayingOpen}
      data-video-playing={videoPlaying || undefined}
      ref={shellRef}
    >
      <a className={styles.skipLink} href="#main-content" onClick={skipToMainContent}>
        {t('shell.skip_to_main')}
      </a>
      <RouteAnnouncer />

      <header className={styles.topbar}>
        <Link className={styles.brand} to="/" aria-label={t('shell.brand.home_label')}>
          <span className={styles.brandMark} aria-hidden="true"><Icon name="brand" /></span>
          <span className={styles.brandName}>Finitude</span>
        </Link>

        <div className={styles.topbarCenter}>
          <div className={styles.historyControls} aria-label={t('shell.history.label')}>
            <button type="button" onClick={() => navigate(-1)} aria-label={t('shell.history.back')} title={t('shell.history.back')}>
              <Icon name="arrow-left" />
            </button>
            <button type="button" onClick={() => navigate(1)} aria-label={t('shell.history.forward')} title={t('shell.history.forward')}>
              <Icon name="arrow-right" />
            </button>
          </div>
          <TopSearch />
        </div>

        <Suspense fallback={null}>
          <LanguageSelector placement="mobile" />
        </Suspense>
        <AccountEntry />
      </header>

      <aside className={styles.sidebar} aria-label={t('shell.sidebar.label')} id="library-sidebar">
        <PrimaryNavigation />
        {capabilities.data?.playlists && (
          <Suspense fallback={<div className={styles.sidebarLoading} aria-hidden="true" />}>
            <PlaylistSidebar />
          </Suspense>
        )}
        <Suspense fallback={null}>
          <LanguageSelector />
        </Suspense>
      </aside>

      {widePanelResizersEnabled && !videoPlaying && (
        <Suspense fallback={null}>
          <ShellPanelResizers nowPlayingOpen={nowPlayingOpen} shellRef={shellRef} />
        </Suspense>
      )}

      <div className={styles.workspace}>
        <main
          aria-hidden={videoPlaying || undefined}
          className={styles.main}
          data-obscured={videoPlaying || undefined}
          id="main-content"
          inert={videoPlaying ? true : undefined}
          tabIndex={-1}
        >
          <Outlet />
        </main>
        {videoPlaying && (
          <Suspense fallback={<div className={styles.videoLoading} aria-hidden="true" />}>
            <VideoTheater />
          </Suspense>
        )}
      </div>

      <aside
        aria-hidden={!effectiveNowPlayingOpen || undefined}
        aria-label={t('shell.now_playing.details_label')}
        className={styles.nowPlayingSlot}
        id="now-playing-aside"
        inert={!effectiveNowPlayingOpen ? true : undefined}
      >
        <Suspense fallback={<div className={styles.asideLoading} aria-hidden="true" />}>
          <NowPlayingAside />
        </Suspense>
      </aside>

      <div className={styles.playerSlot}>
        <Suspense fallback={<div className={styles.playerLoading} aria-hidden="true" />}>
          <PlayerBar
            nowPlayingOpen={effectiveNowPlayingOpen}
            onToggleNowPlaying={videoPlaying
              ? undefined
              : () => setNowPlayingOpen((open) => !open)}
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
