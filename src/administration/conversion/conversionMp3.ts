import { createHash } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { readAudioMetadata } from '../../services/audio/audioMetadataService';
import { decodeRoomAudio, RoomAudioInspectionError } from '../../services/roomAudio/roomAudioInspectionDecoder';
import { inspectRoomMp3 } from '../../services/roomAudio/roomAudioInspectionMp3';
import { RoomAudioReader } from '../../services/roomAudio/roomAudioInspectionReader';
import { CONVERSION_MAX_BYTES, conversionFail, type ConversionOutput } from './conversionContract';

export interface ConversionMp3Metadata { durationMs: number; sampleRate: 44100 | 48000; channels: 1 | 2 }

/** Walk the already structurally checked stream to require the disclosed 320 kbps CBR profile. */
async function validatePreset(reader: RoomAudioReader, sampleRate: number, channels: number) {
    const tag = await reader.read(0, 10); let start = 0, end = reader.size;
    if (tag.toString('ascii', 0, 3) === 'ID3') {
        start = 10 + tag[6] * 2097152 + tag[7] * 16384 + tag[8] * 128 + tag[9];
        if (tag[3] === 4 && (tag[5] & 16)) start += 10;
    }
    if (end - start >= 128 && (await reader.read(end - 128, 3)).toString('ascii') === 'TAG') end -= 128;
    let offset = start, count = 0;
    while (offset < end) {
        const header = await reader.read(offset, 4), actualRate = [44100, 48000, 32000][(header[2] >> 2) & 3];
        if (++count > 4_100_000 || ((header[1] >> 3) & 3) !== 3 || ((header[1] >> 1) & 3) !== 1
            || actualRate !== sampleRate || ((header[3] >> 6) === 3 ? 1 : 2) !== channels) return conversionFail(400, 'ADMIN_CONVERSION_INVALID_MP3');
        const bitrateIndex = header[2] >> 4, length = Math.floor(144 * [0, 32000, 40000, 48000, 56000, 64000, 80000, 96000, 112000, 128000, 160000, 192000, 224000, 256000, 320000][bitrateIndex] / actualRate) + ((header[2] >> 1) & 1);
        // A Xing/Info metadata frame can use a different bitrate; every actual Audio frame must be 320 kbps.
        const side = channels === 1 ? 17 : 32, markerOffset = 4 + ((header[1] & 1) ? 0 : 2) + side;
        const marker = count === 1 ? (await reader.read(offset, length)).toString('ascii', markerOffset, markerOffset + 4) : '';
        if (bitrateIndex !== 14 && !['Info', 'Xing'].includes(marker)) return conversionFail(400, 'ADMIN_CONVERSION_INVALID_MP3');
        offset += length;
    }
}

/** Validates every frame, complete decoding, file identity and hash before any storage reservation or PUT. */
export async function validateConversionMp3(file: Express.Multer.File, expected: ConversionOutput, signal?: AbortSignal): Promise<ConversionMp3Metadata> {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 12 || file.size > CONVERSION_MAX_BYTES
        || file.size !== expected.byteLength || file.mimetype !== 'audio/mpeg') return conversionFail(400, 'ADMIN_CONVERSION_INVALID_MP3');
    let reader: RoomAudioReader | undefined;
    try {
        reader = await RoomAudioReader.create(file, signal);
        // A fixed parser hint works around MIME-only detection gaps; the complete frame walk still proves MP3 bytes.
        const parsed = file.path ? await readAudioMetadata(file) : await parseBuffer(Uint8Array.from(file.buffer),
            { mimeType: 'audio/mpeg', path: 'output.mp3', size: file.size }, { duration: true, skipCovers: true });
        const format = parsed.format;
        if (format.hasVideo === true || format.hasAudio === false || !/MPEG|MP3/i.test(String(format.container))
            || !/MPEG.*layer\s*3|MP3/i.test(String(format.codec)) || ![44100, 48000].includes(Number(format.sampleRate))
            || ![1, 2].includes(Number(format.numberOfChannels))) return conversionFail(400, 'ADMIN_CONVERSION_INVALID_MP3');
        const durationMs = await inspectRoomMp3(reader);
        await validatePreset(reader, format.sampleRate!, format.numberOfChannels!);
        await decodeRoomAudio(file, 'mp3', durationMs, signal);
        const hash = createHash('sha256');
        for (let offset = 0; offset < reader.size; offset += 64 * 1024) hash.update(await reader.read(offset, Math.min(64 * 1024, reader.size - offset)));
        await reader.verifyUnchanged();
        if (hash.digest('hex') !== expected.sha256) return conversionFail(409, 'ADMIN_CONVERSION_OUTPUT_CHANGED');
        return { durationMs, sampleRate: format.sampleRate as 44100 | 48000, channels: format.numberOfChannels as 1 | 2 };
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof RoomAudioInspectionError) return conversionFail(503, 'ADMIN_CONVERSION_VALIDATION_UNAVAILABLE');
        if ((error as any)?.code?.startsWith('ADMIN_CONVERSION_')) throw error;
        return conversionFail(400, 'ADMIN_CONVERSION_INVALID_MP3');
    } finally { await reader?.close(); }
}
