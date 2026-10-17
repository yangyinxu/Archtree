import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const hook = path.join(repositoryRoot, '.platform/hooks/prebuild/00_ensure_swap.sh');
const configurationHook = path.join(repositoryRoot, '.platform/confighooks/prebuild/00_ensure_swap.sh');

/** Fake swap tools: `swapon --show` lists files recorded in active.txt. */
const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archtree-swap-hook-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const active = path.join(root, 'active.txt');
  const calls = path.join(root, 'calls.log');
  await writeFile(active, '');
  const executable = async (name: string, body: string) => {
    await writeFile(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  };
  await executable('swapon', [
    `printf 'swapon %s\\n' "$*" >>'${calls}'`,
    `if [[ "$1" == --show=* ]]; then cat '${active}'; exit 0; fi`,
    `printf '%s\\n' "$1" >>'${active}'`
  ].join('\n'));
  await executable('mkswap', `printf 'mkswap %s\\n' "$*" >>'${calls}'`);
  await executable('fallocate', `printf 'fallocate %s\\n' "$*" >>'${calls}'; : >"$3"`);
  const environment = {
    ...process.env,
    ARCHTREE_SWAP_FILE: path.join(root, 'swap', 'archtree.swap'),
    ARCHTREE_SWAP_FSTAB: path.join(root, 'fstab'),
    ARCHTREE_SWAPON_BIN: path.join(bin, 'swapon'),
    ARCHTREE_MKSWAP_BIN: path.join(bin, 'mkswap'),
    ARCHTREE_FALLOCATE_BIN: path.join(bin, 'fallocate')
  };
  return { root, calls, environment };
};

test('the prebuild hook creates, enables and persists swap once', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const swapFile = fixture.environment.ARCHTREE_SWAP_FILE;

  await execFileAsync('bash', [hook], { env: fixture.environment });
  const calls = await readFile(fixture.calls, 'utf8');
  assert.match(calls, new RegExp(`fallocate -l 1024M ${swapFile.replace(/[.]/g, '\\.')}`));
  assert.match(calls, /mkswap /);
  assert.equal((await stat(swapFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(fixture.environment.ARCHTREE_SWAP_FSTAB, 'utf8'), `${swapFile} none swap defaults,nofail 0 0\n`);

  // Already active: nothing is recreated and fstab is not duplicated.
  await writeFile(fixture.calls, '');
  await execFileAsync('bash', [configurationHook], { env: fixture.environment });
  assert.doesNotMatch(await readFile(fixture.calls, 'utf8'), /fallocate|mkswap/);
  assert.equal((await readFile(fixture.environment.ARCHTREE_SWAP_FSTAB, 'utf8')).split('\n').filter(Boolean).length, 1);
});

test('the prebuild hook rejects an invalid size before touching the disk', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync('bash', [hook], { env: { ...fixture.environment, ARCHTREE_SWAP_MIB: '0' } }),
    { code: 1, stdout: /Invalid swap size/ }
  );
  assert.equal(await readFile(fixture.calls, 'utf8').catch(() => ''), '');
});
