import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promoteElasticBeanstalkArtifact, waitForSuccessfulReleaseRun } from '../scripts/promote-eb-artifact.mjs';
import { releaseArtifactName, releaseGates, releaseRepository, releaseWorkflow, writeReleaseProvenance } from '../scripts/release-provenance.mjs';
import { stageElasticBeanstalkArtifact } from '../scripts/stage-eb-artifact.mjs';
import { createSourceFixture } from './helpers/ebArtifactFixture';

const commitSha = 'a'.repeat(40);
const identity = { commitSha, runId: '12345', runAttempt: '2' };
const environment = { GITHUB_SHA: commitSha, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_REPOSITORY: releaseRepository, GITHUB_WORKFLOW: 'Finitude Web release gate',
  ...Object.fromEntries(releaseGates.map((gate: string) => [`RELEASE_${gate.toUpperCase()}_RESULT`, 'success'])) };
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Uses real ZIP encoding/extraction and artifact validation with an entirely synthetic HTTP transport. */
const fixture = async (t: { after: (fn: () => Promise<void>) => void }, mutation?: string) => {
  const source = await createSourceFixture();
  const promotionRoot = await mkdtemp(path.join(os.tmpdir(), 'eb-promotion-'));
  t.after(async () => { await rm(source, { recursive: true, force: true }); await rm(promotionRoot, { recursive: true, force: true }); });
  const { outputDirectory } = await stageElasticBeanstalkArtifact({ sourceRoot: source,
    outputDirectory: path.join(source, 'elastic-beanstalk-artifact'), environment });
  if (mutation === 'release-identity') await writeFile(path.join(outputDirectory, 'RELEASE.json'), JSON.stringify({ schemaVersion: 1, commitSha: 'b'.repeat(40), buildId: 'github-12345-2' }));
  if (mutation === 'release-extra-field') await writeFile(path.join(outputDirectory, 'RELEASE.json'), JSON.stringify({ schemaVersion: 1, commitSha, buildId: 'github-12345-2', privateField: 'never-log' }));
  const upload = path.join(source, 'upload'); await mkdir(upload);
  const bundlePath = path.join(upload, `archtree-eb-${commitSha}.zip`);
  const zip = (root: string, destination: string, unsafe?: string) => execFileSync('python3', ['-c',
    `import pathlib,stat,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for p in root.rglob('*'):
        if p.is_file(): z.write(p,p.relative_to(root).as_posix())
    mode=sys.argv[3] if len(sys.argv)>3 else ''
    if mode=='unsafe-zip': z.writestr('../escape','bad')
    if mode=='absolute-zip': z.writestr('/escape','bad')
    if mode=='conflicting-zip': z.writestr('src/app.ts/inside','bad')
    if mode=='symlink-zip':
        entry=zipfile.ZipInfo('src/link'); entry.create_system=3; entry.external_attr=(stat.S_IFLNK | 0o777)<<16
        z.writestr(entry,'../../escape')
`, root, destination, ...(unsafe ? [unsafe] : [])]);
  zip(outputDirectory, bundlePath, mutation?.endsWith('-zip') ? mutation : undefined);
  const outputPath = path.join(upload, 'release-provenance.json');
  const provenance = await writeReleaseProvenance({ bundlePath, outputPath, environment });
  if (mutation === 'bundle-tamper') await writeFile(bundlePath, 'tampered');
  if (mutation === 'missing-gate') await writeFile(outputPath, JSON.stringify({ ...provenance, gates: ['unit'] }));
  if (mutation === 'wrong-attempt') await writeFile(outputPath, JSON.stringify({ ...provenance, runAttempt: '1' }));
  const archive = path.join(source, 'artifact.zip'); zip(upload, archive);
  const bytes = await readFile(archive);
  const run: any = { id: 12345, run_attempt: 2, head_sha: commitSha, event: 'push', head_branch: 'main', path: releaseWorkflow,
    repository: { full_name: releaseRepository, id: 10 }, head_repository: { full_name: releaseRepository, id: 10 }, status: 'completed', conclusion: 'success' };
  const artifact: any = { id: 55, name: releaseArtifactName(identity), expired: false, digest: digest(bytes), size_in_bytes: bytes.length,
    workflow_run: { id: run.id, head_sha: commitSha, head_branch: 'main', repository_id: 10, head_repository_id: 10 } };
  let downloaded = false; let runRead = false;
  const fetchImpl = async (url: string, options: any) => {
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (url.includes('/workflows/')) return json({ total_count: 1, workflow_runs: [run] });
    if (url.endsWith('/artifacts?per_page=100')) return json({ total_count: 1, artifacts: [artifact] });
    if (url.endsWith('/artifacts/55/zip')) return new Response(null, { status: 302, headers: { location: 'https://release.blob.core.windows.net/signed?private=do-not-log' } });
    if (url.startsWith('https://release.blob.core.windows.net/')) {
      downloaded = true; assert.equal(options.headers, undefined, 'No GitHub token is sent to blob storage');
      return new Response(mutation === 'download-tamper' ? Buffer.from('tampered') : bytes);
    }
    if (url.endsWith('/actions/runs/12345')) { runRead = true; return json(mutation === 'rerun-race' ? { ...run, run_attempt: 3 } : run); }
    throw new Error('Unexpected test request');
  };
  return { promotionRoot, outputDirectory, run, artifact, bytes, fetchImpl,
    promote: () => promoteElasticBeanstalkArtifact({ sourceRoot: promotionRoot, environment: { CODEBUILD_RESOLVED_SOURCE_VERSION: commitSha, GITHUB_ARTIFACT_TOKEN: 'synthetic-secret', ARCHTREE_RELEASE_WAIT_SECONDS: '0' }, fetchImpl }),
    state: () => ({ downloaded, runRead }) };
};

test('offline promotion retains tested runtime bytes, executable hooks and original GitHub identity', async t => {
  const f = await fixture(t); const result = await f.promote();
  assert.deepEqual(result.release, { schemaVersion: 1, commitSha, buildId: 'github-12345-2' });
  assert.deepEqual(await readFile(path.join(result.outputDirectory, 'src/app.ts')), await readFile(path.join(f.outputDirectory, 'src/app.ts')));
  assert.deepEqual(f.state(), { downloaded: true, runRead: true });
  assert.deepEqual(await readdir(f.promotionRoot), ['elastic-beanstalk-artifact']);
});

for (const mutation of ['download-tamper', 'bundle-tamper', 'missing-gate', 'wrong-attempt', 'release-identity', 'release-extra-field', 'unsafe-zip', 'absolute-zip', 'conflicting-zip', 'symlink-zip', 'rerun-race']) {
  test(`promotion fails closed for ${mutation} and leaves no deployable output`, async t => {
    const f = await fixture(t, mutation); await assert.rejects(f.promote());
    assert.deepEqual(await readdir(f.promotionRoot), []);
  });
}
for (const [name, mutate] of [
  ['failed run', (f: any) => { f.run.conclusion = 'failure'; }],
  ['pending run', (f: any) => { f.run.status = 'in_progress'; }],
  ['pull request', (f: any) => { f.run.event = 'pull_request'; }],
  ['fork', (f: any) => { f.run.head_repository.id = 11; }],
  ['wrong commit', (f: any) => { f.run.head_sha = 'b'.repeat(40); }],
  ['wrong workflow', (f: any) => { f.run.path = '.github/workflows/other.yml'; }],
  ['expired artifact', (f: any) => { f.artifact.expired = true; }],
  ['missing digest', (f: any) => { delete f.artifact.digest; }],
  ['oversize artifact', (f: any) => { f.artifact.size_in_bytes = 2 ** 30; }]
] as const) {
  test(`rejects ${name} before downloading application bytes`, async t => {
    const f = await fixture(t); mutate(f); await assert.rejects(f.promote());
    assert.equal(f.state().downloaded, false); assert.deepEqual(await readdir(f.promotionRoot), []);
  });
}

test('promotion preserves an existing output directory and fails before network access', async t => {
  const f = await fixture(t); const output = path.join(f.promotionRoot, 'elastic-beanstalk-artifact');
  await mkdir(output); await writeFile(path.join(output, 'sentinel'), 'preserve');
  await assert.rejects(f.promote(), /already exists/);
  assert.equal(await readFile(path.join(output, 'sentinel'), 'utf8'), 'preserve');
});


test('a source-triggered promotion waits for the exact run to finish and then uses that attempt', async t => {
  const f = await fixture(t); let elapsed = 0; let calls = 0;
  const run = await waitForSuccessfulReleaseRun({ commitSha, waitSeconds: 60, now: () => elapsed,
    lookup: async () => ({ total_count: ++calls === 1 ? 0 : 1,
      workflow_runs: calls === 1 ? [] : [{ ...f.run, status: calls === 2 ? 'in_progress' : 'completed' }] }),
    sleep: async (milliseconds: number) => { elapsed += milliseconds; } });
  assert.equal(run.id, f.run.id); assert.equal(calls, 3); assert.equal(elapsed, 60_000);
});

test('a newer failed run prevents promotion of an older success', async t => {
  const f = await fixture(t);
  await assert.rejects(waitForSuccessfulReleaseRun({ commitSha, waitSeconds: 60,
    lookup: async () => ({ total_count: 2, workflow_runs: [f.run, { ...f.run, id: 12346, conclusion: 'failure' }] }),
    sleep: async () => assert.fail('A failed gate must not be polled until it passes.') }), /no completed successful/);
});

test('an absent exact gate exhausts a bounded wait without using another SHA', async () => {
  let elapsed = 0;
  await assert.rejects(waitForSuccessfulReleaseRun({ commitSha, waitSeconds: 10, now: () => elapsed,
    lookup: async () => ({ total_count: 0, workflow_runs: [] }),
    sleep: async (milliseconds: number) => { elapsed += milliseconds; } }), /no completed successful/);
  assert.equal(elapsed, 10_000);
});
