import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';

import { AppShell } from './AppShell';
import { NotFoundPage, RouteErrorPage } from './RouteErrorPage';
import styles from '../styles/Pages.module.css';

const AccountPage = lazy(() => import('../features/account/AccountPage').then(({ AccountPage }) => ({ default: AccountPage })));
const AccountSessionsPage = lazy(() => import('../features/account/AccountSessionsPage').then(({ AccountSessionsPage }) => ({ default: AccountSessionsPage })));
const ChangePasswordPage = lazy(() => import('../features/account/ChangePasswordPage').then(({ ChangePasswordPage }) => ({ default: ChangePasswordPage })));
const ForgotPasswordPage = lazy(() => import('../features/account/ForgotPasswordPage').then(({ ForgotPasswordPage }) => ({ default: ForgotPasswordPage })));
const LoginPage = lazy(() => import('../features/account/LoginPage').then(({ LoginPage }) => ({ default: LoginPage })));
const RegisterPage = lazy(() => import('../features/account/RegisterPage').then(({ RegisterPage }) => ({ default: RegisterPage })));
const ResetPasswordPage = lazy(() => import('../features/account/ResetPasswordPage').then(({ ResetPasswordPage }) => ({ default: ResetPasswordPage })));
const VerifyEmailPage = lazy(() => import('../features/account/VerifyEmailPage').then(({ VerifyEmailPage }) => ({ default: VerifyEmailPage })));
const AlbumPage = lazy(() => import('../features/catalog/AlbumPage').then(({ AlbumPage }) => ({ default: AlbumPage })));
const ArtistPage = lazy(() => import('../features/catalog/ArtistPage').then(({ ArtistPage }) => ({ default: ArtistPage })));
const HomePage = lazy(() => import('../features/home/HomePage').then(({ HomePage }) => ({ default: HomePage })));
const LibraryPage = lazy(() => import('../features/library/LibraryPage').then(({ LibraryPage }) => ({ default: LibraryPage })));
const PlaylistDetailPage = lazy(() => import('../features/playlists/PlaylistDetailPage').then(({ PlaylistDetailPage }) => ({ default: PlaylistDetailPage })));
const PlaylistFeatureGate = lazy(() => import('../features/playlists/PlaylistFeatureGate').then(({ PlaylistFeatureGate }) => ({ default: PlaylistFeatureGate })));
const PlaylistIndexPage = lazy(() => import('../features/playlists/PlaylistIndexPage').then(({ PlaylistIndexPage }) => ({ default: PlaylistIndexPage })));
const SearchPage = lazy(() => import('../features/search/SearchPage').then(({ SearchPage }) => ({ default: SearchPage })));

/** Provides an announced route placeholder while a page-specific bundle loads. */
const RouteLoadingPage = () => (
  <div className={styles.page}>
    <section className={styles.panel} role="status">
      <div>
        <p className={styles.eyebrow}>Finitude</p>
        <p className={styles.panelTitle}>Opening your listening room…</p>
      </div>
    </section>
  </div>
);

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
      { path: 'search', element: loadRoute(<SearchPage />), errorElement: <RouteErrorPage /> },
      { path: 'library', element: loadRoute(<LibraryPage />), errorElement: <RouteErrorPage /> },
      { path: 'playlists', element: loadRoute(<PlaylistFeatureGate><PlaylistIndexPage /></PlaylistFeatureGate>), errorElement: <RouteErrorPage /> },
      { path: 'playlists/:playlistId', element: loadRoute(<PlaylistFeatureGate><PlaylistDetailPage /></PlaylistFeatureGate>), errorElement: <RouteErrorPage /> },
      { path: 'albums/:albumId', element: loadRoute(<AlbumPage />), errorElement: <RouteErrorPage /> },
      { path: 'artists/:artistId', element: loadRoute(<ArtistPage />), errorElement: <RouteErrorPage /> },
      { path: 'login', element: loadRoute(<LoginPage />), errorElement: <RouteErrorPage /> },
      { path: 'register', element: loadRoute(<RegisterPage />), errorElement: <RouteErrorPage /> },
      { path: 'verify-email', element: loadRoute(<VerifyEmailPage />), errorElement: <RouteErrorPage /> },
      { path: 'forgot-password', element: loadRoute(<ForgotPasswordPage />), errorElement: <RouteErrorPage /> },
      { path: 'reset-password', element: loadRoute(<ResetPasswordPage />), errorElement: <RouteErrorPage /> },
      { path: 'account/sessions', element: loadRoute(<AccountSessionsPage />), errorElement: <RouteErrorPage /> },
      { path: 'account/password', element: loadRoute(<ChangePasswordPage />), errorElement: <RouteErrorPage /> },
      { path: 'account', element: loadRoute(<AccountPage />), errorElement: <RouteErrorPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
];

/** Applies the stable Finitude base path while retaining native browser history. */
export const router = createBrowserRouter(appRoutes, { basename: '/finitude' });
