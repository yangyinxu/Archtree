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
    ['room-tone.m4a', 440, 44100, 2, 120, ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']],
    // Lossless sources rooms do not support; the duration probe measures them.
    ['tone.flac', 440, 44100, 2, 2, ['-c:a', 'flac']],
    // Front and back pictures are trimmed to one frame by their filters: an output frame limit would also end the audio.
    ['tone-covers.flac', 440, 8000, 1, 2, ['-map', '0:a', '-map', '1:v', '-map', '2:v', '-c:a', 'flac', '-c:v', 'png',
        '-disposition:v', 'attached_pic'], ['-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=1,trim=end_frame=1',
        '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:d=1,trim=end_frame=1']],
    ['tone-alac.m4a', 440, 8000, 1, 2, ['-c:a', 'alac']],
    ['tone.aiff', 440, 8000, 1, 2, ['-c:a', 'pcm_s16be']],
    ['tone-24bit.wav', 440, 8000, 1, 2, ['-c:a', 'pcm_s24le']]
];
// Pass fixture names to regenerate only those files.
const selected = process.argv.slice(2);
for (const [name, frequency, rate, channels, duration, codec, extraInputs = []] of fixtures) {
    if (selected.length && !selected.includes(name)) continue;
    execFileSync(process.env.ROOM_AUDIO_FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${rate}:duration=${duration}`,
        ...extraInputs, '-ac', String(channels), ...codec, '-y', join(directory, name)
    ], { stdio: 'inherit' });
}
