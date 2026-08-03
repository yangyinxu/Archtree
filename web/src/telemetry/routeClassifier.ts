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
  const path = pathname.split('?', 1)[0].replace(/^\/listen\/?/, '').replace(/^\/+|\/+$/g, '');
  const [first] = path.split('/');
  if (!first) return 'home';
  if (first === 'search' || first === 'library' || first === 'account') return first;
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
  return null;
};
