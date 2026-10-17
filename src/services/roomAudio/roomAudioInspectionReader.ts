import { open, stat, type FileHandle } from 'node:fs/promises';

export const maximumRoomAudioBytes = 512 * 1024 * 1024;
export const maximumRoomAudioDurationMs = 86_400_000;

/** Malformed and unsupported files are definitive ineligibility, distinct from retryable execution failures. */
export class InvalidRoomAudio extends Error {}

/** Small cached reads bound allocation while validating offsets throughout a complete local file. */
export class RoomAudioReader {
    private cache = Buffer.alloc(0);
    private cacheOffset = 0;
    private constructor(
        readonly size: number,
        private readonly buffer: Buffer | undefined,
        private readonly handle: FileHandle | undefined,
        private readonly identity: { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number } | undefined,
        private readonly path: string | undefined,
        readonly signal?: AbortSignal
    ) {}

    /** Captures local file identity and rejects declared lengths that differ from the actual source. */
    static async create(file: Pick<Express.Multer.File, 'size' | 'path' | 'buffer'>, signal?: AbortSignal) {
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(file.size) || file.size < 12 || file.size > 0xffffffff) throw new InvalidRoomAudio();
        if (file.path) {
            const handle = await open(file.path, 'r');
            try {
                const identity = await handle.stat();
                if (!identity.isFile() || identity.size !== file.size) throw new InvalidRoomAudio();
                return new RoomAudioReader(file.size, undefined, handle, identity, file.path, signal);
            } catch (error) { await handle.close(); throw error; }
        }
        if (!Buffer.isBuffer(file.buffer) || file.buffer.length !== file.size) throw new InvalidRoomAudio();
        return new RoomAudioReader(file.size, file.buffer, undefined, undefined, undefined, signal);
    }

    /** Bounds each allocation and completes partial filesystem reads before returning evidence. */
    async read(offset: number, length: number): Promise<Buffer> {
        this.signal?.throwIfAborted();
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
            || length > 32 * 1024 * 1024 || offset + length > this.size) throw new InvalidRoomAudio();
        if (this.buffer) return this.buffer.subarray(offset, offset + length);
        if (offset >= this.cacheOffset && offset + length <= this.cacheOffset + this.cache.length) {
            return this.cache.subarray(offset - this.cacheOffset, offset - this.cacheOffset + length);
        }
        const data = Buffer.alloc(Math.min(Math.max(length, 64 * 1024), this.size - offset));
        let received = 0;
        while (received < data.length) {
            this.signal?.throwIfAborted();
            const result = await this.handle!.read(data, received, data.length - received, offset + received);
            if (!result.bytesRead) throw new InvalidRoomAudio();
            received += result.bytesRead;
        }
        this.cache = data; this.cacheOffset = offset;
        return data.subarray(0, length);
    }

    /** A file replaced or edited while its decoder ran cannot publish evidence from mixed sources. */
    async verifyUnchanged() {
        if (this.handle) {
            const current = await this.handle.stat();
            const named = await stat(this.path!);
            if (named.dev !== this.identity!.dev || named.ino !== this.identity!.ino) throw new InvalidRoomAudio();
            if (current.size !== this.identity!.size || current.mtimeMs !== this.identity!.mtimeMs
                || current.ctimeMs !== this.identity!.ctimeMs) throw new InvalidRoomAudio();
        }
    }

    /** Releases the inspector-owned handle without removing the upload's source file. */
    async close() { await this.handle?.close(); }
}

/** A finite positive timeline remains within the existing room lifetime bound. */
export const boundedDuration = (milliseconds: number) => {
    const result = Math.round(milliseconds);
    if (!Number.isSafeInteger(result) || result <= 0 || result > maximumRoomAudioDurationMs) throw new InvalidRoomAudio();
    return result;
};
