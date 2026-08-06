import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';

const titleFor = (pathname: string, search: string) => {
  if (pathname === '/') return 'Home';
  if (pathname === '/search') {
    const query = new URLSearchParams(search).get('q')?.trim();
    return query ? `Search results for ${query}` : 'Search';
  }
  if (pathname === '/library') return 'Library';
  if (pathname === '/playlists') return 'Playlists';
  if (/^\/playlists\/[^/]+$/.test(pathname)) return 'Playlist';
  if (/^\/albums\/[^/]+$/.test(pathname)) return 'Album';
  if (/^\/artists\/[^/]+$/.test(pathname)) return 'Artist';
  if (pathname === '/register') return 'Create account';
  if (pathname === '/verify-email') return 'Verify email';
  if (pathname === '/forgot-password') return 'Forgot password';
  if (pathname === '/reset-password') return 'Reset password';
  if (pathname === '/login') return 'Log in';
  if (pathname === '/account/sessions') return 'Signed-in devices';
  if (pathname === '/account/password') return 'Password settings';
  if (pathname === '/account') return 'Account';
  return 'Page not found';
};

/** Announces client-side route changes that do not trigger a document load. */
export const RouteAnnouncer = () => {
  const location = useLocation();
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const title = titleFor(location.pathname, location.search);
    document.title = `${title} · Finitude`;
    // Clearing first makes same-kind dynamic routes announce again, such as
    // moving directly from one Album to another Album.
    setAnnouncement('');
    const timer = window.setTimeout(() => setAnnouncement(`${title} page`), 50);
    return () => window.clearTimeout(timer);
  }, [location.pathname, location.search]);

  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  );
};
