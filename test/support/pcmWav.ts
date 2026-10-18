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

/**
 * Appends an ID3v2.3 `id3 ` RIFF chunk holding TRCK/TPOS text frames, the way tagging tools store
 * WAV positions, so upload tests exercise the real embedded-metadata reader.
 */
export const withId3Positions = (wav: Buffer, positions: { track?: string; disc?: string }): Buffer => {
    const frame = (id: string, text: string) => {
        const data = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
        const header = Buffer.alloc(10);
        header.write(id, 0, 'ascii');
        header.writeUInt32BE(data.length, 4);
        return Buffer.concat([header, data]);
    };
    const frames = Buffer.concat([
        ...(positions.track === undefined ? [] : [frame('TRCK', positions.track)]),
        ...(positions.disc === undefined ? [] : [frame('TPOS', positions.disc)])
    ]);
    const size = frames.length;
    // ID3v2 sizes are synchsafe: four 7-bit groups.
    const tag = Buffer.concat([
        Buffer.from('ID3'), Buffer.from([3, 0, 0]),
        Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]),
        frames
    ]);
    const chunk = Buffer.alloc(8);
    chunk.write('id3 ', 0, 'ascii');
    chunk.writeUInt32LE(tag.length, 4);
    // RIFF chunks are word aligned; the outer RIFF size covers the appended chunk.
    const result = Buffer.concat([wav, chunk, tag, Buffer.alloc(tag.length % 2)]);
    result.writeUInt32LE(result.length - 8, 4);
    return result;
};

export const wavUploadFile = (buffer = createPcmWav()): Express.Multer.File => ({
    fieldname: 'audioFile', originalname: 'room-tone.wav', encoding: '7bit', mimetype: 'audio/wav',
    buffer, size: buffer.length
} as Express.Multer.File);
