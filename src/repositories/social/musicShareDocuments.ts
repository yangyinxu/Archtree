import type { SharedMusicType } from '../../contracts/socialMusicV1';

/** One private share incarnation retains catalog identity, never a historical profile or media URL. */
export interface MusicShareDocument {
    _id: string;
    senderAccountId: string;
    recipientAccountId: string;
    accountIds: string[];
    contentType: SharedMusicType;
    contentId: string;
    createdAt: Date;
    expiresAt: Date;
}
