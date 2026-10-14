import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = path.join(root, 'test/fixtures/personalization/v1');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const targets = [
  path.resolve(root, '../Finitude_iOS/Finitude_iOSTests/Fixtures/Personalization/v1'),
  path.resolve(root, '../Finitude_Android/app/src/test/resources/personalization/v1')
];
const check = process.argv.includes('--check');

/** Pins one synthetic corpus so every client proves the same IDs, order, and reasons. */
for (const [filename, expected] of Object.entries(manifest.files)) {
  const bytes = await readFile(path.join(source, filename));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected) throw new Error(`Fixture manifest mismatch: ${filename}`);
}
for (const target of targets) {
  if (!check) await mkdir(target, { recursive: true });
  for (const filename of [...Object.keys(manifest.files), 'manifest.json']) {
    if (check) {
      const [canonical, client] = await Promise.all([
        readFile(path.join(source, filename)), readFile(path.join(target, filename))
      ]);
      if (!canonical.equals(client)) throw new Error(`Client fixture differs: ${target}/${filename}`);
    } else {
      await copyFile(path.join(source, filename), path.join(target, filename));
    }
  }
}
console.log(check ? 'Personalization fixtures are identical.' : 'Personalization fixtures synchronized.');
