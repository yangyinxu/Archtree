import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const conversionWorkerGzipBudget = 256 * 1024;
/** The dedicated encoder asset has its own finite budget; listener route and CSS limits stay independent. */
export function checkConversionWorkerBudget(distributionRoot) {
  const directory = join(distributionRoot, 'assets');
  const workers = readdirSync(directory).filter(name => /^conversionWorker-[A-Za-z0-9_-]+\.js$/.test(name));
  if (workers.length !== 1) throw new Error('Expected exactly one emitted conversion Worker asset.');
  const bytes = gzipSync(readFileSync(join(directory, workers[0]))).byteLength;
  if (bytes > conversionWorkerGzipBudget) throw new Error(`Conversion Worker requires ${(bytes / 1024).toFixed(1)} KiB gzip (budget 256 KiB).`);
  return { file: basename(workers[0]), bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../web/dist/', import.meta.url));
  const result = checkConversionWorkerBudget(root);
  console.log(`Conversion Worker: ${result.file} ${(result.bytes / 1024).toFixed(1)} KiB gzip (budget 256 KiB).`);
}
