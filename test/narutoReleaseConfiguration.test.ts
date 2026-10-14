import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {narutoReleaseConfiguration, writeNarutoReleaseConfiguration} from '../scripts/naruto-release-configuration.mjs';

const commit = 'a'.repeat(40);
const trustedEvent = {eventName: 'push', ref: 'refs/heads/main'};

test('Naruto release configuration is optional and enabled only for an immutable main-push source', () => {
  assert.deepEqual(narutoReleaseConfiguration(trustedEvent), {enabled: false, commit: ''});
  assert.deepEqual(narutoReleaseConfiguration({...trustedEvent, sourceCommit: ''}), {enabled: false, commit: ''});
  assert.deepEqual(narutoReleaseConfiguration({...trustedEvent, sourceCommit: commit}), {enabled: true, commit});
  assert.deepEqual(narutoReleaseConfiguration({...trustedEvent, sourceCommit: commit.toUpperCase()}), {enabled: true, commit});
  for (const event of [{eventName: 'pull_request', ref: 'refs/pull/1/merge'},
    {eventName: 'pull_request', ref: 'refs/heads/main'}, {eventName: 'push', ref: 'refs/heads/develop'},
    {eventName: 'workflow_dispatch', ref: 'refs/heads/main'}]) {
    assert.deepEqual(narutoReleaseConfiguration({...event, sourceCommit: commit}), {enabled: false, commit: ''});
  }
});

test('Naruto source identities reject branches, short hashes and shell or output injection', () => {
  for (const sourceCommit of ['main', 'develop', 'v1.0', 'a'.repeat(39), 'a'.repeat(41),
    'g'.repeat(40), ` ${commit}`, `${commit}\n`, `${commit}; echo leaked`, '$(printenv)',
    `${commit}\nenabled=true`, 1234, null]) {
    assert.throws(() => narutoReleaseConfiguration({...trustedEvent, sourceCommit}), /complete 40-character/);
  }
});

test('release step outputs contain only validated values and never source credentials', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'naruto-ci-configuration-'));
  context.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await rm(root, {recursive: true, force: true});
  });
  const output = path.join(root, 'outputs');
  const environment = {NARUTO_SOURCE_COMMIT: commit, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
    GITHUB_OUTPUT: output, NARUTO_SOURCE_TOKEN: 'synthetic-token-never-written'};
  await writeNarutoReleaseConfiguration(environment);
  assert.equal(await readFile(output, 'utf8'), `enabled=true\ncommit=${commit}\n`);
  await assert.rejects(writeNarutoReleaseConfiguration({...environment, NARUTO_SOURCE_COMMIT: 'main'}), /complete 40-character/);
  assert.equal(await readFile(output, 'utf8'), `enabled=true\ncommit=${commit}\n`);
});

/** Guards both artifact transfers so prepared bytes cannot disappear before production deployment. */
test('the release workflow checks, tests and carries the optional Naruto distribution into its final ZIP', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/finitude-web-release.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const build = workflow.split(/^  build:\n/m)[1]?.split(/^  unit-integration:\n/m)[0];
  const release = workflow.split(/^  release-artifact:\n/m)[1];
  assert.ok(build && release);
  assert.match(build, /NARUTO_SOURCE_COMMIT: \$\{\{ vars\.NARUTO_SOURCE_COMMIT \}\}/);
  assert.match(build, /run: node scripts\/naruto-release-configuration\.mjs/);
  const checkout = build.split('name: Check out the pinned Naruto source')[1]?.split(/\n {6}- name:/)[0];
  assert.ok(checkout);
  assert.match(checkout, /if: \$\{\{ steps\.naruto_release\.outputs\.enabled == 'true' \}\}/);
  assert.match(checkout, /repository: yangyinxu\/naruto-mobile/);
  assert.match(checkout, /ref: \$\{\{ steps\.naruto_release\.outputs\.commit \}\}/);
  assert.match(checkout, /path: \.naruto-source/);
  assert.match(checkout, /persist-credentials: false/);
  for (const command of ['npm ci', 'npx playwright install --with-deps chromium', 'npm test',
    'npm run prepare:naruto-web -- .naruto-source', 'npm run smoke:naruto-web']) assert.ok(build.includes(command), command);
  assert.ok(build.indexOf('name: Test the pinned Naruto source') > build.indexOf('name: Install the Naruto source Chromium runtime'));
  assert.ok(build.indexOf('run: npm run smoke:naruto-web') > build.indexOf('run: npm run prepare:naruto-web'));
  assert.match(build, /^ {12}naruto-web\/dist$/m);
  assert.match(build, /include-hidden-files: true/);
  assert.doesNotMatch(build, /continue-on-error/);
  assert.doesNotMatch(build, /run:[^\n]*\$\{\{[^\n]*(?:NARUTO_SOURCE_COMMIT|NARUTO_SOURCE_TOKEN)/);
  assert.match(release, /NARUTO_RELEASE_ENABLED: \$\{\{ needs\.build\.outputs\.naruto_enabled \}\}/);
  assert.ok(release.includes('test -d naruto-web/dist'));
  assert.ok(release.includes('entries+=(naruto-web)'));
  assert.ok(release.includes('"${entries[@]}"'));
});
