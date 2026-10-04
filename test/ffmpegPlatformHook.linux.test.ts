import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const hookPath = path.join(repositoryRoot, '.platform/hooks/prebuild/02_install_ffmpeg.sh');

const writeExecutable = async (filePath: string, lines: string[]) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
    await chmod(filePath, 0o755);
};

/** Answers only the capability probes the hook runs; no media is ever decoded. */
const fakeFfmpeg = (aacDecoder: boolean) => [
    '#!/usr/bin/env bash',
    'case "$2" in',
    '  -version) printf \'ffmpeg version 9.0.2-fixture Copyright (c) fixture\\n\' ;;',
    `  -decoders) printf ' A....D ${aacDecoder ? 'aac' : 'opus'}                  fixture\\n A....D mp3float             fixture\\n' ;;`,
    '  -demuxers) printf \' D  mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV\\n D  mp3             MP2/3\\n\' ;;',
    '  -muxers) printf \'  E null            raw null video\\n\' ;;',
    '  -encoders) printf \' A....D pcm_s16le           PCM signed 16-bit\\n\' ;;',
    '  -protocols) printf \'Supported file protocols:\\nInput:\\n  file\\n  pipe\\nOutput:\\n  file\\n\' ;;',
    '  *) exit 1 ;;',
    'esac'
];

interface FixtureArchive { file: string; directory: string; sha256: string; bytes: number }

/** Packs fake executables in the release layout; ffplay and docs must never be installed. */
const buildArchive = async (root: string, name: string, options: { aacDecoder?: boolean; ffprobe?: boolean } = {}) => {
    const directory = `${name}-dir/ffmpeg-n9.0.2-17-g2a571b6068-linuxarm64-lgpl-9.0`;
    const top = path.join(root, directory);
    await writeExecutable(path.join(top, 'bin/ffmpeg'), fakeFfmpeg(options.aacDecoder ?? true));
    if (options.ffprobe ?? true) {
        await writeExecutable(path.join(top, 'bin/ffprobe'), ['#!/usr/bin/env bash', 'printf \'ffprobe version 9.0.2-fixture\\n\'']);
    }
    await writeExecutable(path.join(top, 'bin/ffplay'), ['#!/usr/bin/env bash', 'exit 1']);
    await mkdir(path.join(top, 'doc'), { recursive: true });
    await writeFile(path.join(top, 'doc/README.txt'), 'fixture documentation\n');
    const file = path.join(root, `${name}.tar.xz`);
    await execFileAsync('tar', ['-cJf', file, '-C', path.dirname(top), path.basename(top)]);
    const bytes = await readFile(file);
    return { file, directory: path.basename(top), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
};

/** Copies the hook with only the arm64 size and digest replaced; production pins stay literal and unreadable from the environment. */
const pinnedCopy = async (root: string, archive: FixtureArchive, name = 'hook.sh') => {
    const source = await readFile(hookPath, 'utf8');
    const rewritten = source
        .replace(/^ARM64_ARCHIVE_BYTES='\d+'$/m, `ARM64_ARCHIVE_BYTES='${archive.bytes}'`)
        .replace(/^ARM64_ARCHIVE_SHA256='[0-9a-f]{64}'$/m, `ARM64_ARCHIVE_SHA256='${archive.sha256}'`);
    assert.notEqual(rewritten, source);
    const copy = path.join(root, name);
    await writeFile(copy, rewritten, 'utf8');
    await chmod(copy, 0o755);
    return copy;
};

/** Builds an isolated install root, command directory and logging fake downloader for one test. */
const createFixture = async (t: TestContext) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'archtree-ffmpeg-hook-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installRoot = path.join(root, 'opt', 'archtree-ffmpeg');
    const binDir = path.join(root, 'usr', 'local', 'bin');
    const curlLog = path.join(root, 'curl.log');
    const dnfLog = path.join(root, 'dnf.log');
    const curl = path.join(root, 'tools', 'curl');
    const dnf = path.join(root, 'tools', 'dnf');
    await writeExecutable(curl, [
        '#!/usr/bin/env bash',
        'set -eu',
        'printf \'%s\\n\' "$*" >>"${ARCHTREE_TEST_CURL_LOG}"',
        'output=\'\'',
        'previous=\'\'',
        'for argument in "$@"; do',
        '  if [[ "${previous}" == "--output" ]]; then output=${argument}; fi',
        '  previous=${argument}',
        'done',
        'case "${ARCHTREE_TEST_CURL_MODE:-archive}" in',
        '  archive) cp "${ARCHTREE_TEST_ARCHIVE}" "${output}" ;;',
        '  same-size-zeros) head -c "$(wc -c <"${ARCHTREE_TEST_ARCHIVE}")" /dev/zero >"${output}" ;;',
        '  junk) printf \'not the pinned archive\' >"${output}" ;;',
        '  fail) exit 22 ;;',
        'esac'
    ]);
    await writeExecutable(dnf, ['#!/usr/bin/env bash', 'printf \'%s\\n\' "$*" >>"${ARCHTREE_TEST_DNF_LOG}"']);
    const archive = await buildArchive(root, 'release');
    const run = async (hook: string, environment: Record<string, string> = {}) => {
        try {
            const result = await execFileAsync('bash', [hook], {
                env: {
                    PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
                    ARCHTREE_FFMPEG_INSTALL_ROOT: installRoot, ARCHTREE_FFMPEG_BIN_DIR: binDir,
                    ARCHTREE_CURL_BIN: curl, ARCHTREE_FFMPEG_MACHINE: 'aarch64',
                    ARCHTREE_TEST_CURL_LOG: curlLog, ARCHTREE_TEST_DNF_LOG: dnfLog, ARCHTREE_TEST_ARCHIVE: archive.file,
                    ...environment
                },
                timeout: 30_000
            });
            return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
            const failure = error as { code?: number; stdout?: string; stderr?: string };
            assert.equal(typeof failure.code, 'number', 'the hook must exit, not hang or crash its shell');
            return { code: failure.code!, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
        }
    };
    const curlCalls = async () => (await readFile(curlLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return { root, installRoot, binDir, archive, run, curlCalls, dnfLog, versionDir: path.join(installRoot, archive.directory) };
};

/** Seeds a working older pin so failure tests can prove the active decoder is left untouched. */
const seedPreviousInstall = async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
    const previous = path.join(fixture.installRoot, 'ffmpeg-n8.1.3-previous-linuxarm64-lgpl-8.1');
    await writeExecutable(path.join(previous, 'ffmpeg'), fakeFfmpeg(true));
    await mkdir(fixture.binDir, { recursive: true });
    await execFileAsync('ln', ['-s', path.join(previous, 'ffmpeg'), path.join(fixture.binDir, 'ffmpeg')]);
    return previous;
};

test('installs the verified pin once, links both commands and skips the download when rerun', async (t) => {
    const fixture = await createFixture(t);
    const hook = await pinnedCopy(fixture.root, fixture.archive);

    const first = await fixture.run(hook);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Verified SHA-256 [0-9a-f]{64}\./);
    assert.equal(await readlink(path.join(fixture.binDir, 'ffmpeg')), path.join(fixture.versionDir, 'ffmpeg'));
    assert.equal(await readlink(path.join(fixture.binDir, 'ffprobe')), path.join(fixture.versionDir, 'ffprobe'));
    assert.deepEqual((await readdir(fixture.versionDir)).sort(), ['.archive-sha256', 'ffmpeg', 'ffprobe']);
    assert.equal(await readFile(path.join(fixture.versionDir, '.archive-sha256'), 'utf8'), `${fixture.archive.sha256}\n`);
    assert.deepEqual(await readdir(fixture.installRoot), [fixture.archive.directory], 'no download staging may remain');
    const [call] = await fixture.curlCalls();
    assert.match(call, /--proto =https --proto-redir =https/);
    assert.match(call, new RegExp(`--max-filesize ${fixture.archive.bytes} `));
    assert.match(call, / https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-[0-9-]+\/ffmpeg-n[^ ]+-linuxarm64-lgpl-[0-9.]+\.tar\.xz$/);

    const second = await fixture.run(hook);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /already installed/);
    assert.equal((await fixture.curlCalls()).length, 1, 'an installed pin must not be downloaded again');
    assert.equal(await readlink(path.join(fixture.binDir, 'ffmpeg')), path.join(fixture.versionDir, 'ffmpeg'));
});

test('replaces an older pin, stale downloads and an unmanaged binary at the command path', async (t) => {
    const fixture = await createFixture(t);
    const hook = await pinnedCopy(fixture.root, fixture.archive);
    const previous = await seedPreviousInstall(fixture);
    await mkdir(path.join(fixture.installRoot, '.download.interrupted'), { recursive: true });
    await writeFile(path.join(fixture.binDir, 'ffprobe'), 'unmanaged binary\n');

    const result = await fixture.run(hook);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Replacing the unmanaged .*ffprobe/);
    assert.ok((await lstat(path.join(fixture.binDir, 'ffprobe'))).isSymbolicLink());
    assert.equal(await readlink(path.join(fixture.binDir, 'ffmpeg')), path.join(fixture.versionDir, 'ffmpeg'));
    assert.deepEqual(await readdir(fixture.installRoot), [fixture.archive.directory]);
    await assert.rejects(lstat(previous), { code: 'ENOENT' });
});

test('reinstalls a version directory whose marker or executables do not prove the pinned digest', async (t) => {
    const fixture = await createFixture(t);
    const hook = await pinnedCopy(fixture.root, fixture.archive);
    assert.equal((await fixture.run(hook)).code, 0);
    await writeFile(path.join(fixture.versionDir, '.archive-sha256'), `${'0'.repeat(64)}\n`);
    assert.equal((await fixture.run(hook)).code, 0);
    await rm(path.join(fixture.versionDir, 'ffprobe'));
    assert.equal((await fixture.run(hook)).code, 0);
    assert.equal((await fixture.curlCalls()).length, 3);
    assert.equal(await readFile(path.join(fixture.versionDir, '.archive-sha256'), 'utf8'), `${fixture.archive.sha256}\n`);
});

test('a digest mismatch, size mismatch or failed download fails loudly and keeps the active decoder', async (t) => {
    for (const [mode, message] of [
        ['same-size-zeros', /FFmpeg archive SHA-256 mismatch: expected [0-9a-f]{64}, received [0-9a-f]{64}\. Refusing to install\./],
        ['junk', /FFmpeg archive size mismatch/],
        ['fail', /Downloading the pinned FFmpeg archive failed/]
    ] as const) {
        const fixture = await createFixture(t);
        const hook = await pinnedCopy(fixture.root, fixture.archive);
        const previous = await seedPreviousInstall(fixture);
        const result = await fixture.run(hook, { ARCHTREE_TEST_CURL_MODE: mode });
        assert.equal(result.code, 1, mode);
        assert.match(result.stderr, /\[archtree-ffmpeg\] ERROR: /);
        assert.match(result.stderr, message);
        assert.equal(await readlink(path.join(fixture.binDir, 'ffmpeg')), path.join(previous, 'ffmpeg'), mode);
        await assert.rejects(lstat(path.join(fixture.binDir, 'ffprobe')), { code: 'ENOENT' });
        assert.deepEqual(await readdir(fixture.installRoot), [path.basename(previous)], `${mode} must leave no partial install`);
    }
});

test('the committed hook rejects any bytes that do not match its real pin', async (t) => {
    const fixture = await createFixture(t);
    for (const mode of ['archive', 'junk'] as const) {
        const result = await fixture.run(hookPath, { ARCHTREE_TEST_CURL_MODE: mode });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /FFmpeg archive size mismatch: expected \d+ bytes/);
    }
    await assert.rejects(lstat(path.join(fixture.binDir, 'ffmpeg')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(fixture.installRoot), []);
});

test('selects the x86_64 pin there and refuses an unpinned machine before any download', async (t) => {
    const fixture = await createFixture(t);
    const x86 = await fixture.run(hookPath, { ARCHTREE_FFMPEG_MACHINE: 'x86_64', ARCHTREE_TEST_CURL_MODE: 'fail' });
    assert.equal(x86.code, 1);
    assert.match((await fixture.curlCalls())[0], /\/ffmpeg-n[^ /]+-linux64-lgpl-[0-9.]+\.tar\.xz$/);
    const unpinned = await fixture.run(hookPath, { ARCHTREE_FFMPEG_MACHINE: 'riscv64' });
    assert.equal(unpinned.code, 1);
    assert.match(unpinned.stderr, /No pinned FFmpeg build exists for machine 'riscv64'/);
    assert.equal((await fixture.curlCalls()).length, 1);
});

test('a verified archive without the decoder capabilities or both executables is never linked', async (t) => {
    for (const [options, message] of [
        [{ aacDecoder: false }, /lacks the room audio decoding capabilities/],
        [{ ffprobe: false }, /does not contain exactly one bin\/ffprobe/]
    ] as const) {
        const fixture = await createFixture(t);
        const archive = await buildArchive(fixture.root, 'defective', options);
        const hook = await pinnedCopy(fixture.root, archive, 'defective-hook.sh');
        const result = await fixture.run(hook, { ARCHTREE_TEST_ARCHIVE: archive.file });
        assert.equal(result.code, 1);
        assert.match(result.stderr, message);
        await assert.rejects(lstat(path.join(fixture.binDir, 'ffmpeg')), { code: 'ENOENT' });
        assert.deepEqual(await readdir(fixture.installRoot), []);
    }
});

test('refuses to replace a directory at the command path', async (t) => {
    const fixture = await createFixture(t);
    const hook = await pinnedCopy(fixture.root, fixture.archive);
    await mkdir(path.join(fixture.binDir, 'ffmpeg'), { recursive: true });
    const result = await fixture.run(hook);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ffmpeg is a directory/);
    assert.ok((await lstat(path.join(fixture.binDir, 'ffmpeg'))).isDirectory());
});

test('installs xz with dnf when it is missing and fails before downloading if it stays missing', async (t) => {
    const fixture = await createFixture(t);
    const hook = await pinnedCopy(fixture.root, fixture.archive);
    const missingXz = { ARCHTREE_XZ_BIN: 'archtree-test-missing-xz' };
    const stillMissing = await fixture.run(hook, { ...missingXz, ARCHTREE_DNF_BIN: path.join(fixture.root, 'tools', 'dnf') });
    assert.equal(stillMissing.code, 1);
    assert.match(stillMissing.stderr, /xz is still unavailable after installation/);
    assert.equal(await readFile(fixture.dnfLog, 'utf8'), 'install -y xz\n');
    const noDnf = await fixture.run(hook, { ...missingXz, ARCHTREE_DNF_BIN: 'archtree-test-missing-dnf' });
    assert.equal(noDnf.code, 1);
    assert.match(noDnf.stderr, /xz could not be installed/);
    assert.deepEqual(await fixture.curlCalls(), []);
});
