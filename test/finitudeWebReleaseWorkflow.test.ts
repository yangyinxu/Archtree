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

/** Splits one job block into its steps; each step starts with `- name:` at six spaces. */
const stepBlocks = (job: string) => job.split(/^ {6}- name: /m).slice(1).map(step => ({ name: step.split('\n')[0], body: step }));

test('only the quarantined cross-engine audio projects run outside the blocking social gate', async () => {
  const jobs = jobBlocks((await readFile(workflowUrl, 'utf8')).replace(/\r\n/g, '\n'));
  const social = jobs.get('social-e2e')!;
  const steps = stepBlocks(social);
  const gate = steps.find(step => /^ {8}id: social$/m.test(step.body));
  const quarantined = steps.find(step => /^ {8}id: social_quarantined$/m.test(step.body));
  assert.ok(gate && quarantined, 'social-e2e must keep the blocking gate step and the quarantined step.');
  assert.ok(gate.body.includes('run: xvfb-run -a npm run test:e2e:social --workspace @archtree/finitude-web\n'));
  assert.doesNotMatch(gate.body, /continue-on-error|^ {8}if:/m, 'The blocking social step must fail the job.');
  assert.ok(steps.indexOf(gate) < steps.indexOf(quarantined));
  assert.ok(quarantined.body.includes('run: xvfb-run -a npm run test:e2e:social:quarantined --workspace @archtree/finitude-web\n'));
  assert.match(quarantined.body, /^ {8}continue-on-error: true$/m);
  // It runs after a failed gate too, so its evidence exists whenever the browser environment does.
  assert.match(quarantined.body, /^ {8}if: \$\{\{ !cancelled\(\) && steps\.browser_environment\.outcome == 'success' \}\}$/m);
  assert.match(quarantined.name, /quarantined.*non-blocking/i);
  // No other step in any gate job may ignore its own failure.
  for (const name of gateJobs) {
    for (const step of stepBlocks(jobs.get(name)!)) {
      if (step.body !== quarantined.body) assert.doesNotMatch(step.body, /continue-on-error/, `${name}: ${step.name} must stay blocking`);
    }
  }
  // Release provenance records only the blocking social outcome.
  assert.match(social, /^ {6}social: \$\{\{ steps\.social\.outcome \}\}$/m);
  assert.doesNotMatch(social, /^ {6}[a-z0-9_]+: \$\{\{ steps\.social_quarantined\./m);
  assert.doesNotMatch(jobs.get('release-artifact')!, /quarantined/);
});

test('the quarantined social result is announced as non-blocking and its evidence is retained', async () => {
  const steps = stepBlocks(jobBlocks((await readFile(workflowUrl, 'utf8')).replace(/\r\n/g, '\n')).get('social-e2e')!);
  const report = steps.find(step => step.body.includes('steps.social_quarantined.outcome }}'));
  assert.ok(report, 'A step must report the quarantined outcome.');
  assert.match(report.body, /^ {8}if: \$\{\{ !cancelled\(\) && steps\.social_quarantined\.outcome != 'skipped' \}\}$/m);
  assert.ok(report.body.includes('>> "$GITHUB_STEP_SUMMARY"'));
  assert.ok(report.body.includes('::warning title=Quarantined social projects'));
  for (const project of ['firefox-audio-formats', 'webkit-audio-formats', 'non-blocking', 'FINITUDE_ROOMS_ENABLED']) {
    assert.ok(report.body.includes(project), `The quarantine report must mention ${project}`);
  }
  const evidence = steps.find(step => step.body.includes('name: finitude-social-browser-evidence'))!;
  for (const directory of ['web/test-results/social-real', 'web/test-results/social-quarantined']) {
    assert.match(evidence.body, new RegExp(`^ {12}${directory}$`, 'm'));
  }
});
