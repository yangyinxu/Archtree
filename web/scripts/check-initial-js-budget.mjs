import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const initialRouteBudgetBytes = 150 * 1024;
const distributionRoot = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', distributionRoot), 'utf8'));

/** Collects the unique JavaScript files needed to enter one route bundle. */
const collectJavaScript = (manifestKey, files = new Set(), visited = new Set()) => {
  if (visited.has(manifestKey)) return files;
  visited.add(manifestKey);
  const entry = manifest[manifestKey];
  if (!entry) throw new Error(`Listener manifest is missing ${manifestKey}.`);
  if (String(entry.file).endsWith('.js')) files.add(entry.file);
  for (const importedKey of entry.imports ?? []) {
    collectJavaScript(importedKey, files, visited);
  }
  return files;
};

/** Measures transferred gzip bytes because route splitting creates several requests. */
const compressedSize = (files) => [...files].reduce((total, file) => (
  total + gzipSync(readFileSync(new URL(file, distributionRoot))).byteLength
), 0);

const routeEntries = Object.entries(manifest)
  .filter(([, entry]) => entry.isEntry || entry.isDynamicEntry)
  .map(([key, entry]) => ({
    key,
    name: entry.name ?? key,
    bytes: compressedSize(collectJavaScript(key))
  }));

if (!routeEntries.length) throw new Error('Listener manifest contains no route entries.');
const largest = routeEntries.sort((left, right) => right.bytes - left.bytes)[0];
const measuredKib = (largest.bytes / 1024).toFixed(1);
if (largest.bytes > initialRouteBudgetBytes) {
  throw new Error(
    `${largest.name} requires ${measuredKib} KiB of initial gzip JavaScript; `
    + `the reviewed listener budget is ${initialRouteBudgetBytes / 1024} KiB.`
  );
}

console.log(
  `Initial listener JavaScript: ${largest.name} ${measuredKib} KiB gzip `
  + `(budget ${initialRouteBudgetBytes / 1024} KiB).`
);
