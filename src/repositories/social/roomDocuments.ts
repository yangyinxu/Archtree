import type { RoomCommunityEvent, RoomReaction } from '../../contracts/roomV1';

/** Durable private room membership; account/session identities never leave the projection boundary. */
export interface RoomMemberDocument {
    membershipId: string;
    accountId: string;
    socialId: string;
    controllerSessionId: string;
    controllerClientId: string;
    controllerGeneration: number;
    joinedAt: Date;
    lastSeenAt: Date;
    locallyPaused: boolean;
    connectionPresent: boolean;
    readyPlaybackGeneration?: number;
    readyReportPlaybackGeneration?: number;
    readyReportSequence?: number;
}

/** One independent queue occurrence resolved to an exact, ready on-demand representation. */
export interface RoomQueueEntryDocument {
    entryId: string;
    mediaTrackId: string;
    mediaRevision: string;
    durationMs: number;
    title: string;
    streamUrl: string;
    mediaType: 'Audio';
    unavailable?: boolean;
    requesterMembershipId?: string;
}

/** Pending recommendations belong to a member incarnation and an exact eligible media revision. */
export interface RoomSongRequestDocument {
    requestId: string;
    requesterMembershipId: string;
    mediaTrackId: string;
    mediaRevision: string;
    title: string;
    createdAt: Date;
}

/** Short notices retain only the current member incarnation, never historical profile data. */
export interface RoomEventDocument {
    eventId: string;
    kind: RoomCommunityEvent['kind'];
    actorMembershipId: string | null;
    reaction: RoomReaction | null;
    createdAt: Date;
    expiresAt: Date;
}

/** A persisted readiness barrier is recoverable without retaining historical socket events. */
export interface RoomPreparationDocument {
    preparationId: string;
    playbackGeneration: number;
    entryId: string;
    mediaRevision: string;
    targetPositionMs: number;
    deadlineAt: Date;
    cohort: Array<{ membershipId: string; controllerGeneration: number; reportSequence: number; ready: boolean }>;
}

/** Host transfer requires one exact target controller's consent before the bounded deadline. */
export interface RoomTransferDocument {
    offerId: string;
    hostMembershipId: string;
    controlGeneration: number;
    targetMembershipId: string;
    targetControllerGeneration: number;
    expiresAt: Date;
}

/** One bounded aggregate serializes playback, permissions, membership and host lifecycle. */
export interface RoomDocument {
    _id: string;
    state: 'open' | 'closed';
    epoch: number;
    revision: number;
    hostMembershipId: string;
    controlMode: 'hostOnly' | 'everyone';
    controlGeneration: number;
    queueRevision: number;
    playbackGeneration: number;
    members: RoomMemberDocument[];
    queue: RoomQueueEntryDocument[];
    songRequests?: RoomSongRequestDocument[];
    events?: RoomEventDocument[];
    reactionMinute?: number;
    reactions?: number;
    /** Serializes current-listening reports with room pause/controller changes without changing public versions. */
    listeningPublicationFence?: number;
    timeline: { entryId: string; state: 'paused' | 'preparing' | 'playing' | 'ended'; positionMs: number; anchorServerTimeMs: number };
    preparation: RoomPreparationDocument | null;
    transfer: RoomTransferDocument | null;
    hostAbsentSince: Date | null;
    hostSuspended: boolean;
    createdAt: Date;
    expiresAt: Date;
    closedAt?: Date;
}

/** Its account primary key enforces one joined room across concurrent admission attempts. */
export interface RoomParticipationDocument { _id: string; roomId: string; membershipId: string }

/** A unique room/recipient row replaces offers without allowing an old invitation incarnation to join. */
export interface RoomInvitationDocument {
    _id: string;
    invitationId: string;
    roomId: string;
    senderAccountId: string;
    recipientAccountId: string;
    generation: number;
    state: 'pending' | 'accepted' | 'cancelled';
    createdAt: Date;
    expiresAt: Date;
}

/** Coalesced delivery work stores only authority identity and revision, never a room snapshot. */
export interface RoomOutboxDocument { _id: string; roomId: string; epoch: number; revision: number; updatedAt: Date }
