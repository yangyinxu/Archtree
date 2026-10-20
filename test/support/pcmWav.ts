/** Deterministic PCM16 tone used by real upload/stream and browser playback tests. */
export const createPcmWav = (durationMs = 2000, sampleRate = 16000, channels = 1): Buffer => {
    const frames = Math.round(durationMs * sampleRate / 1000);
    const dataBytes = frames * channels * 2;
    const result = Buffer.alloc(44 + dataBytes);
    result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVE', 8);
    result.write('fmt ', 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20);
    result.writeUInt16LE(channels, 22); result.writeUInt32LE(sampleRate, 24);
    result.writeUInt32LE(sampleRate * channels * 2, 28); result.writeUInt16LE(channels * 2, 32);
    result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(dataBytes, 40);
    for (let frame = 0; frame < frames; frame += 1) {
        const value = Math.round(Math.sin(frame * Math.PI * 2 * 220 / sampleRate) * 2000);
        for (let channel = 0; channel < channels; channel += 1) result.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
    }
    return result;
};

/** One ID3v2.3 text frame (`TXXX:<description>` for a user-defined one) holding UTF-16 text with a BOM. */
export const id3TextFrame = (key: string, text: string): Buffer => {
    const utf16 = (value: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]);
    const [id, description] = key.startsWith('TXXX:') ? ['TXXX', key.slice(5)] : [key, null];
    const data = Buffer.concat([Buffer.from([1]), ...(description === null ? [] : [utf16(description), Buffer.from([0, 0])]), utf16(text)]);
    const header = Buffer.alloc(10);
    header.write(id, 0, 'ascii');
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
};

/**
 * Appends an ID3v2.3 `id3 ` RIFF chunk holding text frames, the way tagging tools store WAV tags, so upload tests exercise the
 * real embedded-metadata reader. A key `TXXX:<description>` writes a user-defined text frame; every other key is a frame ID.
 * Values are written as UTF-16 with a BOM, so any synthetic text (control and formatting characters included) round-trips.
 */
export const withId3TextFrames = (wav: Buffer, frames: Record<string, string>): Buffer => {
    const body = Buffer.concat(Object.entries(frames).map(([key, text]) => id3TextFrame(key, text)));
    const size = body.length;
    // ID3v2 sizes are synchsafe: four 7-bit groups.
    const tag = Buffer.concat([
        Buffer.from('ID3'), Buffer.from([3, 0, 0]),
        Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]),
        body
    ]);
    const chunk = Buffer.alloc(8);
    chunk.write('id3 ', 0, 'ascii');
    chunk.writeUInt32LE(tag.length, 4);
    // RIFF chunks are word aligned; the outer RIFF size covers the appended chunk.
    const result = Buffer.concat([wav, chunk, tag, Buffer.alloc(tag.length % 2)]);
    result.writeUInt32LE(result.length - 8, 4);
    return result;
};
/** TRCK/TPOS positions only, as earlier upload tests write them. */
export const withId3Positions = (wav: Buffer, positions: { track?: string; disc?: string }): Buffer =>
    withId3TextFrames(wav, { ...(positions.track === undefined ? {} : { TRCK: positions.track }), ...(positions.disc === undefined ? {} : { TPOS: positions.disc }) });

export const wavUploadFile = (buffer = createPcmWav()): Express.Multer.File => ({
    fieldname: 'audioFile', originalname: 'room-tone.wav', encoding: '7bit', mimetype: 'audio/wav',
    buffer, size: buffer.length
} as Express.Multer.File);
