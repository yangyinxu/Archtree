import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

/*
 * One-command local loop: rebuild web/dist on every save and serve it from the backend.
 * The backend only checks for web/dist/index.html at startup, so it starts after the first build,
 * and later rebuilds keep the old files so a refresh mid-rebuild never sees an empty dist.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let backend;
const stop = (code = 0) => {
  backend?.kill('SIGINT');
  process.exit(code);
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

const watcher = await build({ root: path.join(root, 'web'), build: { watch: {}, emptyOutDir: false } });
watcher.on('event', event => {
  if (event.code === 'ERROR') console.error(event.error);
  if (event.code !== 'END' || backend) return;
  backend = spawn('npm', ['run', 'dev'], { cwd: root, stdio: 'inherit' });
  backend.on('exit', code => {
    void watcher.close();
    stop(code ?? 0);
  });
});
