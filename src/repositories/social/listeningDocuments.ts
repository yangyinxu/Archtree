import type { ListeningPlayback } from '../../contracts/listeningV1';

/** Owner clocks survive TTL expiry and prevent old claims or reports from regaining authority. */
export interface ListeningStateDocument {
    _id: string;
    accountId: string;
    enabled: boolean;
    revision: number;
    publisherRevision: number;
    updatedAt: Date;
}

/** A single short claim retains private source/occurrence fences, never a public activity history. */
export interface ListeningPublicationDocument {
    _id: string;
    accountId: string;
    sessionId: string;
    clientId: string;
    publicationId: string;
    preferenceRevision: number;
    publisherRevision: number;
    sequence: number;
    playbackSequence: number;
    blockedOccurrenceId: string | null;
    playback: ListeningPlayback | null;
    sourceFingerprint: string | null;
    observedAtMs: number;
    acceptedAtMs: number;
    visible: boolean;
    expiresAt: Date;
}
