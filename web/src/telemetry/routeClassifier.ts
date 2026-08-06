import type {
  ListenerRouteName,
  ListenerTelemetryEvent,
  TelemetryStatusBucket
} from './contracts';

const authRoutes = new Set([
  'login',
  'register',
  'verify-email',
  'forgot-password',
  'reset-password'
]);

/** Reduces dynamic listener paths to a fixed privacy-safe route dimension. */
export const classifyListenerRoute = (pathname: string): ListenerRouteName => {
  const path = pathname.split('?', 1)[0].replace(/^\/finitude\/?/, '').replace(/^\/+|\/+$/g, '');
  const [first] = path.split('/');
  if (!first) return 'home';
  if (first === 'search' || first === 'library' || first === 'account') return first;
  if (first === 'playlists') return path.split('/').length > 1 ? 'playlist' : 'playlists';
  if (first === 'albums') return 'album';
  if (first === 'artists') return 'artist';
  if (authRoutes.has(first)) return 'auth';
  return 'other';
};

export const statusBucket = (status?: number): TelemetryStatusBucket => {
  if (!Number.isFinite(status)) return 'none';
  switch (status) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 409:
    case 428:
    case 422:
    case 429:
      return String(status) as TelemetryStatusBucket;
    default:
      break;
  }
  if (status! >= 500 && status! < 600) return '5xx';
  return 'other';
};

/** Maps request paths without retaining query text, identifiers, or credentials. */
export const classifyApiOperation = (
  rawPath: string,
  method = 'GET'
): Extract<ListenerTelemetryEvent, { category: 'api_error' }>['operation'] | null => {
  const path = rawPath.split('?', 1)[0];
  // Authentication and account endpoints use a separate, deliberately bounded funnel contract.
  if (path === '/auth' || path.startsWith('/auth/')) return null;
  if (path === '/api/listener/v1/capabilities') return 'listener_capabilities';
  if (path === '/api/listener/v1/home') return 'listener_home';
  if (path === '/api/listener/v1/search') return 'listener_search';
  if (path === '/api/listener/v1/library') return 'listener_library';
  if (path.startsWith('/api/listener/v1/albums/')) return 'listener_album';
  if (path.startsWith('/api/listener/v1/artists/')) return 'listener_artist';
  if (path.startsWith('/api/listener/v1/tracks/')) return 'listener_track';
  if (path === '/content/me/saves/status') return 'save_status';
  if (path.startsWith('/content/me/saves/')) {
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod === 'PUT') return 'save';
    if (normalizedMethod === 'DELETE') return 'unsave';
    return null;
  }
  if (path.startsWith('/content/me/recently-played')
    || path.startsWith('/content/me/listening-history')) return 'recent_activity';
  if (path === '/content/me/playlists') {
    if (method.toUpperCase() === 'GET') return 'playlist_list';
    if (method.toUpperCase() === 'POST') return 'playlist_create';
    return null;
  }
  if (path === '/content/me/playlists/memberships' && method.toUpperCase() === 'GET') {
    return 'playlist_memberships';
  }
  if (path.startsWith('/content/me/playlists/')) {
    const normalizedMethod = method.toUpperCase();
    if (path.endsWith('/items/order') && normalizedMethod === 'PUT') return 'playlist_reorder';
    if (/\/items\/[^/]+$/.test(path) && normalizedMethod === 'DELETE') return 'playlist_remove';
    if (path.endsWith('/items') && normalizedMethod === 'POST') return 'playlist_add';
    if (normalizedMethod === 'GET') return 'playlist_detail';
    if (normalizedMethod === 'PATCH') return 'playlist_rename';
    if (normalizedMethod === 'DELETE') return 'playlist_delete';
  }
  return null;
};
