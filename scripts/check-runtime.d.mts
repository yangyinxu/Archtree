/** Shared runtime checks are imported by typed disposable test harnesses as well as CLI commands. */
export function assertNodeRuntime(version?: string): void;
export function assertMongoRuntime(binary?: string): string;
export function assertRoomAudioRuntime(binary?: string): string;
export function assertLinuxRuntime(platform?: NodeJS.Platform): void;
