import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Keeps local checks on the same supported major as the production runtime. */
export const assertNodeRuntime = (version = process.versions.node) => {
  if (Number(version.split('.')[0]) !== 24) {
    throw new Error(`Archtree requires Node.js 24.x; found ${version}. See docs/development-environment.md.`);
  }
};

/** Checks the isolated-test daemon without loading application configuration. */
export const assertMongoRuntime = (binary = process.env.MONGOD_BINARY || 'mongod') => {
  try {
    const version = execFileSync(binary, ['--version'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!/^db version v\d+\./m.test(version)) throw new Error('Unexpected daemon version response.');
    return version.match(/^db version (v[^\r\n]+)/m)[1];
  } catch {
    throw new Error('MongoDB test daemon is unavailable. Install MongoDB Community 8.0.12 and add its bin directory to PATH, or set MONGOD_BINARY to the mongod executable. No application database is used. See docs/development-environment.md.');
  }
};

/** Verifies the installed decoder capabilities without opening media, network or audio devices. */
export const assertRoomAudioRuntime = (binary = process.env.ROOM_AUDIO_FFMPEG_PATH || 'ffmpeg') => {
  try {
    if (binary !== 'ffmpeg' && !path.isAbsolute(binary)) throw new Error('Invalid binary path.');
    const inspect = flag => execFileSync(binary, ['-hide_banner', flag], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const version = inspect('-version').match(/^ffmpeg version ([^\s]+)/m)?.[1];
    const decoders = inspect('-decoders');
    const demuxers = inspect('-demuxers');
    const muxers = inspect('-muxers');
    const encoders = inspect('-encoders');
    const protocols = inspect('-protocols');
    if (!version || !/\baac\s/m.test(decoders) || !/\bmp3(?:float)?\s/m.test(decoders)
      || !/\bmov,mp4,m4a,3gp,3g2,mj2\s/m.test(demuxers) || !/\bmp3\s/m.test(demuxers)
      || !/\bnull\s/m.test(muxers) || !/\bpcm_s16le\s/m.test(encoders)
      || !/^\s+file\s*$/m.test(protocols) || !/^\s+pipe\s*$/m.test(protocols)) throw new Error('Missing capabilities.');
    return version;
  } catch {
    throw new Error('Room audio decoder is unavailable. Install FFmpeg with AAC/MP3 decoding, MOV/MP3 demuxers, PCM output, file/pipe protocols and the null muxer; add ffmpeg to PATH or set ROOM_AUDIO_FFMPEG_PATH to its absolute executable path. See docs/development-environment.md.');
  }
};

/** Linux deployment checks must never silently pass on an unsupported host. */
export const assertLinuxRuntime = (platform = process.platform) => {
  if (platform !== 'linux') {
    throw new Error('This release check requires Linux (Ubuntu 24.04 CI or WSL). Use npm test for cross-platform development checks.');
  }
  execFileSync('/bin/bash', ['--version'], { stdio: 'ignore', timeout: 10_000 });
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some(flag => !['--mongo', '--linux', '--room-audio'].includes(flag))) throw new Error('Usage: node scripts/check-runtime.mjs [--mongo] [--linux] [--room-audio]');
    assertNodeRuntime();
    console.log(`Node.js ${process.versions.node} (${process.platform}/${process.arch}): supported`);
    if (flags.includes('--mongo')) console.log(`Isolated MongoDB test daemon ${assertMongoRuntime()}: available`);
    if (flags.includes('--room-audio')) console.log(`Room audio FFmpeg ${assertRoomAudioRuntime()}: available`);
    if (flags.includes('--linux')) {
      assertLinuxRuntime();
      console.log('Linux release checks: available');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
