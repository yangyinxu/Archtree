import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { releaseGates } from '../scripts/release-provenance.mjs';

const workflowUrl = new URL('../.github/workflows/finitude-web-release.yml', import.meta.url);

/** Protects the CI trigger contract that prevents duplicate develop-PR runs. */
test('Finitude Web release gate runs for pull requests and main pushes only', async () => {
  const workflow = (await readFile(workflowUrl, 'utf8')).replace(/\r\n/g, '\n');
  const triggerBlock = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1];

  assert.equal(
    triggerBlock?.trimEnd(),
    ['  pull_request:', '  push:', '    branches:', '      - main'].join('\n')
  );
});

test('release CI keeps the Linux host, pinned runtime, and complete test matrix', async () => {
  const workflow = (await readFile(workflowUrl, 'utf8')).replace(/\r\n/g, '\n');
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /node-version-file: \.nvmrc/);
  for (const command of ['npm run doctor:release', 'npm test', 'npm run test:integration', 'npm run build', 'npm run test:e2e --workspace @archtree\/finitude-web']) {
    assert.ok(workflow.includes(command), `Release CI must retain ${command}`);
  }
});

test('rollback archives retain the engineering bundle required during promotion', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const archiveStep = workflow.split('Create the versioned Elastic Beanstalk rollback bundle')[1]
    ?.split('Bind the tested bundle')[0];
  assert.ok(archiveStep, 'The tested runtime must be archived for promotion.');
  assert.match(archiveStep, /zip -q -r/);
  for (const directory of ['web', 'engineering']) {
    assert.match(archiveStep, new RegExp(`\\b${directory}(?:\\s|$)`));
  }
});

/** Splits the top-level jobs mapping into raw blocks without a YAML dependency; job keys sit at two spaces. */
const jobBlocks = (workflow: string) => {
  const jobsSection = workflow.split(/^jobs:\n/m)[1] ?? '';
  const blocks = new Map<string, string>();
  let current: string | undefined;
  for (const line of jobsSection.split('\n')) {
    const key = line.match(/^ {2}([a-z0-9-]+):$/)?.[1];
    if (key) { current = key; blocks.set(key, ''); continue; }
    if (current) blocks.set(current, `${blocks.get(current)}${line}\n`);
  }
  return blocks;
};
const gateJobs = ['build', 'unit-integration', 'social-e2e', 'browser-e2e'];
const buildArtifact = 'finitude-web-release-build';

test('release gates run as parallel bounded jobs that finish inside the promotion wait', async () => {
  const jobs = jobBlocks((await readFile(workflowUrl, 'utf8')).replace(/\r\n/g, '\n'));
  assert.deepEqual([...jobs.keys()], [...gateJobs, 'release-artifact']);
  for (const [name, block] of jobs) {
    const timeout = Number(block.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
    assert.ok(timeout > 0 && timeout <= 30, `${name} needs a timeout of at most 30 minutes`);
    assert.match(block, /^ {4}runs-on: ubuntu-24\.04$/m);
  }
  // Only the browser suites wait for the shared build; unit and integration start immediately.
  assert.doesNotMatch(jobs.get('build')!, /^ {4}needs:/m);
  assert.doesNotMatch(jobs.get('unit-integration')!, /^ {4}needs:/m);
  for (const name of ['social-e2e', 'browser-e2e']) assert.match(jobs.get(name)!, /^ {4}needs: build$/m);
});

test('the release bundle is staged only after every gate job succeeds and binds each gate outcome', async () => {
  const jobs = jobBlocks((await readFile(workflowUrl, 'utf8')).replace(/\r\n/g, '\n'));
  const release = jobs.get('release-artifact')!;
  assert.match(release, new RegExp(`^ {4}needs: \\[${gateJobs.join(', ')}\\]$`, 'm'));
  // A job-level condition such as always() would let staging run after a failed gate.
  assert.doesNotMatch(release, /^ {4}if:/m);
  const outputs = new Map<string, string>();
  for (const name of gateJobs) {
    const block = jobs.get(name)!;
    for (const [, output, step] of block.matchAll(/^ {6}([a-z0-9_]+): \$\{\{ steps\.([a-z0-9_]+)\.outcome \}\}$/gm)) {
      assert.equal(output, step, `${name} must export each gate step outcome under its own id`);
      assert.match(block, new RegExp(`^ {8}id: ${step}$`, 'm'), `${name} must define step ${step}`);
      outputs.set(step, name);
    }
  }
  for (const gate of releaseGates) {
    const binding = release.match(new RegExp(`^ {10}RELEASE_${gate.toUpperCase()}_RESULT: (.+)$`, 'm'))?.[1];
    if (gate === 'staging') {
      assert.equal(binding, '${{ steps.staging.outcome }}');
      assert.match(release, /^ {8}id: staging$/m);
    } else {
      assert.ok(outputs.has(gate), `A gate job must export ${gate}`);
      assert.equal(binding, `\${{ needs.${outputs.get(gate)}.outputs.${gate} }}`);
    }
  }
  assert.ok(release.includes('name: archtree-eb-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.ok(release.includes('run: node scripts/write-release-provenance.mjs'));
  assert.ok(release.includes('run: npm run stage:eb-artifact'));
});

test('one production build is tested by both browser gates and staged without rebuilding', async () => {
  const jobs = jobBlocks((await readFile(workflowUrl, 'utf8')).replace(/\r\n/g, '\n'));
  const build = jobs.get('build')!;
  assert.ok(build.includes('run: npm run build'));
  assert.ok(build.includes(`name: ${buildArtifact}`));
  // web/dist/.vite/manifest.json is hidden and required by artifact staging.
  assert.match(build, /include-hidden-files: true/);
  assert.match(build, /if-no-files-found: error/);
  for (const directory of ['web/dist', 'engineering/dist']) assert.match(build, new RegExp(`^ {12}${directory}$`, 'm'));
  for (const name of ['social-e2e', 'browser-e2e', 'release-artifact']) {
    const block = jobs.get(name)!;
    assert.ok(block.includes('uses: actions/download-artifact@'), `${name} must download the shared build`);
    assert.ok(block.includes(`name: ${buildArtifact}`));
    assert.ok(!block.includes('npm run build'), `${name} must not rebuild the tested bytes`);
  }
});

test('browser evidence is retained even when a browser gate fails', async () => {
  const jobs = jobBlocks((await readFile(workflowUrl, 'utf8')).replace(/\r\n/g, '\n'));
  const evidence = { 'social-e2e': 'finitude-social-browser-evidence', 'browser-e2e': 'finitude-web-browser-evidence' };
  for (const [name, artifact] of Object.entries(evidence)) {
    const step = jobs.get(name)!.split(`name: ${artifact}`)[0].split('- name: ').at(-1)!;
    assert.match(step, /if: \$\{\{ !cancelled\(\)/, `${artifact} must upload after a failed gate`);
  }
});
