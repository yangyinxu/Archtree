import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Elastic Beanstalk reads .ebextensions as YAML on Linux and the artifact stager copies the working tree,
// so .gitattributes pins these files to LF. Linux checkouts never convert line endings, so the rule itself
// is checked too; otherwise only a Windows checkout would notice it was dropped.
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

test('Elastic Beanstalk configuration is pinned to LF and checked out that way', async () => {
    const configs = (await readdir(path.join(repositoryRoot, '.ebextensions')))
        .filter(name => name.endsWith('.config')).sort().map(name => `.ebextensions/${name}`);
    assert.ok(configs.length > 0, 'the deployment ships Elastic Beanstalk configuration');
    const attributes = execFileSync('git', ['check-attr', 'eol', '--', ...configs], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.deepEqual(attributes.trim().split('\n'), configs.map(config => `${config}: eol: lf`));
    for (const config of configs) {
        const source = await readFile(path.join(repositoryRoot, config), 'utf8');
        // Git leaves files checked out before the rule untouched, so a stale CRLF copy needs a fresh checkout.
        assert.ok(!source.includes('\r'), `${config} has CRLF line endings; delete it and run git checkout -- ${config}`);
    }
});
