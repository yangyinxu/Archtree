import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { releaseGates, releaseRepository, writeReleaseProvenance, validateReleaseProvenance } from '../scripts/release-provenance.mjs';

const identity = { commitSha: 'a'.repeat(40), runId: '12345', runAttempt: '2' };
const environment = { GITHUB_SHA: identity.commitSha, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: identity.runAttempt,
  GITHUB_REPOSITORY: releaseRepository, GITHUB_WORKFLOW: 'Finitude Web release gate',
  ...Object.fromEntries(releaseGates.map((gate: string) => [`RELEASE_${gate.toUpperCase()}_RESULT`, 'success'])) };

test('provenance binds bytes and all gates to the exact workflow attempt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, 'bundle.zip'); const outputPath = path.join(root, 'release-provenance.json');
  await writeFile(bundlePath, 'synthetic bundle');
  const provenance = await writeReleaseProvenance({ bundlePath, outputPath, environment });
  assert.deepEqual(validateReleaseProvenance(provenance, identity), JSON.parse(await readFile(outputPath, 'utf8')));
  for (const changed of [{ commitSha: 'b'.repeat(40) }, { runAttempt: '1' }, { runId: '456' }]) {
    assert.throws(() => validateReleaseProvenance(provenance, { ...identity, ...changed }), /does not match/);
  }
  assert.throws(() => validateReleaseProvenance({ ...provenance, gates: releaseGates.slice(1) }, identity), /does not match/);
  assert.throws(() => validateReleaseProvenance({ ...provenance, untrusted: true }, identity), /does not match/);
});

for (const gate of releaseGates) {
  for (const outcome of ['failure', 'skipped', 'cancelled', undefined]) {
    test(`does not publish provenance when ${gate} is ${outcome}`, async () => {
      await assert.rejects(writeReleaseProvenance({ bundlePath: 'never-read', outputPath: 'never-written',
        environment: { ...environment, [`RELEASE_${gate.toUpperCase()}_RESULT`]: outcome } }), /did not pass/);
    });
  }
}

test('both browser release configurations reject focused tests in CI', async () => {
  // Inspect the actual exported configs in a separate CI process without launching a browser or server.
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "const a = (await import('./web/playwright.config.ts')).default; const b = (await import('./web/playwright.social.config.ts')).default; if (a.forbidOnly !== true || b.forbidOnly !== true) process.exit(1);"],
  { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, CI: 'true' }, encoding: 'utf8' });
  assert.equal(output, '');
});
