import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stageElasticBeanstalkArtifact } from '../scripts/stage-eb-artifact.mjs';

const commitSha = 'a'.repeat(40);

import { createSourceFixture, writeFixtureFile } from './helpers/ebArtifactFixture';

const stageFixture = async (sourceRoot: string) => {
  const outputDirectory = path.join(sourceRoot, 'elastic-beanstalk-artifact');
  return stageElasticBeanstalkArtifact({
    sourceRoot,
    outputDirectory,
    environment: {
      GITHUB_SHA: commitSha,
      GITHUB_RUN_ID: '12345',
      GITHUB_RUN_ATTEMPT: '2'
    }
  });
};

test('stages only the Elastic Beanstalk allowlist with bounded release metadata', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const { outputDirectory } = await stageFixture(sourceRoot);
  assert.deepEqual((await readdir(outputDirectory)).sort(), [
    '.archtree-eb-artifact',
    '.ebextensions',
    '.platform',
    'RELEASE.json',
    'localization',
    'package-lock.json',
    'package.json',
    'src',
    'tsconfig.json',
    'web'
  ]);
  assert.deepEqual((await readdir(path.join(outputDirectory, 'web'))).sort(), ['dist', 'package.json']);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(outputDirectory, 'RELEASE.json'), 'utf8')),
    { schemaVersion: 1, commitSha, buildId: 'github-12345-2' }
  );
  await assert.rejects(readFile(path.join(outputDirectory, 'README.md')), { code: 'ENOENT' });
  assert.match(
    await readFile(path.join(outputDirectory, 'web/dist/.vite/manifest.json'), 'utf8'),
    /index-AbCd1234\.js/
  );
});

for (const [label, forbiddenPath] of [
  ['nested node_modules', 'src/node_modules/cache.js'],
  ['environment files', 'web/dist/.env.production'],
  ['test reports', 'web/dist/test-results/report.xml'],
  ['registry credentials', 'src/.npmrc'],
  ['credential documents', 'src/credentials.json'],
  ['private keys', '.platform/private-key.pem']
] as const) {
  test(`rejects ${label} from allowlisted source paths`, async (t) => {
    const sourceRoot = await createSourceFixture();
    t.after(() => rm(sourceRoot, { recursive: true, force: true }));
    await writeFixtureFile(sourceRoot, forbiddenPath, 'forbidden\n');

    await assert.rejects(stageFixture(sourceRoot), /forbidden|environment file|credential file/i);
  });
}

test('rejects an unmanifested file outside the listener assets directory', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await writeFixtureFile(sourceRoot, 'web/dist/stale-build.txt', 'stale\n');

  await assert.rejects(stageFixture(sourceRoot), /unexpected file/i);
});

for (const relativeOutput of ['docs', 'test', '.git']) {
  test(`rejects the arbitrary ${relativeOutput} output directory without changing it`, async (t) => {
    const sourceRoot = await createSourceFixture();
    t.after(() => rm(sourceRoot, { recursive: true, force: true }));
    const outputDirectory = path.join(sourceRoot, relativeOutput);
    await writeFixtureFile(sourceRoot, `${relativeOutput}/sentinel.txt`, 'preserve me\n');

    await assert.rejects(stageElasticBeanstalkArtifact({
      sourceRoot,
      outputDirectory,
      environment: { GITHUB_SHA: commitSha }
    }), /restricted/i);
    assert.equal(await readFile(path.join(outputDirectory, 'sentinel.txt'), 'utf8'), 'preserve me\n');
  });
}

test('refuses to replace an unmarked dedicated artifact directory', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const outputDirectory = path.join(sourceRoot, 'elastic-beanstalk-artifact');
  await writeFixtureFile(sourceRoot, 'elastic-beanstalk-artifact/sentinel.txt', 'preserve me\n');

  await assert.rejects(stageElasticBeanstalkArtifact({
    sourceRoot,
    outputDirectory,
    environment: { GITHUB_SHA: commitSha }
  }), /unowned/i);
  assert.equal(await readFile(path.join(outputDirectory, 'sentinel.txt'), 'utf8'), 'preserve me\n');
});

test('stages a clean local Git worktree before creating its temporary output', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Artifact Test'],
    ['config', 'user.email', 'artifact-test@example.invalid'],
    ['add', '.'],
    ['commit', '-q', '--no-gpg-sign', '-m', 'fixture']
  ]) {
    execFileSync('git', args, { cwd: sourceRoot, stdio: 'ignore' });
  }

  const { release } = await stageElasticBeanstalkArtifact({
    sourceRoot,
    outputDirectory: path.join(sourceRoot, 'elastic-beanstalk-artifact'),
    environment: {}
  });
  assert.match(release.commitSha, /^[0-9a-f]{40}$/);
  assert.equal(release.buildId, 'local');
});

test('refuses to label a dirty local worktree as its current commit', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Artifact Test'],
    ['config', 'user.email', 'artifact-test@example.invalid'],
    ['add', '.'],
    ['commit', '-q', '--no-gpg-sign', '-m', 'fixture']
  ]) {
    execFileSync('git', args, { cwd: sourceRoot, stdio: 'ignore' });
  }
  await writeFixtureFile(sourceRoot, 'src/app.ts', 'export const app = "dirty";\n');

  await assert.rejects(stageElasticBeanstalkArtifact({
    sourceRoot,
    outputDirectory: path.join(sourceRoot, 'elastic-beanstalk-artifact'),
    environment: {}
  }), /commit local changes/i);
});

test('rejects an empty forbidden directory from an allowlisted source path', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceRoot, 'src/node_modules'), { recursive: true });

  await assert.rejects(stageFixture(sourceRoot), /forbidden path component/i);
});

test('rejects an artifact without the HTTPS recovery hook', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await rm(path.join(sourceRoot, '.platform/hooks/postdeploy/02_install_certbot_timer.sh'));

  await assert.rejects(stageFixture(sourceRoot), /required Elastic Beanstalk deployment file/i);
});

test('rejects an artifact without the port 443 security-group contract', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await rm(path.join(sourceRoot, '.ebextensions/https-instance.config'));

  await assert.rejects(stageFixture(sourceRoot), /required Elastic Beanstalk deployment file/i);
});

test('rejects a manifest reference whose asset is not content-hashed', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await writeFixtureFile(
    sourceRoot,
    'web/dist/.vite/manifest.json',
    `${JSON.stringify({
      'index.html': {
        file: 'assets/index.js',
        css: ['assets/index-XyZ_5678.css'],
        isEntry: true
      }
    })}\n`
  );
  await writeFixtureFile(sourceRoot, 'web/dist/assets/index.js', 'console.log("unhashed");\n');

  await assert.rejects(stageFixture(sourceRoot), /not content-hashed/i);
});

test('rejects a manifest reference to a missing emitted asset', async (t) => {
  const sourceRoot = await createSourceFixture();
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await writeFixtureFile(
    sourceRoot,
    'web/dist/.vite/manifest.json',
    `${JSON.stringify({
      'index.html': {
        file: 'assets/missing-AbCd1234.js',
        css: ['assets/index-XyZ_5678.css'],
        isEntry: true
      }
    })}\n`
  );

  await assert.rejects(stageFixture(sourceRoot), /Vite manifest asset is missing/i);
});
