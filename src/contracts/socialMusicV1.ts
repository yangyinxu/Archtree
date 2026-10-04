import type { SocialCard } from './socialV1';

/** Private direct shares reference current public catalog identities, never a Playlist or stored media URL. */
export const MUSIC_SHARE_LIMITS = Object.freeze({ incoming: 100, outgoing: 100, incomingPerDay: 50,
    retentionMs: 30 * 86_400_000, page: 20, maximumPage: 50 });
export type MusicShareDirection = 'incoming' | 'outgoing';
export type SharedMusicType = 'audioTrack' | 'album';
export interface SharedMusicContent {
    id: string; contentType: SharedMusicType; title: string; artworkUrl: string; artistNames: string[];
}
/** Current authorization and catalog visibility are re-evaluated for every inbox read. */
export interface MusicShareItem {
    shareId: string; peer: SocialCard; contentType: SharedMusicType; contentId: string;
    content: SharedMusicContent | null; createdAtMs: number; expiresAtMs: number;
}
export interface MusicSharePage { items: MusicShareItem[]; nextCursor: string | null }
export type MusicShareAction =
    | { action: 'shareMusic'; targetSocialId: string; expectedRevision: number; contentType: SharedMusicType; contentId: string }
    | { action: 'dismissMusicShare'; shareId: string }
    | { action: 'withdrawMusicShare'; shareId: string };
/** An opaque incarnation prevents an old dismissal from affecting a later share of the same music. */
export const isMusicShareId = (value: unknown): value is string => typeof value === 'string' && /^ms_[a-f0-9]{32}$/.test(value);
