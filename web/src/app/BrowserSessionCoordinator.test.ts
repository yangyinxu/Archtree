import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';

import type { BrowserSession } from '../api/schemas';
import {
  accountSessionChangeStorageKey
} from '../api/accountSessionEvents';
import { browserSessionQuery, browserSessionQueryKey } from '../api/session';
import { readSearchHistory, rememberSearchQuery } from '../features/search/searchHistory';
import {
  reconcileAccountSessionChange,
  startBrowserSessionCoordinator
} from './BrowserSessionCoordinator';
import '../styles/global.css';

const sessionFor = (id: string): BrowserSession => ({
  user: {
    id,
    email: `${id}@example.com`,
    role: 'user',
    displayName: id,
    avatarRevision: 0,
    avatar: null,
    emailVerified: true
  }
});

const sessionResponse = (session: BrowserSession) => new Response(JSON.stringify(session), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/finitude');
  document.getElementById('root')?.remove();
});

const CurrentIdentity = () => {
  const session = useQuery(browserSessionQuery());
  return createElement(
    'div',
    { 'data-testid': 'current-identity', style: { visibility: 'visible' } },
    session.data?.user.displayName ?? 'Signed out'
  );
};

test('cancels every stale read, drops all non-session caches, and installs the authoritative viewer', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, sessionFor('viewer-a'));
  queryClient.setQueryData(['account', 'viewer-a', 'sessions'], { private: 'a' });
  queryClient.setQueryData(['listener', 'home', 'viewer-a'], { private: 'a-home' });
  queryClient.setQueryData(['listener', 'album', 'public-album'], { public: true });

  let releaseStale!: (value: { private: string }) => void;
  const staleRequest = queryClient.fetchQuery({
    queryKey: ['listener', 'library', 'viewer-a'],
    queryFn: () => new Promise<{ private: string }>((resolve) => { releaseStale = resolve; })
  }).catch(() => undefined);
  await Promise.resolve();

  let releaseSession!: (response: Response) => void;
  const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
    releaseSession = resolve;
  }));
  vi.stubGlobal('fetch', fetchMock);
  const reconciliation = reconcileAccountSessionChange(queryClient, {
    id: 'viewer-mismatch-1',
    reason: 'viewer-mismatch'
  });

  expect(queryClient.getQueryData(browserSessionQueryKey)).toBeNull();
  expect(queryClient.getQueryData(['account', 'viewer-a', 'sessions'])).toBeUndefined();
  expect(queryClient.getQueryData(['listener', 'home', 'viewer-a'])).toBeUndefined();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  releaseSession(sessionResponse(sessionFor('viewer-b')));
  await reconciliation;
  releaseStale({ private: 'late-a-library' });
  await staleRequest;
  await Promise.resolve();

  expect(queryClient.getQueryData(browserSessionQueryKey)).toEqual(sessionFor('viewer-b'));
  expect(queryClient.getQueryData(['account', 'viewer-a', 'sessions'])).toBeUndefined();
  expect(queryClient.getQueryData(['listener', 'home', 'viewer-a'])).toBeUndefined();
  expect(queryClient.getQueryData(['listener', 'library', 'viewer-a'])).toBeUndefined();
  // Account switches are rare security boundaries, so public cache refetches are preferred
  // over maintaining an error-prone allowlist that could retain newly added private data.
  expect(queryClient.getQueryData(['listener', 'album', 'public-album'])).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledWith('/auth/browser/session', expect.objectContaining({
    credentials: 'same-origin'
  }));
});

test('a cross-tab exit clears only the previous viewer search history', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, sessionFor('viewer-a'));
  rememberSearchQuery('viewer-a', 'erase this');
  rememberSearchQuery('viewer-b', 'keep this');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  })));

  await reconcileAccountSessionChange(queryClient, {
    id: 'logout-1',
    reason: 'logout'
  });

  expect(queryClient.getQueryData(browserSessionQueryKey)).toBeNull();
  expect(readSearchHistory('viewer-a')).toEqual([]);
  expect(readSearchHistory('viewer-b')).toEqual(['keep this']);
});

test('a cross-tab event makes the previous identity non-drawable before the handler yields', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(browserSessionQueryKey, sessionFor('viewer-a'));
  let finishSession!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    finishSession = resolve;
  })));
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CurrentIdentity)
    ),
    { container: root }
  );
  expect(screen.getByText('viewer-a')).toBeVisible();
  const unsubscribe = startBrowserSessionCoordinator(queryClient);

  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', {
      key: accountSessionChangeStorageKey,
      newValue: JSON.stringify({ id: 'dom-privacy-switch', reason: 'login' })
    }));
    expect(root).toHaveAttribute('data-account-transitioning', 'true');
    expect(window.getComputedStyle(root).display).toBe('none');
    expect(window.getComputedStyle(screen.getByTestId('current-identity')).visibility).toBe('visible');
    expect(screen.getByTestId('current-identity')).not.toBeVisible();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  expect(queryClient.getQueryData(browserSessionQueryKey)).toBeNull();

  await vi.waitFor(() => expect(finishSession).toBeTypeOf('function'));
  await act(async () => {
    finishSession(sessionResponse(sessionFor('viewer-b')));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('viewer-b')).toBeInTheDocument());
  await waitFor(() => expect(root).not.toHaveAttribute('data-account-transitioning'));
  unsubscribe();
});

test('Content Manager logout completion clears only its viewer history and publishes no identity', () => {
  rememberSearchQuery('viewer-a', 'clear me');
  rememberSearchQuery('viewer-b', 'keep me');
  window.sessionStorage.setItem('finitude:pending-logout-viewer', 'viewer-a');
  window.history.replaceState({}, '', '/finitude?sessionTransition=logout');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const unsubscribe = startBrowserSessionCoordinator(queryClient);

  expect(window.location.search).toBe('');
  expect(readSearchHistory('viewer-a')).toEqual([]);
  expect(readSearchHistory('viewer-b')).toEqual(['keep me']);
  const published = JSON.parse(window.localStorage.getItem(accountSessionChangeStorageKey) ?? '{}');
  expect(published).toMatchObject({ reason: 'logout' });
  expect(published).not.toHaveProperty('viewerId');
  unsubscribe();
});
