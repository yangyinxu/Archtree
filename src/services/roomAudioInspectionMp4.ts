import { boundedDuration, InvalidRoomAudio, RoomAudioReader } from './roomAudioInspectionReader';

type Box = { type: string; start: number; end: number; data: Buffer };

/** Rejects partial, overlapping, zero-sized and excessive metadata boxes before any codec process starts. */
const boxes = (bytes: Buffer, start = 0, end = bytes.length): Box[] => {
    const result: Box[] = [];
    for (let position = start; position < end;) {
        if (result.length >= 4096 || end - position < 8) throw new InvalidRoomAudio();
        let size = bytes.readUInt32BE(position); let header = 8;
        if (size === 1) {
            if (end - position < 16) throw new InvalidRoomAudio();
            const large = bytes.readBigUInt64BE(position + 8);
            if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidRoomAudio();
            size = Number(large); header = 16;
        }
        if (size < header || position + size > end) throw new InvalidRoomAudio();
        result.push({ type: bytes.toString('ascii', position + 4, position + 8), start: position, end: position + size, data: bytes.subarray(position + header, position + size) });
        position += size;
    }
    return result;
};

/** Required singleton atoms cannot be shadowed by a second interpretation of the same metadata. */
const one = (list: Box[], type: string) => {
    const matches = list.filter(box => box.type === type);
    if (matches.length !== 1) throw new InvalidRoomAudio();
    return matches[0].data;
};
/** Only explicitly supported full-box versions and flags contribute eligibility evidence. */
const full = (data: Buffer, minimum: number, version = 0) => {
    if (data.length < minimum || data.readUInt32BE(0) !== version * 0x1000000) throw new InvalidRoomAudio();
    return data;
};
/** Offsets and durations must retain exact integer precision in the JavaScript parser. */
const uint64 = (bytes: Buffer, offset: number) => {
    const value = bytes.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidRoomAudio();
    return Number(value);
};
/** Movie and media timescales define the presentation timeline checked against indexed samples. */
const timeline = (data: Buffer) => {
    const version = data[0];
    if (version !== 0 && version !== 1) throw new InvalidRoomAudio();
    full(data, version === 0 ? 20 : 32, version);
    const scale = data.readUInt32BE(version === 0 ? 12 : 20);
    const duration = version === 0 ? data.readUInt32BE(16) : uint64(data, 24);
    if (!scale || !duration) throw new InvalidRoomAudio();
    return { scale, duration };
};

/** Descriptor lengths may use four continuation bytes; every child must remain inside its parent. */
const descriptor = (bytes: Buffer, start: number) => {
    if (start + 2 > bytes.length) throw new InvalidRoomAudio();
    const tag = bytes[start++]; let length = 0; let finished = false;
    for (let count = 0; count < 4; count += 1) {
        if (start >= bytes.length) throw new InvalidRoomAudio();
        const value = bytes[start++]; length = length * 128 + (value & 127);
        if (!(value & 128)) { finished = true; break; }
    }
    if (!finished || start + length > bytes.length) throw new InvalidRoomAudio();
    return { tag, data: bytes.subarray(start, start + length), end: start + length };
};

/** Allows ordinary AAC-LC only, including the standard explicit “SBR absent” extension. */
const audioSpecificConfig = (bytes: Buffer) => {
    if (bytes.length < 2 || bytes.length > 64) throw new InvalidRoomAudio();
    let position = 0;
    const read = (count: number) => {
        if (position + count > bytes.length * 8) throw new InvalidRoomAudio();
        let value = 0;
        for (let bit = 0; bit < count; bit += 1) { value = value * 2 + ((bytes[position >> 3] >> (7 - (position % 8))) & 1); position += 1; }
        return value;
    };
    if (read(5) !== 2) throw new InvalidRoomAudio();
    const index = read(4); const channels = read(4);
    const sampleRate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][index];
    if (!sampleRate || sampleRate < 8000 || sampleRate > 48000 || ![1, 2].includes(channels) || read(3) !== 0) throw new InvalidRoomAudio();
    if (bytes.length * 8 - position >= 17) {
        const sync = read(11);
        if (sync === 0x2b7) { if (read(5) !== 5 || read(1) !== 0) throw new InvalidRoomAudio(); }
        else if (sync !== 0) throw new InvalidRoomAudio();
    }
    while (position < bytes.length * 8) if (read(1) !== 0) throw new InvalidRoomAudio();
    return { sampleRate, channels };
};

/** Rejects protected, external and alternate audio descriptions before decoding the self-contained AAC track. */
const sampleDescription = (data: Buffer) => {
    full(data, 8);
    if (data.readUInt32BE(4) !== 1) throw new InvalidRoomAudio();
    const entries = boxes(data, 8);
    const audio = one(entries, 'mp4a');
    if (entries.length !== 1 || audio.length < 28 || audio.subarray(0, 6).some(byte => byte !== 0)
        || audio.readUInt16BE(6) !== 1 || audio.readUInt16BE(8) !== 0
        || ![1, 2].includes(audio.readUInt16BE(16)) || audio.readUInt16BE(18) !== 16
        || audio.readUInt16BE(26) !== 0) throw new InvalidRoomAudio();
    const children = boxes(audio, 28);
    if (children.some(box => ['sinf', 'wave'].includes(box.type))) throw new InvalidRoomAudio();
    const esds = full(one(children, 'esds'), 6);
    const es = descriptor(esds, 4);
    if (es.tag !== 3 || es.end !== esds.length || es.data.length < 5 || (es.data[2] & 224) !== 0) throw new InvalidRoomAudio();
    const config = descriptor(es.data, 3);
    if (config.tag !== 4 || config.data.length < 15 || config.data[0] !== 0x40 || config.data[1] !== 0x15) throw new InvalidRoomAudio();
    const specific = descriptor(config.data, 13);
    if (specific.tag !== 5 || specific.end !== config.data.length) throw new InvalidRoomAudio();
    const sl = descriptor(es.data, config.end);
    if (sl.tag !== 6 || sl.end !== es.data.length || sl.data.length !== 1 || sl.data[0] !== 2) throw new InvalidRoomAudio();
    const decoded = audioSpecificConfig(specific.data);
    if (decoded.sampleRate !== audio.readUInt16BE(24) || decoded.channels !== audio.readUInt16BE(16)) throw new InvalidRoomAudio();
    return decoded;
};

/** Full sample tables establish a finite, self-contained, seekable AAC timeline, not just container metadata. */
export const inspectRoomMp4 = async (reader: RoomAudioReader): Promise<number> => {
    let offset = 0; let count = 0; let movie: Buffer | undefined; let brandSeen = false;
    let media: { start: number; end: number } | undefined;
    while (offset < reader.size) {
        if (++count > 128) throw new InvalidRoomAudio();
        const header = await reader.read(offset, 8); let size = header.readUInt32BE(0); let headerSize = 8;
        if (size === 1) { size = uint64(await reader.read(offset + 8, 8), 0); headerSize = 16; }
        if (size < headerSize || offset + size > reader.size) throw new InvalidRoomAudio();
        const type = header.toString('ascii', 4, 8);
        if (type === 'ftyp') {
            if (brandSeen || offset !== 0 || size < 16 || size > 1024 || (size - headerSize) % 4 !== 0) throw new InvalidRoomAudio();
            const brand = (await reader.read(offset + headerSize, 4)).toString('ascii');
            if (!['M4A ', 'isom', 'mp41', 'mp42', 'iso2'].includes(brand)) throw new InvalidRoomAudio();
            brandSeen = true;
        } else if (type === 'moov') {
            if (movie || size > 32 * 1024 * 1024) throw new InvalidRoomAudio();
            movie = await reader.read(offset + headerSize, size - headerSize);
        } else if (type === 'mdat') {
            if (media || size === headerSize) throw new InvalidRoomAudio();
            media = { start: offset + headerSize, end: offset + size };
        } else if (!['free', 'skip', 'wide'].includes(type)) throw new InvalidRoomAudio();
        offset += size;
    }
    if (!brandSeen || !movie || !media) throw new InvalidRoomAudio();
    const movieBoxes = boxes(movie);
    if (movieBoxes.some(box => ['mvex', 'pssh'].includes(box.type))) throw new InvalidRoomAudio();
    const movieTime = timeline(one(movieBoxes, 'mvhd'));
    const trackBoxes = boxes(one(movieBoxes, 'trak'));
    const trackHeader = one(trackBoxes, 'tkhd');
    const trackVersion = trackHeader[0];
    if (![0, 1].includes(trackVersion) || trackHeader.length !== (trackVersion === 0 ? 84 : 96)
        || (trackHeader.readUInt32BE(0) & 0xffffff) !== 3
        || !trackHeader.readUInt32BE(trackVersion === 0 ? 12 : 20)) throw new InvalidRoomAudio();
    const trackDuration = trackVersion === 0 ? trackHeader.readUInt32BE(20) : uint64(trackHeader, 28);
    if (trackDuration !== movieTime.duration) throw new InvalidRoomAudio();
    if (trackBoxes.some(box => box.type === 'tref')) throw new InvalidRoomAudio();
    const mediaBoxes = boxes(one(trackBoxes, 'mdia'));
    const handler = full(one(mediaBoxes, 'hdlr'), 12);
    if (handler.toString('ascii', 8, 12) !== 'soun') throw new InvalidRoomAudio();
    const mediaTime = timeline(one(mediaBoxes, 'mdhd'));
    const info = boxes(one(mediaBoxes, 'minf'));
    const dref = full(one(boxes(one(info, 'dinf')), 'dref'), 8);
    const references = boxes(dref, 8);
    const reference = one(references, 'url ');
    if (dref.readUInt32BE(4) !== 1 || references.length !== 1 || reference.length !== 4 || reference.readUInt32BE(0) !== 1) throw new InvalidRoomAudio();
    const table = boxes(one(info, 'stbl'));
    if (table.some(box => ['ctts', 'stz2', 'senc', 'saio', 'saiz'].includes(box.type))) throw new InvalidRoomAudio();
    const audio = sampleDescription(one(table, 'stsd'));
    if (audio.sampleRate !== mediaTime.scale) throw new InvalidRoomAudio();
    const sizes = full(one(table, 'stsz'), 12);
    const fixedSize = sizes.readUInt32BE(4); const sampleCount = sizes.readUInt32BE(8);
    if (sampleCount === 0 || sampleCount > 4_100_000 || sizes.length !== 12 + (fixedSize ? 0 : sampleCount * 4)) throw new InvalidRoomAudio();
    const times = full(one(table, 'stts'), 8); const timeEntries = times.readUInt32BE(4);
    if (!timeEntries || timeEntries > sampleCount || times.length !== 8 + timeEntries * 8) throw new InvalidRoomAudio();
    let timeSamples = 0; let duration = 0;
    for (let index = 0; index < timeEntries; index += 1) {
        const amount = times.readUInt32BE(8 + index * 8); const delta = times.readUInt32BE(12 + index * 8);
        if (!amount || !delta || delta > 1024 || (delta !== 1024 && (index !== timeEntries - 1 || amount !== 1))) throw new InvalidRoomAudio();
        timeSamples += amount; duration += amount * delta;
    }
    if (timeSamples !== sampleCount || duration !== mediaTime.duration) throw new InvalidRoomAudio();
    const mappings = full(one(table, 'stsc'), 8); const mappingCount = mappings.readUInt32BE(4);
    if (!mappingCount || mappingCount > sampleCount || mappings.length !== 8 + mappingCount * 12) throw new InvalidRoomAudio();
    const offsetBoxes = table.filter(box => box.type === 'stco' || box.type === 'co64');
    if (offsetBoxes.length !== 1) throw new InvalidRoomAudio();
    const offsets = full(offsetBoxes[0].data, 8); const chunkCount = offsets.readUInt32BE(4);
    const offsetWidth = offsetBoxes[0].type === 'co64' ? 8 : 4;
    if (!chunkCount || chunkCount > sampleCount || offsets.length !== 8 + chunkCount * offsetWidth) throw new InvalidRoomAudio();
    let sample = 0; let nextByte = media.start; let mapping = 0;
    for (let index = 0; index < mappingCount; index += 1) {
        const firstChunk = mappings.readUInt32BE(8 + index * 12);
        if ((index === 0 && firstChunk !== 1) || firstChunk > chunkCount
            || (index > 0 && firstChunk <= mappings.readUInt32BE(8 + (index - 1) * 12))
            || !mappings.readUInt32BE(12 + index * 12) || mappings.readUInt32BE(16 + index * 12) !== 1) throw new InvalidRoomAudio();
    }
    for (let chunk = 1; chunk <= chunkCount; chunk += 1) {
        reader.signal?.throwIfAborted();
        if (mapping + 1 < mappingCount && chunk === mappings.readUInt32BE(8 + (mapping + 1) * 12)) mapping += 1;
        const chunkOffset = offsetWidth === 4 ? offsets.readUInt32BE(8 + (chunk - 1) * 4) : uint64(offsets, 8 + (chunk - 1) * 8);
        if (chunkOffset !== nextByte) throw new InvalidRoomAudio();
        const countInChunk = mappings.readUInt32BE(12 + mapping * 12);
        if (sample + countInChunk > sampleCount) throw new InvalidRoomAudio();
        for (let current = 0; current < countInChunk; current += 1) {
            const size = fixedSize || sizes.readUInt32BE(12 + sample * 4);
            if (size === 0 || size > 65536) throw new InvalidRoomAudio();
            nextByte += size; sample += 1;
            if (nextByte > media.end) throw new InvalidRoomAudio();
        }
    }
    if (sample !== sampleCount || nextByte !== media.end) throw new InvalidRoomAudio();
    let durationMs = duration / mediaTime.scale * 1000;
    const editBoxes = trackBoxes.filter(box => box.type === 'edts');
    if (editBoxes.length > 1) throw new InvalidRoomAudio();
    if (editBoxes.length) {
        const edit = one(boxes(editBoxes[0].data), 'elst'); const version = edit[0];
        if (![0, 1].includes(version)) throw new InvalidRoomAudio();
        full(edit, version === 0 ? 20 : 28, version);
        if (edit.readUInt32BE(4) !== 1 || edit.length !== (version === 0 ? 20 : 28)) throw new InvalidRoomAudio();
        const segment = version === 0 ? edit.readUInt32BE(8) : uint64(edit, 8);
        const mediaStart = version === 0 ? edit.readInt32BE(12) : Number(edit.readBigInt64BE(16));
        if (!Number.isSafeInteger(mediaStart) || mediaStart < 0 || mediaStart > 2048
            || edit.readInt16BE(edit.length - 4) !== 1 || edit.readInt16BE(edit.length - 2) !== 0) throw new InvalidRoomAudio();
        const endSample = segment / movieTime.scale * mediaTime.scale + mediaStart;
        if (Math.abs(endSample - duration) > 2048 || endSample > duration + mediaTime.scale / movieTime.scale) throw new InvalidRoomAudio();
        durationMs = segment / movieTime.scale * 1000;
    }
    if (Math.abs(movieTime.duration / movieTime.scale * 1000 - durationMs) > 2) throw new InvalidRoomAudio();
    return boundedDuration(durationMs);
};
