import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/finitude-web-release.yml', import.meta.url);

/** Protects the CI trigger contract that prevents duplicate develop-PR runs. */
test('Finitude Web release gate runs for pull requests and main pushes only', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const triggerBlock = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1];

  assert.equal(
    triggerBlock?.trimEnd(),
    ['  pull_request:', '  push:', '    branches:', '      - main'].join('\n')
  );
});
