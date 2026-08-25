import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useLocalization } from '../localization/LocalizationProvider';
import type { MessageKey } from '../localization/contract';

const titleKeyFor = (pathname: string): MessageKey => {
  if (pathname === '/') return 'route.title.home';
  if (pathname === '/search') {
    return 'route.title.search';
  }
  if (pathname === '/library') return 'route.title.library';
  if (pathname === '/playlists') return 'route.title.playlists';
  if (/^\/playlists\/[^/]+$/.test(pathname)) return 'route.title.playlist';
  if (/^\/albums\/[^/]+$/.test(pathname)) return 'route.title.album';
  if (/^\/artists\/[^/]+$/.test(pathname)) return 'route.title.artist';
  if (/^\/organizations\/[^/]+$/.test(pathname)) return 'route.title.organization';
  if (pathname === '/register') return 'route.title.create_account';
  if (pathname === '/verify-email') return 'route.title.verify_email';
  if (pathname === '/forgot-password') return 'route.title.forgot_password';
  if (pathname === '/reset-password') return 'route.title.reset_password';
  if (pathname === '/login') return 'route.title.log_in';
  if (pathname === '/account/sessions') return 'route.title.sessions';
  if (pathname === '/account/password') return 'route.title.password_settings';
  if (pathname === '/account') return 'route.title.account';
  return 'route.title.not_found';
};

/** Announces client-side route changes that do not trigger a document load. */
export const RouteAnnouncer = () => {
  const location = useLocation();
  const { t } = useLocalization();
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const query = location.pathname === '/search'
      ? new URLSearchParams(location.search).get('q')?.trim()
      : undefined;
    const title = query
      ? t('route.title.search_results', { query })
      : t(titleKeyFor(location.pathname));
    document.title = `${title} · Finitude`;
    // Clearing first makes same-kind dynamic routes announce again, such as
    // moving directly from one Album to another Album.
    setAnnouncement('');
    const timer = window.setTimeout(() => setAnnouncement(t('route.announcement.page', { title })), 50);
    return () => window.clearTimeout(timer);
  }, [location.pathname, location.search, t]);

  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  );
};
