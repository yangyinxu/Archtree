import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build, type ConfigEnv } from 'vite';

import webConfig from '../web/vite.config';

/** Exercises the real CSS Module transform rather than matching configuration source text. */
test('production CSS modules compact identifiers while preserving exports and style bindings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archtree-css-module-policy-'));
  try {
    await writeFile(path.join(root, 'entry.js'), 'import styles from "./fixture.module.css"; export { styles };\n');
    await writeFile(path.join(root, 'fixture.module.css'),
      '.longQueueMetadataClassName { color: rgb(12, 34, 56); }\n.otherQueueClassName { display: grid; }\n');
    const environment: ConfigEnv = { command: 'build', mode: 'production' };
    const configuration = typeof webConfig === 'function' ? await webConfig(environment) : await webConfig;
    const result = await build({
      root, configFile: false, css: configuration.css, logLevel: 'silent',
      build: { write: false, minify: false, cssMinify: false,
        lib: { entry: path.join(root, 'entry.js'), formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' } }
    });
    assert.ok(!('close' in result), 'The fixture must produce a completed bundle.');
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
    const javascript = outputs.find(output => output.type === 'chunk' && output.isEntry);
    const stylesheet = outputs.find(output => output.type === 'asset' && output.fileName.endsWith('.css'));
    assert.ok(javascript?.type === 'chunk' && stylesheet?.type === 'asset');
    const generated = await import(`data:text/javascript;base64,${Buffer.from(javascript.code).toString('base64')}`);
    assert.deepEqual(Object.keys(generated.styles).sort(), ['longQueueMetadataClassName', 'otherQueueClassName']);
    for (const className of Object.values(generated.styles)) {
      assert.equal(typeof className, 'string');
      assert.match(className as string, /^f_[A-Za-z0-9_-]{6}$/);
      assert.ok(String(stylesheet.source).includes(`.${className} {`));
    }
    assert.notEqual(generated.styles.longQueueMetadataClassName, generated.styles.otherQueueClassName);
    assert.ok(String(stylesheet.source).includes('color: rgb(12, 34, 56)'));
    assert.ok(String(stylesheet.source).includes('display: grid'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development and test CSS module identifiers keep Vite readable defaults', async () => {
  for (const environment of [
    { command: 'serve', mode: 'development' },
    { command: 'serve', mode: 'test' },
    { command: 'build', mode: 'test' }
  ] as const) {
    const configuration = typeof webConfig === 'function' ? await webConfig(environment) : await webConfig;
    assert.equal(configuration.css?.modules?.generateScopedName, undefined);
  }
});
