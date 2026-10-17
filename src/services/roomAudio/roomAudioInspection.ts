import { decodeRoomAudio, RoomAudioInspectionError } from './roomAudioInspectionDecoder';
import { inspectRoomMp3 } from './roomAudioInspectionMp3';
import { inspectRoomMp4 } from './roomAudioInspectionMp4';
import { boundedDuration, InvalidRoomAudio, maximumRoomAudioBytes, RoomAudioReader } from './roomAudioInspectionReader';

export { RoomAudioInspectionError } from './roomAudioInspectionDecoder';
export type { RoomAudioInspectionErrorCode } from './roomAudioInspectionDecoder';
export type RoomAudioFormat = 'wav-pcm' | 'mp3' | 'm4a-aac';
/** Duration and format are private evidence for one exact source, never an identity of their own. */
export interface RoomAudioInspection { durationMs: number; format: RoomAudioFormat }

/** PCM has no compressed payload to decode: exact aligned RIFF framing proves its sample timeline. */
const inspectWav = async (reader: RoomAudioReader): Promise<number> => {
    const header = await reader.read(0, 12);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE'
        || header.readUInt32LE(4) + 8 !== reader.size) throw new InvalidRoomAudio();
    let offset = 12; let byteRate: number | undefined; let blockAlign: number | undefined; let dataSize: number | undefined;
    for (let chunks = 0; offset < reader.size && chunks < 64; chunks += 1) {
        const chunk = await reader.read(offset, 8); const kind = chunk.toString('ascii', 0, 4); const size = chunk.readUInt32LE(4);
        const next = offset + 8 + size + (size % 2);
        if (next > reader.size) throw new InvalidRoomAudio();
        if (kind === 'fmt ') {
            if (byteRate !== undefined || (size !== 16 && size !== 18)) throw new InvalidRoomAudio();
            const format = await reader.read(offset + 8, size); const channels = format.readUInt16LE(2); const sampleRate = format.readUInt32LE(4);
            blockAlign = format.readUInt16LE(12); byteRate = format.readUInt32LE(8);
            if (format.readUInt16LE(0) !== 1 || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 48000
                || format.readUInt16LE(14) !== 16 || blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign
                || (size === 18 && format.readUInt16LE(16) !== 0)) throw new InvalidRoomAudio();
        } else if (kind === 'data') {
            if (dataSize !== undefined || !byteRate || !blockAlign || !size || size % blockAlign !== 0) throw new InvalidRoomAudio();
            dataSize = size;
        }
        offset = next;
    }
    if (offset !== reader.size || !dataSize || !byteRate) throw new InvalidRoomAudio();
    return boundedDuration(dataSize / byteRate * 1000);
};

/** Unsupported bytes return null; infrastructure errors and cancellation stay distinguishable for explicit retry. */
export const inspectRoomAudioFile = async (
    file: Pick<Express.Multer.File, 'size' | 'path' | 'buffer'>,
    options: { signal?: AbortSignal } = {}
): Promise<RoomAudioInspection | null> => {
    let reader: RoomAudioReader | undefined;
    try {
        reader = await RoomAudioReader.create(file, options.signal);
        const prefix = await reader.read(0, 12);
        let result: RoomAudioInspection;
        if (prefix.toString('ascii', 0, 4) === 'RIFF') result = { durationMs: await inspectWav(reader), format: 'wav-pcm' };
        else {
            if (file.size > maximumRoomAudioBytes) throw new InvalidRoomAudio();
            if (prefix.toString('ascii', 4, 8) === 'ftyp') result = { durationMs: await inspectRoomMp4(reader), format: 'm4a-aac' };
            else if (prefix.toString('ascii', 0, 3) === 'ID3' || (prefix[0] === 255 && (prefix[1] & 224) === 224)) {
                result = { durationMs: await inspectRoomMp3(reader), format: 'mp3' };
            } else throw new InvalidRoomAudio();
            await decodeRoomAudio(file, result.format as 'mp3' | 'm4a-aac', result.durationMs, options.signal);
        }
        await reader.verifyUnchanged();
        return result;
    } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof RoomAudioInspectionError) throw error;
        if (error instanceof InvalidRoomAudio || error instanceof RangeError) return null;
        throw new RoomAudioInspectionError('analysis_failed');
    } finally { await reader?.close(); }
};
