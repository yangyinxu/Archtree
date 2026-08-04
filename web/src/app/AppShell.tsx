import { type FormEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';

import { browserSessionQuery } from '../api/session';
import { Avatar } from '../components/Avatar';
import { Icon, type IconName } from '../components/Icon';
import { PlayerBar } from '../components/PlayerBar';
import { SearchQueryProvider, useSearchQuery } from '../features/search/SearchQueryProvider';
import { useSearchHistoryRecorder } from '../features/search/useSearchHistoryRecorder';
import { RouteAnnouncer } from './RouteAnnouncer';
import styles from './AppShell.module.css';

const destinations: Array<{ label: string; path: string; icon: IconName }> = [
  { label: 'Home', path: '/', icon: 'home' },
  { label: 'Search', path: '/search', icon: 'search' },
  { label: 'Library', path: '/library', icon: 'library' }
];

const PrimaryNavigation = ({ mobile = false }: { mobile?: boolean }) => (
  <nav className={mobile ? styles.mobileNavigation : styles.navigation} aria-label="Primary">
    {destinations.map((destination) => (
      <NavLink
        aria-label={destination.label}
        className={({ isActive }) => `${styles.navigationLink} ${isActive ? styles.active : ''}`}
        end={destination.path === '/'}
        key={destination.path}
        to={destination.path}
      >
        <Icon name={destination.icon} />
        <span>{destination.label}</span>
      </NavLink>
    ))}
  </nav>
);

const TopSearch = () => {
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

  return (
    <form className={styles.search} role="search" aria-label="Global search" onSubmit={submit}>
      <button className={styles.searchSubmit} type="submit" aria-label="Submit search">
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

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">Skip to main content</a>
      <RouteAnnouncer />

      <aside className={styles.sidebar} aria-label="Finitude">
        <Link className={styles.brand} to="/" aria-label="Finitude home">
          <span className={styles.brandMark} aria-hidden="true">F</span>
          <span className={styles.brandName}>Finitude</span>
        </Link>
        <PrimaryNavigation />
        <p className={styles.sidebarNote}>Room for every note.</p>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.historyControls} aria-label="Page history">
            <button type="button" onClick={() => navigate(-1)} aria-label="Go back" title="Go back">
              <Icon name="arrow-left" />
            </button>
            <button type="button" onClick={() => navigate(1)} aria-label="Go forward" title="Go forward">
              <Icon name="arrow-right" />
            </button>
          </div>
          <TopSearch />
          <AccountEntry />
        </header>

        <main className={styles.main} id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <div className={styles.playerSlot}><PlayerBar /></div>
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
