import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Original deterministic tones generated with FFmpeg 9.0.1. Encoding never opens an audio output device.
const directory = dirname(fileURLToPath(import.meta.url));
const fixtures = [
    ['cbr.mp3', 440, 44100, 2, 2, ['-c:a', 'libmp3lame', '-b:a', '128k']],
    ['vbr.mp3', 660, 44100, 2, 2, ['-c:a', 'libmp3lame', '-q:a', '3']],
    ['cbr-mono-no-index.mp3', 330, 16000, 1, 2, ['-c:a', 'libmp3lame', '-b:a', '32k', '-write_xing', '0']],
    ['aac-lc.m4a', 440, 44100, 2, 2, ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']],
    ['aac-lc-moov-tail.m4a', 330, 48000, 1, 2, ['-c:a', 'aac', '-b:a', '64k']],
    ['room-tone-vbr.mp3', 660, 44100, 2, 120, ['-c:a', 'libmp3lame', '-q:a', '3']],
    ['room-tone.mp3', 440, 44100, 2, 120, ['-c:a', 'libmp3lame', '-b:a', '128k']],
    ['room-tone.m4a', 440, 44100, 2, 120, ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']]
];
for (const [name, frequency, rate, channels, duration, codec] of fixtures) {
    execFileSync(process.env.ROOM_AUDIO_FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${rate}:duration=${duration}`,
        '-ac', String(channels), ...codec, '-y', join(directory, name)
    ], { stdio: 'inherit' });
}
