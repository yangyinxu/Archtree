import { createBrowserRouter, type RouteObject } from 'react-router';

import { AccountPage } from '../features/account/AccountPage';
import { AccountSessionsPage } from '../features/account/AccountSessionsPage';
import { ChangePasswordPage } from '../features/account/ChangePasswordPage';
import { ForgotPasswordPage } from '../features/account/ForgotPasswordPage';
import { LoginPage } from '../features/account/LoginPage';
import { RegisterPage } from '../features/account/RegisterPage';
import { ResetPasswordPage } from '../features/account/ResetPasswordPage';
import { VerifyEmailPage } from '../features/account/VerifyEmailPage';
import { AlbumPage } from '../features/catalog/AlbumPage';
import { ArtistPage } from '../features/catalog/ArtistPage';
import { HomePage } from '../features/home/HomePage';
import { LibraryPage } from '../features/library/LibraryPage';
import { SearchPage } from '../features/search/SearchPage';
import { AppShell } from './AppShell';
import { NotFoundPage, RouteErrorPage } from './RouteErrorPage';

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage />, errorElement: <RouteErrorPage /> },
      { path: 'search', element: <SearchPage />, errorElement: <RouteErrorPage /> },
      { path: 'library', element: <LibraryPage />, errorElement: <RouteErrorPage /> },
      { path: 'albums/:albumId', element: <AlbumPage />, errorElement: <RouteErrorPage /> },
      { path: 'artists/:artistId', element: <ArtistPage />, errorElement: <RouteErrorPage /> },
      { path: 'login', element: <LoginPage />, errorElement: <RouteErrorPage /> },
      { path: 'register', element: <RegisterPage />, errorElement: <RouteErrorPage /> },
      { path: 'verify-email', element: <VerifyEmailPage />, errorElement: <RouteErrorPage /> },
      { path: 'forgot-password', element: <ForgotPasswordPage />, errorElement: <RouteErrorPage /> },
      { path: 'reset-password', element: <ResetPasswordPage />, errorElement: <RouteErrorPage /> },
      { path: 'account/sessions', element: <AccountSessionsPage />, errorElement: <RouteErrorPage /> },
      { path: 'account/password', element: <ChangePasswordPage />, errorElement: <RouteErrorPage /> },
      { path: 'account', element: <AccountPage />, errorElement: <RouteErrorPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
];

/** Applies the stable listener base path while retaining native browser history. */
export const router = createBrowserRouter(appRoutes, { basename: '/listen' });
