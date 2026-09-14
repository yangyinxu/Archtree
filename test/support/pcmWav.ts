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

export const wavUploadFile = (buffer = createPcmWav()): Express.Multer.File => ({
    fieldname: 'audioFile', originalname: 'room-tone.wav', encoding: '7bit', mimetype: 'audio/wav',
    buffer, size: buffer.length
} as Express.Multer.File);
