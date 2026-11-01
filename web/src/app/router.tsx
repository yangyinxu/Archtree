import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';

import { AppShell } from './AppShell';
import { NotFoundPage, RouteErrorPage } from './RouteErrorPage';
import styles from '../styles/Pages.module.css';
import { useLocalization } from '../localization/LocalizationProvider';

/**
 * A lazy page from its module's named export. Naming the export once keeps the bundler from repeating it in the
 * initial route table, whose bytes count toward every listener route's budget.
 */
const page = <Name extends string, Props extends object>(load: () => Promise<Record<Name, ComponentType<Props>>>, name: Name) =>
  lazy(() => load().then(module => ({ default: module[name] })));

const AdminRouter = lazy(() => import('../features/admin/AdminRouter'));
const AccountPage = page(() => import('../features/account/AccountPage'), 'AccountPage');
const AccountSessionsPage = page(() => import('../features/account/AccountSessionsPage'), 'AccountSessionsPage');
const ChangePasswordPage = page(() => import('../features/account/ChangePasswordPage'), 'ChangePasswordPage');
const LoginPage = page(() => import('../features/account/LoginPage'), 'LoginPage');
const AlbumPage = page(() => import('../features/catalog/AlbumPage'), 'AlbumPage');
const ArtistPage = page(() => import('../features/catalog/ArtistPage'), 'ArtistPage');
const OrganizationPage = page(() => import('../features/catalog/OrganizationPage'), 'OrganizationPage');
const HomePage = page(() => import('../features/home/HomePage'), 'HomePage');
const LibraryPage = page(() => import('../features/library/LibraryPage'), 'LibraryPage');
const PlaylistDetailPage = page(() => import('../features/playlists/PlaylistDetailPage'), 'PlaylistDetailPage');
const PlaylistFeatureGate = page(() => import('../features/playlists/PlaylistFeatureGate'), 'PlaylistFeatureGate');
const PlaylistIndexPage = page(() => import('../features/playlists/PlaylistIndexPage'), 'PlaylistIndexPage');
const SearchPage = page(() => import('../features/search/SearchPage'), 'SearchPage');
const SocialPage = page(() => import('../features/social/SocialPage'), 'SocialPage');
const RoomInvitationsPage = page(() => import('../features/social/RoomInvitationsPage'), 'RoomInvitationsPage');
const MusicSharesPage = page(() => import('../features/social/MusicSharesPage'), 'MusicSharesPage');

/** Provides an announced route placeholder while a page-specific bundle loads. */
const RouteLoadingPage = () => {
  const { t } = useLocalization();
  return (
    <div className={styles.page}>
      <section className={styles.panel} role="status">
        <div>
          <p className={styles.eyebrow}>Finitude</p>
          <p className={styles.panelTitle}>{t('route.loading')}</p>
        </div>
      </section>
    </div>
  );
};

/** Keeps each page behind the same accessible suspense boundary. */
const loadRoute = (page: ReactNode) => (
  <Suspense fallback={<RouteLoadingPage />}>{page}</Suspense>
);

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: loadRoute(<HomePage />), errorElement: <RouteErrorPage /> },
      { path: 'admin/*', element: loadRoute(<AdminRouter />), errorElement: <RouteErrorPage /> },
      { path: 'search', element: loadRoute(<SearchPage />), errorElement: <RouteErrorPage /> },
      { path: 'library', element: loadRoute(<LibraryPage />), errorElement: <RouteErrorPage /> },
      { path: 'social', element: loadRoute(<SocialPage />), errorElement: <RouteErrorPage /> },
      { path: 'social/shares', element: loadRoute(<MusicSharesPage />), errorElement: <RouteErrorPage /> },
      { path: 'social/invitations', element: loadRoute(<RoomInvitationsPage />), errorElement: <RouteErrorPage /> },
      { path: 'social/invitations/:invitationId', element: loadRoute(<RoomInvitationsPage />), errorElement: <RouteErrorPage /> },
      { path: 'playlists', element: loadRoute(<PlaylistFeatureGate><PlaylistIndexPage /></PlaylistFeatureGate>), errorElement: <RouteErrorPage /> },
      { path: 'playlists/:playlistId', element: loadRoute(<PlaylistFeatureGate><PlaylistDetailPage /></PlaylistFeatureGate>), errorElement: <RouteErrorPage /> },
      { path: 'albums/:albumId', element: loadRoute(<AlbumPage />), errorElement: <RouteErrorPage /> },
      { path: 'artists/:artistId', element: loadRoute(<ArtistPage />), errorElement: <RouteErrorPage /> },
      { path: 'organizations/:organizationId', element: loadRoute(<OrganizationPage />), errorElement: <RouteErrorPage /> },
      { path: 'login', element: loadRoute(<LoginPage />), errorElement: <RouteErrorPage /> },
      { path: 'account/sessions', element: loadRoute(<AccountSessionsPage />), errorElement: <RouteErrorPage /> },
      { path: 'account/password', element: loadRoute(<ChangePasswordPage />), errorElement: <RouteErrorPage /> },
      { path: 'account', element: loadRoute(<AccountPage />), errorElement: <RouteErrorPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
];

/** Applies the stable Finitude base path while retaining native browser history. */
export const router = createBrowserRouter(appRoutes, { basename: '/finitude' });
