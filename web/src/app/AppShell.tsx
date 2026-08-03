import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { browserSessionQuery } from '../api/session';
import { Avatar } from '../components/Avatar';
import { Icon, type IconName } from '../components/Icon';
import { PlayerBar } from '../components/PlayerBar';
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
  const location = useLocation();
  const navigate = useNavigate();
  const routeQuery = new URLSearchParams(location.search).get('q') ?? '';
  const [query, setQuery] = useState(routeQuery);

  useEffect(() => setQuery(routeQuery), [routeQuery]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = query.trim();
    navigate(normalized ? `/search?q=${encodeURIComponent(normalized)}` : '/search');
  };

  return (
    <form className={styles.search} role="search" aria-label="Global search" onSubmit={submit}>
      <button className={styles.searchSubmit} type="submit" aria-label="Submit search">
        <Icon name="search" />
      </button>
      <label className="visually-hidden" htmlFor="shell-search">Search artists, albums, and soundtracks</label>
      <input
        id="shell-search"
        name="q"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search music"
        type="search"
        value={query}
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
export const AppShell = () => {
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
