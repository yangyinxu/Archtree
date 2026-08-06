export const listenerRouteNames = [
  'home',
  'search',
  'library',
  'playlists',
  'playlist',
  'album',
  'artist',
  'account',
  'auth',
  'not_found',
  'other'
] as const;

export type ListenerRouteName = typeof listenerRouteNames[number];
export type TelemetryStatusBucket =
  | 'none'
  | '400'
  | '401'
  | '403'
  | '404'
  | '409'
  | '428'
  | '422'
  | '429'
  | '5xx'
  | 'other';

export type ListenerTelemetryEvent =
  | {
      category: 'web_vital';
      metric: 'LCP' | 'CLS' | 'INP';
      value: number;
      route: ListenerRouteName;
      navigationType: 'navigate' | 'reload' | 'back_forward' | 'prerender' | 'unknown';
    }
  | {
      category: 'route_error';
      route: ListenerRouteName;
      kind: 'render' | 'route_response' | 'lazy_chunk' | 'unknown';
      statusBucket: TelemetryStatusBucket;
    }
  | {
      category: 'api_error';
      operation:
        | 'listener_capabilities'
        | 'listener_home'
        | 'listener_search'
        | 'listener_library'
        | 'listener_album'
        | 'listener_artist'
        | 'listener_track'
        | 'save_status'
        | 'save'
        | 'unsave'
        | 'recent_activity'
        | 'playlist_list'
        | 'playlist_memberships'
        | 'playlist_detail'
        | 'playlist_create'
        | 'playlist_rename'
        | 'playlist_delete'
        | 'playlist_add'
        | 'playlist_remove'
        | 'playlist_reorder';
      kind: 'http' | 'network' | 'invalid_response';
      statusBucket: TelemetryStatusBucket;
      route: ListenerRouteName;
      attempt: 'initial' | 'after_refresh';
    }
  | {
      category: 'playback_error';
      route: ListenerRouteName;
      stage: 'audio_create' | 'source_set' | 'play_call' | 'media_element';
      code: 'autoplayBlocked' | 'network' | 'decode' | 'streamUnavailable' | 'unknown';
    };

export interface ListenerTelemetryBatch {
  events: ListenerTelemetryEvent[];
}
