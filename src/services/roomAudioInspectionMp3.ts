import { boundedDuration, InvalidRoomAudio, RoomAudioReader } from './roomAudioInspectionReader';

const mpeg1Rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Rates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Layer III frame lengths come from each frame, never a bitrate-derived whole-file estimate. */
const frameHeader = (bytes: Buffer) => {
    const version = (bytes[1] >> 3) & 3;
    const rateIndex = (bytes[2] >> 2) & 3;
    const bitrateIndex = bytes[2] >> 4;
    if (bytes[0] !== 255 || (bytes[1] & 224) !== 224 || version === 1 || ((bytes[1] >> 1) & 3) !== 1
        || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15 || (bytes[3] & 3) === 2) throw new InvalidRoomAudio();
    const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const channels = (bytes[3] >> 6) === 3 ? 1 : 2;
    const bitrate = (version === 3 ? mpeg1Rates : mpeg2Rates)[bitrateIndex] * 1000;
    const samples = version === 3 ? 1152 : 576;
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((bytes[2] >> 1) & 1);
    return { sampleRate, channels, bitrate, samples, length, version, crc: (bytes[1] & 1) === 0 };
};

/** Validates frame totals and the seek table advertised to browsers by a Xing/Info frame. */
const xingHeader = (frame: Buffer, header: ReturnType<typeof frameHeader>) => {
    const offset = 4 + (header.crc ? 2 : 0) + (header.version === 3 ? header.channels === 1 ? 17 : 32 : header.channels === 1 ? 9 : 17);
    const marker = frame.toString('ascii', offset, offset + 4);
    if (marker !== 'Xing' && marker !== 'Info') return null;
    let cursor = offset + 4;
    const read32 = () => { if (cursor + 4 > frame.length) throw new InvalidRoomAudio(); const value = frame.readUInt32BE(cursor); cursor += 4; return value; };
    const flags = read32();
    if ((flags & ~15) !== 0 || (flags & 1) === 0) throw new InvalidRoomAudio();
    const frames = read32();
    const bytes = flags & 2 ? read32() : undefined;
    let toc: Buffer | undefined;
    if (flags & 4) {
        if (cursor + 100 > frame.length) throw new InvalidRoomAudio();
        toc = frame.subarray(cursor, cursor + 100); cursor += 100;
        if (toc[0] !== 0 || toc[99] === 0 || toc.some((value, index) => index > 0 && value < toc![index - 1])) throw new InvalidRoomAudio();
    }
    if (flags & 8) read32();
    let delay = 0; let padding = 0;
    const encoder = frame.toString('ascii', cursor, cursor + 4);
    if (['LAME', 'Lavf', 'Lavc'].includes(encoder)) {
        if (cursor + 24 > frame.length) throw new InvalidRoomAudio();
        delay = (frame[cursor + 21] << 4) | (frame[cursor + 22] >> 4);
        padding = ((frame[cursor + 22] & 15) << 8) | frame[cursor + 23];
    }
    return { frames, bytes, toc, delay, padding, marker };
};

/** Walks every MPEG frame and verifies VBR indexes against their actual byte positions. */
export const inspectRoomMp3 = async (reader: RoomAudioReader): Promise<number> => {
    let start = 0; let end = reader.size;
    const initial = await reader.read(0, 10);
    if (initial.toString('ascii', 0, 3) === 'ID3') {
        const version = initial[3]; const flags = initial[5];
        if (![2, 3, 4].includes(version) || initial[4] === 255
            || (flags & (version === 2 ? 63 : version === 3 ? 31 : 15)) !== 0
            || initial.subarray(6, 10).some(value => value > 127)) throw new InvalidRoomAudio();
        const size = initial[6] * 2097152 + initial[7] * 16384 + initial[8] * 128 + initial[9];
        if (size > 16 * 1024 * 1024) throw new InvalidRoomAudio();
        start = 10 + size;
        if (version === 4 && (flags & 16)) {
            const footer = await reader.read(start, 10);
            if (footer.toString('ascii', 0, 3) !== '3DI' || !footer.subarray(3).equals(initial.subarray(3))) throw new InvalidRoomAudio();
            start += 10;
        }
    }
    if (end - start >= 128 && (await reader.read(end - 128, 3)).toString('ascii') === 'TAG') end -= 128;
    if (end - start < 8) throw new InvalidRoomAudio();
    const first = frameHeader(await reader.read(start, 4));
    const xing = xingHeader(await reader.read(start, first.length), first);
    // VBRI indexes and unindexed VBR are deliberately excluded until browser seeking has its own evidence.
    if (!xing && (await reader.read(start, first.length)).includes(Buffer.from('VBRI'))) throw new InvalidRoomAudio();
    let offset = start; let frames = 0; let firstBitrate = 0; let variableBitrate = false; let maximumFrameLength = 0;
    const checkpoints: number[] = [];
    while (offset < end) {
        if (++frames > 4_100_000 || offset + 4 > end) throw new InvalidRoomAudio();
        const frame = frameHeader(await reader.read(offset, 4));
        if (frame.sampleRate !== first.sampleRate || frame.channels !== first.channels || frame.version !== first.version
            || offset + frame.length > end) throw new InvalidRoomAudio();
        maximumFrameLength = Math.max(maximumFrameLength, frame.length);
        if (!xing || frames > 1) {
            if (!firstBitrate) firstBitrate = frame.bitrate;
            variableBitrate ||= frame.bitrate !== firstBitrate;
        }
        if (xing?.toc) {
            const audioFrame = frames - 1;
            while (checkpoints.length < 100 && audioFrame >= Math.floor(xing.frames * checkpoints.length / 100)) {
                checkpoints.push(offset - start);
            }
        }
        offset += frame.length;
    }
    if (frames < 2 || offset !== end) throw new InvalidRoomAudio();
    if (xing) {
        if (xing.frames !== frames - 1 || (xing.bytes !== undefined && xing.bytes !== end - start)) throw new InvalidRoomAudio();
        if (xing.toc) {
            if (!xing.bytes || checkpoints.length !== 100) throw new InvalidRoomAudio();
            // Xing quantizes byte offsets to 1/256 of the stream; encoders may reference either boundary of a frame.
            const tolerance = Math.ceil(xing.bytes / 256) + maximumFrameLength * 2;
            for (let index = 0; index < 100; index += 1) {
                if (Math.abs(xing.toc[index] / 256 * xing.bytes - checkpoints[index]) > tolerance) throw new InvalidRoomAudio();
            }
        }
    }
    if (variableBitrate && (!xing?.toc || !xing.bytes || xing.marker === 'Info')) throw new InvalidRoomAudio();
    const sampleCount = (frames - (xing ? 1 : 0)) * first.samples - (xing?.delay ?? 0) - (xing?.padding ?? 0);
    return boundedDuration(sampleCount / first.sampleRate * 1000);
};
