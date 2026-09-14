import { exactSocialKeys, isSocialId, isSocialRevision, type SocialActor, type SocialCard, type SocialMutationIdentity, type SocialOutcome } from './socialV1';

/** Audio-first room contract; these additive DTOs never change listener-v1 or expose account/session IDs. */
export const ROOM_LIMITS = Object.freeze({ members: 8, queue: 100, invitations: 20, activeRooms: 100,
    songRequests: 20, songRequestsPerMember: 5, events: 20, eventMs: 30_000,
    reactionsPerAccountMinute: 12, reactionsPerRoomMinute: 60,
    preparationMs: 3_000, startLeadMs: 350, hostGraceMs: 30_000, hostCloseMs: 300_000,
    transferMs: 30_000, invitationMs: 86_400_000, snapshotBytes: 65_536, commandBytes: 16_384 });
export type RoomControlMode = 'hostOnly' | 'everyone';
/** Per-tab identity distinguishes controllers even when browser tabs share the same login session. */
export interface RoomActor extends SocialActor { clientId: string }
export interface RoomMediaDescriptor {
    mediaTrackId: string; title: string; mediaRevision: string; durationMs: number;
    streamUrl: string; mediaType: 'Audio';
}
export interface RoomQueueEntry extends RoomMediaDescriptor { entryId: string }
export interface RoomTimeline {
    playbackGeneration: number; entryId: string; mediaRevision: string; durationMs: number;
    state: 'preparing' | 'paused' | 'playing' | 'ended'; positionMs: number; anchorServerTimeMs: number;
}
export interface RoomPreparation {
    preparationId: string; playbackGeneration: number; entryId: string; mediaRevision: string;
    targetPositionMs: number; deadlineServerTimeMs: number; cohortMembershipIds: string[];
}
export interface RoomMember extends SocialCard {
    memberId: string; role: 'host' | 'guest'; controllerGeneration: number; connected: boolean; ready: boolean;
}
export interface RoomTransferOffer {
    offerId: string; targetMemberId: string; targetControllerGeneration: number; expiresAtMs: number;
}
/** Complete viewer-authorized state: HTTP and WebSocket use the exact same projection. */
export interface RoomSnapshot {
    protocolVersion: 1; roomId: string; epoch: number; revision: number; serverTimeMs: number;
    status: 'open' | 'suspended' | 'ended'; controlMode: RoomControlMode; controlGeneration: number;
    hostMemberId: string; hostAbsenceDeadlineMs: number | null; queueRevision: number;
    queue: RoomQueueEntry[]; timeline: RoomTimeline | null; preparation: RoomPreparation | null;
    members: RoomMember[];
    self: { memberId: string; controllerGeneration: number; isController: boolean; canControl: boolean };
    transferOffer: RoomTransferOffer | null;
}
export interface RoomInvitation {
    invitationId: string; generation: number; inviter: SocialCard; expiresAtMs: number;
}
/** Host-only link metadata identifies the selected recipient without exposing their private account. */
export interface RoomOutgoingInvitation {
    invitationId: string; generation: number; recipientSocialId: string; expiresAtMs: number;
}
/** Pending recommendations expose only ready catalog metadata and the current member's public social card. */
export interface RoomSongRequest {
    requestId: string; mediaTrackId: string; title: string; requestedBy: SocialCard; createdAtMs: number;
}
export const ROOM_REACTIONS = ['heart', 'clap', 'fire', 'smile', 'music'] as const;
export type RoomReaction = typeof ROOM_REACTIONS[number];
/** Brief room-local events resolve current members; null actors are reserved for automatic advancement. */
export interface RoomCommunityEvent {
    eventId: string; kind: 'joined' | 'trackChanged' | 'hostChanged' | 'modeChanged' | 'reaction';
    actor: SocialCard | null; reaction: RoomReaction | null; createdAtMs: number; expiresAtMs: number;
}
/** Separate read model preserves strict room-v1 playback snapshots for already-open clients. */
export interface RoomCommunity {
    roomId: string; epoch: number; revision: number;
    requests: RoomSongRequest[];
    queueCredits: Array<{ entryId: string; requestedBy: SocialCard | null }>;
    events: RoomCommunityEvent[];
}
/** Membership incarnation fences deny-only actions without requiring a fresh room revision. */
export interface RoomMemberCommand extends SocialMutationIdentity { roomId: string; memberId: string }
export interface RoomControlCommand extends RoomMemberCommand {
    expectedEpoch: number; controllerGeneration: number; expectedControlGeneration: number;
    expectedPlaybackGeneration: number; expectedQueueRevision: number; expectedEntryId: string;
}
export type RoomCommand =
    | (SocialMutationIdentity & { action: 'create'; mediaTrackIds: string[] })
    | (SocialMutationIdentity & { action: 'acceptInvitation' | 'declineInvitation'; invitationId: string; generation: number })
    | (RoomMemberCommand & { action: 'leave' | 'end' | 'takeControl' })
    | (RoomMemberCommand & { action: 'invite'; targetSocialId: string })
    | (RoomMemberCommand & { action: 'requestSong'; expectedEpoch: number; mediaTrackId: string })
    | (RoomMemberCommand & { action: 'react'; expectedEpoch: number; reaction: RoomReaction })
    | (RoomMemberCommand & { action: 'dismissSongRequest'; requestId: string })
    | (RoomMemberCommand & { action: 'kick'; targetMemberId: string })
    | (RoomMemberCommand & { action: 'offerTransfer'; expectedControlGeneration: number; targetMemberId: string; targetControllerGeneration: number })
    | (RoomMemberCommand & { action: 'acceptTransfer' | 'cancelTransfer'; offerId: string })
    | (RoomControlCommand & { action: 'next' | 'previous' | 'play' | 'pause' })
    | (RoomControlCommand & { action: 'seek'; positionMs: number })
    | (RoomControlCommand & { action: 'select'; targetEntryId: string })
    | (RoomControlCommand & { action: 'acceptSongRequest'; requestId: string })
    | (RoomControlCommand & { action: 'removeQueueEntry'; targetEntryId: string })
    | (RoomControlCommand & { action: 'reorderQueue'; entryIds: string[] })
    | (RoomControlCommand & { action: 'setControlMode'; mode: RoomControlMode });
export interface RoomReadyReport {
    roomId: string; memberId: string; controllerGeneration: number; expectedEpoch: number;
    preparationId: string; playbackGeneration: number; entryId: string; mediaRevision: string;
    sequence: number; ready: boolean;
}
export interface RoomHeartbeat {
    roomId: string; memberId: string; controllerGeneration: number; locallyPaused: boolean;
}
/** Status-only outcomes use the same mutation scopes as social operations, with a namespaced digest. */
export interface RoomApi {
    currentRoom(actor: RoomActor): Promise<RoomSnapshot | null>;
    room(actor: RoomActor, roomId: string): Promise<RoomSnapshot | null>;
    invitations(actor: RoomActor): Promise<RoomInvitation[]>;
    invitation(actor: RoomActor, invitationId: string): Promise<RoomInvitation | null>;
    outgoingInvitations(actor: RoomActor, roomId: string): Promise<RoomOutgoingInvitation[]>;
    community(actor: RoomActor, roomId: string): Promise<RoomCommunity>;
    eligibleMedia(actor: RoomActor): Promise<RoomMediaDescriptor[]>;
    mutate(actor: RoomActor, command: RoomCommand): Promise<SocialOutcome>;
    heartbeat(actor: RoomActor, report: RoomHeartbeat): Promise<void>;
    /** Gateway calls this only for the final, generation-current socket of this exact client. */
    disconnected(actor: RoomActor): Promise<void>;
    ready(actor: RoomActor, report: RoomReadyReport): Promise<void>;
    /** Timers operate using server authority, never an impersonated listener session. */
    sweep(): Promise<void>;
}

export const isRoomIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export const isRoomClientId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
const positive = (value: unknown) => isSocialRevision(value) && Number(value) > 0;
const identity = ['scopeToken', 'commandId', 'action'];
const member = [...identity, 'roomId', 'memberId'];
const control = [...member, 'expectedEpoch', 'controllerGeneration', 'expectedControlGeneration',
    'expectedPlaybackGeneration', 'expectedQueueRevision', 'expectedEntryId'];

/** Copies and freezes the observed versions once, before any async validation or transaction retry. */
export const parseRoomCommand = (input: unknown): RoomCommand | null => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const value = input as Record<string, unknown>;
    if (typeof value.scopeToken !== 'string' || value.scopeToken.length < 20 || value.scopeToken.length > 1_024
        || !isRoomClientId(value.commandId) || typeof value.action !== 'string') return null;
    let keys: string[];
    if (value.action === 'create') {
        keys = [...identity, 'mediaTrackIds'];
        if (!Array.isArray(value.mediaTrackIds) || !value.mediaTrackIds.length || value.mediaTrackIds.length > ROOM_LIMITS.queue
            || !value.mediaTrackIds.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))) return null;
    } else if (value.action === 'acceptInvitation' || value.action === 'declineInvitation') {
        keys = [...identity, 'invitationId', 'generation'];
        if (!isRoomIdentifier(value.invitationId) || !positive(value.generation)) return null;
    } else {
        if (!isRoomIdentifier(value.roomId) || !isRoomIdentifier(value.memberId)) return null;
        if (['leave', 'end', 'takeControl'].includes(value.action)) keys = member;
        else if (value.action === 'invite') {
            keys = [...member, 'targetSocialId']; if (!isSocialId(value.targetSocialId)) return null;
        } else if (value.action === 'requestSong') {
            keys = [...member, 'expectedEpoch', 'mediaTrackId'];
            if (!positive(value.expectedEpoch) || typeof value.mediaTrackId !== 'string' || !/^[a-f0-9]{24}$/.test(value.mediaTrackId)) return null;
        } else if (value.action === 'react') {
            keys = [...member, 'expectedEpoch', 'reaction'];
            if (!positive(value.expectedEpoch) || !ROOM_REACTIONS.includes(value.reaction as RoomReaction)) return null;
        } else if (value.action === 'dismissSongRequest') {
            keys = [...member, 'requestId']; if (!isRoomIdentifier(value.requestId)) return null;
        } else if (value.action === 'kick') {
            keys = [...member, 'targetMemberId']; if (!isRoomIdentifier(value.targetMemberId)) return null;
        } else if (value.action === 'offerTransfer') {
            keys = [...member, 'expectedControlGeneration', 'targetMemberId', 'targetControllerGeneration'];
            if (!positive(value.expectedControlGeneration) || !positive(value.targetControllerGeneration) || !isRoomIdentifier(value.targetMemberId)) return null;
        } else if (value.action === 'acceptTransfer' || value.action === 'cancelTransfer') {
            keys = [...member, 'offerId']; if (!isRoomIdentifier(value.offerId)) return null;
        } else {
            if (!['expectedEpoch', 'controllerGeneration', 'expectedControlGeneration', 'expectedPlaybackGeneration', 'expectedQueueRevision']
                .every(key => positive(value[key])) || !isRoomIdentifier(value.expectedEntryId)) return null;
            if (['next', 'previous', 'play', 'pause'].includes(value.action)) keys = control;
            else if (value.action === 'seek') {
                keys = [...control, 'positionMs']; if (!isSocialRevision(value.positionMs) || Number(value.positionMs) > 86_400_000) return null;
            } else if (value.action === 'select' || value.action === 'removeQueueEntry') {
                keys = [...control, 'targetEntryId']; if (!isRoomIdentifier(value.targetEntryId)) return null;
            } else if (value.action === 'acceptSongRequest') {
                keys = [...control, 'requestId']; if (!isRoomIdentifier(value.requestId)) return null;
            } else if (value.action === 'reorderQueue') {
                keys = [...control, 'entryIds'];
                if (!Array.isArray(value.entryIds) || !value.entryIds.length || value.entryIds.length > ROOM_LIMITS.queue
                    || !value.entryIds.every(isRoomIdentifier) || new Set(value.entryIds).size !== value.entryIds.length) return null;
            } else if (value.action === 'setControlMode') {
                keys = [...control, 'mode']; if (value.mode !== 'hostOnly' && value.mode !== 'everyone') return null;
            } else return null;
        }
    }
    if (!exactSocialKeys(value, keys)) return null;
    return Object.freeze({ ...value, ...(Array.isArray(value.mediaTrackIds) ? { mediaTrackIds: Object.freeze([...value.mediaTrackIds]) } : {}),
        ...(Array.isArray(value.entryIds) ? { entryIds: Object.freeze([...value.entryIds]) } : {}) }) as unknown as RoomCommand;
};

export const parseRoomReady = (value: unknown): RoomReadyReport | null => {
    if (!exactSocialKeys(value, ['roomId', 'memberId', 'controllerGeneration', 'expectedEpoch', 'preparationId',
        'playbackGeneration', 'entryId', 'mediaRevision', 'sequence', 'ready'])
        || !['roomId', 'memberId', 'preparationId', 'entryId', 'mediaRevision'].every(key => isRoomIdentifier(value[key]))
        || !['controllerGeneration', 'expectedEpoch', 'playbackGeneration', 'sequence'].every(key => positive(value[key]))
        || typeof value.ready !== 'boolean') return null;
    return Object.freeze({ ...value }) as unknown as RoomReadyReport;
};
export const parseRoomHeartbeat = (value: unknown): RoomHeartbeat | null => {
    if (!exactSocialKeys(value, ['roomId', 'memberId', 'controllerGeneration', 'locallyPaused'])
        || !isRoomIdentifier(value.roomId) || !isRoomIdentifier(value.memberId)
        || !positive(value.controllerGeneration) || typeof value.locallyPaused !== 'boolean') return null;
    return Object.freeze({ ...value }) as unknown as RoomHeartbeat;
};
