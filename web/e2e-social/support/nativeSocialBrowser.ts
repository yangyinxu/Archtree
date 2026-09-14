import { chromium, expect, type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Own a normal Chromium process so native tab visibility and freezing remain observable without hardware audio. */
export const nativeSocialBrowser = async () => {
  const profile = await mkdtemp(join(tmpdir(), 'archtree-social-activity-tabs-'));
  const process = spawn(chromium.executablePath(), ['--user-data-dir=' + profile, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-audio-output', 'about:blank'], { stdio: 'ignore' });
  let launchError: Error | undefined;
  let browser: Browser | undefined;
  const exited = new Promise<void>(resolve => {
    process.once('exit', () => resolve());
    process.once('error', error => { launchError = error; resolve(); });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await browser?.close(); }
    finally {
      if (process.exitCode === null && process.signalCode === null && !launchError) {
        process.kill('SIGTERM');
        const force = setTimeout(() => { process.kill('SIGKILL'); }, 3000);
        await exited; clearTimeout(force);
      }
      await rm(profile, { recursive: true, force: true });
    }
  })();
  try {
    let port = '';
    await expect.poll(async () => {
      if (launchError) throw launchError;
      if (process.exitCode !== null) throw new Error('Native activity browser exited before accepting connections.');
      port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(value => value.split('\n')[0]).catch(() => '');
      return /^\d+$/.test(port);
    }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0]; context.setDefaultTimeout(10_000);
    return { context, close };
  } catch (error) { await close(); throw error; }
};
