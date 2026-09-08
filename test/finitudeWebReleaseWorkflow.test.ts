import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
