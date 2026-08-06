const sampleRate = 8_000;
const durationSeconds = 15;
const channelCount = 1;
const bytesPerSample = 2;

/** Produces a small PCM WAV that every Playwright browser can decode deterministically. */
export const createTestTone = () => {
  const sampleCount = sampleRate * durationSeconds;
  const dataLength = sampleCount * channelCount * bytesPerSample;
  const output = Buffer.alloc(44 + dataLength);

  output.write('RIFF', 0);
  output.writeUInt32LE(36 + dataLength, 4);
  output.write('WAVE', 8);
  output.write('fmt ', 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channelCount, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  output.writeUInt16LE(channelCount * bytesPerSample, 32);
  output.writeUInt16LE(bytesPerSample * 8, 34);
  output.write('data', 36);
  output.writeUInt32LE(dataLength, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.08;
    output.writeInt16LE(Math.round(sample * 32_767), 44 + index * bytesPerSample);
  }

  return output;
};
