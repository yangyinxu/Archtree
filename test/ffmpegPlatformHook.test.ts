import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Static contract checks that run on every development platform. The Linux suite
// (ffmpegPlatformHook.linux.test.ts) executes the hook against fake downloads.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const hookPath = '.platform/hooks/prebuild/02_install_ffmpeg.sh';
const decoderConfigPath = '.ebextensions/room-audio-decoder.config';
const read = (relativePath: string) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

/** Returns a single, literal single-quoted assignment; interpolation would let configuration replace a pin. */
const literal = (source: string, name: string) => {
    assert.equal(source.match(new RegExp(`^${name}=`, 'gm'))?.length, 1, `${name} must be assigned exactly once`);
    const match = new RegExp(`^${name}='([^'$\`\\\\]+)'$`, 'm').exec(source);
    assert.ok(match, `${name} must be a literal single-quoted value`);
    return match[1];
};

test('pins one retained month-end BtbN build per architecture with literal sizes and SHA-256 digests', async () => {
    const source = await read(hookPath);
    const tag = literal(source, 'FFMPEG_RELEASE_TAG');
    assert.equal(literal(source, 'FFMPEG_RELEASE_BASE_URL'), 'https://github.com/BtbN/FFmpeg-Builds/releases/download');
    const date = /^autobuild-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}$/.exec(tag);
    assert.ok(date, 'the pin must name one dated autobuild, never the floating latest release');
    const [year, month, day] = date.slice(1).map(Number);
    // BtbN keeps only each month's last build for two years; other daily builds disappear after 14 days.
    assert.equal(new Date(Date.UTC(year, month, 0)).getUTCDate(), day, 'the pinned autobuild must be a month-end build');

    const arm64 = literal(source, 'ARM64_ARCHIVE');
    const x86 = literal(source, 'X86_64_ARCHIVE');
    assert.match(arm64, /^ffmpeg-n\d+\.\d+(?:\.\d+)?-[0-9a-z.-]+-linuxarm64-lgpl-\d+\.\d+\.tar\.xz$/);
    assert.match(x86, /^ffmpeg-n\d+\.\d+(?:\.\d+)?-[0-9a-z.-]+-linux64-lgpl-\d+\.\d+\.tar\.xz$/);
    assert.equal(arm64.replace('-linuxarm64-', '-'), x86.replace('-linux64-', '-'), 'both architectures must pin the same FFmpeg revision');
    const digests = ['ARM64_ARCHIVE_SHA256', 'X86_64_ARCHIVE_SHA256'].map(name => literal(source, name));
    for (const digest of digests) assert.match(digest, /^[0-9a-f]{64}$/);
    assert.notEqual(digests[0], digests[1]);
    for (const name of ['ARM64_ARCHIVE_BYTES', 'X86_64_ARCHIVE_BYTES']) {
        assert.match(literal(source, name), /^[1-9][0-9]{6,9}$/, `${name} must bound the download size`);
    }
});

test('the environment can relocate test paths but never replace the pinned URL, size or digest', async () => {
    const source = await read(hookPath);
    assert.deepEqual([...new Set(source.match(/\bARCHTREE_[A-Z0-9_]+/g))].sort(), [
        'ARCHTREE_CURL_BIN', 'ARCHTREE_DNF_BIN', 'ARCHTREE_FFMPEG_BIN_DIR', 'ARCHTREE_FFMPEG_INSTALL_ROOT',
        'ARCHTREE_FFMPEG_MACHINE', 'ARCHTREE_SHA256SUM_BIN', 'ARCHTREE_TAR_BIN', 'ARCHTREE_XZ_BIN'
    ]);
    assert.match(source, /^ARCHIVE_URL="\$\{FFMPEG_RELEASE_BASE_URL\}\/\$\{FFMPEG_RELEASE_TAG\}\/\$\{ARCHIVE\}"$/m);
    assert.match(source, /--proto '=https' --proto-redir '=https'/);
    assert.match(source, /--fail /);
    assert.match(source, /--max-filesize "\$\{ARCHIVE_BYTES\}"/);
});

test('verifies the size and digest before listing or extracting, and fails loudly on any mismatch', async () => {
    const source = await read(hookPath);
    assert.equal(source.split('\n')[1], 'set -euo pipefail');
    assert.match(source, /^fail\(\) \{\n {2}printf '\[archtree-ffmpeg\] ERROR: %s\\n' "\$\*" >&2\n {2}exit 1\n\}$/m);
    const sizeCheck = source.indexOf('if [[ "${actual_bytes}" != "${ARCHIVE_BYTES}" ]]; then');
    const digestCheck = source.indexOf('if [[ "${actual_sha256}" != "${ARCHIVE_SHA256}" ]]; then');
    const listing = source.indexOf('-tJf "${archive}"');
    const extraction = source.indexOf('-xJf "${archive}"');
    assert.ok(sizeCheck > 0 && digestCheck > sizeCheck, 'size and digest checks must both exist, size first');
    assert.ok(listing > digestCheck && extraction > listing, 'nothing from the archive is read before its digest matches');
    assert.match(source.slice(digestCheck, listing), /fail "FFmpeg archive SHA-256 mismatch: expected \$\{ARCHIVE_SHA256\}/);
});

test('installs where the deployed decoder looks and checks the capabilities the decoder needs', async () => {
    const [source, config, decoder, runtimeCheck] = await Promise.all([
        read(hookPath), read(decoderConfigPath), read('src/services/roomAudioInspectionDecoder.ts'), read('scripts/check-runtime.mjs')
    ]);
    assert.match(source, /^BIN_DIR=\$\{ARCHTREE_FFMPEG_BIN_DIR:-\/usr\/local\/bin\}$/m);
    assert.match(config, /^ {4}ROOM_AUDIO_FFMPEG_PATH: \/usr\/local\/bin\/ffmpeg$/m);
    assert.match(config, /^ {2}aws:elasticbeanstalk:application:environment:$/m);
    // The decoder and doctor both read this absolute-path override, so the deployed value selects the pinned binary.
    assert.match(decoder, /process\.env\.ROOM_AUDIO_FFMPEG_PATH \|\| 'ffmpeg'/);
    assert.match(runtimeCheck, /process\.env\.ROOM_AUDIO_FFMPEG_PATH \|\| 'ffmpeg'/);
    for (const capability of ['aac', 'mp3(float)?', 'mov,mp4,m4a,3gp,3g2,mj2', 'mp3', 'null', 'pcm_s16le', 'file', 'pipe']) {
        assert.ok(source.includes(`]+${capability}[[:space:]]`) || source.includes(`]${capability}[[:space:]]`),
            `the hook must verify the ${capability} capability before linking`);
    }
    assert.ok(source.indexOf('decoder_capable "${stage}/ffmpeg"') < source.indexOf('mv -- "${stage}" "${VERSION_DIR}"'),
        'an incapable build must never replace the installed version');
});

test('is an executable prebuild hook that the deployment artifact requires', async () => {
    if (process.platform !== 'win32') {
        assert.notEqual((await stat(path.join(repositoryRoot, hookPath))).mode & 0o111, 0);
    }
    const staging = await read('scripts/stage-eb-artifact.mjs');
    assert.ok(staging.includes(`'${hookPath}'`));
    assert.ok(staging.includes(`'${decoderConfigPath}'`));
});
