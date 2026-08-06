import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const staticAssetBudgets = Object.freeze({
  cssGzipBytes: 32 * 1024,
  fontBytes: 128 * 1024,
  imageBytes: 256 * 1024,
  individualImageBytes: 128 * 1024
});

const fontExtensions = new Set(['.otf', '.ttf', '.woff', '.woff2']);
const imageExtensions = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);

/** Enumerates emitted files without trusting a manifest to list every copied asset. */
const listFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? listFiles(path) : [path];
});

/** Measures bounded transfer and decoded-file categories for the listener bundle. */
export const measureStaticAssets = (distributionRoot) => {
  const files = listFiles(resolve(distributionRoot));
  const css = files.filter((file) => extname(file).toLowerCase() === '.css');
  const fonts = files.filter((file) => fontExtensions.has(extname(file).toLowerCase()));
  const images = files.filter((file) => imageExtensions.has(extname(file).toLowerCase()));

  return {
    cssGzipBytes: css.reduce((total, file) => total + gzipSync(readFileSync(file)).byteLength, 0),
    fontBytes: fonts.reduce((total, file) => total + statSync(file).size, 0),
    imageBytes: images.reduce((total, file) => total + statSync(file).size, 0),
    largestImage: images
      .map((file) => ({ file: basename(file), bytes: statSync(file).size }))
      .sort((left, right) => right.bytes - left.bytes)[0] ?? null
  };
};

/** Rejects unreviewed style, font, or bundled-image growth before release. */
export const assertStaticAssetBudget = (measurement, budgets = staticAssetBudgets) => {
  const failures = [];
  if (measurement.cssGzipBytes > budgets.cssGzipBytes) {
    failures.push(`CSS is ${(measurement.cssGzipBytes / 1024).toFixed(1)} KiB gzip (budget ${budgets.cssGzipBytes / 1024} KiB)`);
  }
  if (measurement.fontBytes > budgets.fontBytes) {
    failures.push(`fonts are ${(measurement.fontBytes / 1024).toFixed(1)} KiB (budget ${budgets.fontBytes / 1024} KiB)`);
  }
  if (measurement.imageBytes > budgets.imageBytes) {
    failures.push(`bundled images are ${(measurement.imageBytes / 1024).toFixed(1)} KiB (budget ${budgets.imageBytes / 1024} KiB)`);
  }
  if (measurement.largestImage && measurement.largestImage.bytes > budgets.individualImageBytes) {
    failures.push(`${measurement.largestImage.file} is ${(measurement.largestImage.bytes / 1024).toFixed(1)} KiB (per-image budget ${budgets.individualImageBytes / 1024} KiB)`);
  }
  if (failures.length > 0) throw new Error(`Listener static-asset budget exceeded: ${failures.join('; ')}.`);
};

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  const distributionRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  const measurement = measureStaticAssets(distributionRoot);
  assertStaticAssetBudget(measurement);
  console.log(
    `Listener static assets: CSS ${(measurement.cssGzipBytes / 1024).toFixed(1)} KiB gzip, `
    + `fonts ${(measurement.fontBytes / 1024).toFixed(1)} KiB, `
    + `bundled images ${(measurement.imageBytes / 1024).toFixed(1)} KiB.`
  );
}
