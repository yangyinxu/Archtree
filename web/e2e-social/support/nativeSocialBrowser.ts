import { chromium, type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Match Playwright's sandbox default only in isolated Linux CI; local browsers retain their sandbox. */
export const nativeSocialBrowserArgs = (profile: string, platform: NodeJS.Platform, ci: string | undefined) => [
  '--user-data-dir=' + profile, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-audio-output', ...(platform === 'linux' && (ci === 'true' || ci === '1') ? ['--no-sandbox'] : []), 'about:blank'
];

/** Keep only bounded pre-navigation diagnostics, without temporary paths or the local debugging endpoint. */
export const nativeBrowserStartupDiagnostics = (profile: string) => {
  let stderr = Buffer.alloc(0);
  return {
    append(chunk: Buffer) { stderr = Buffer.concat([stderr, chunk.subarray(-4096)]).subarray(-4096); },
    describe(exitCode: number | null, signal: NodeJS.Signals | null, launchError?: NodeJS.ErrnoException) {
      const text = stderr.toString('utf8').replaceAll(profile, '<temporary profile>')
        .replace(/wss?:\/\/\S+/g, '<local debugging endpoint>').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
      return `exitCode=${exitCode ?? 'none'}; signal=${signal ?? 'none'}; spawnError=${launchError?.code ?? 'none'}; stderr=${JSON.stringify(text)}`;
    }
  };
};

/** Own a normal Chromium process so native tab visibility and freezing remain observable without hardware audio. */
export const nativeSocialBrowser = async () => {
  const profile = await mkdtemp(join(tmpdir(), 'archtree-social-activity-tabs-'));
  const child = spawn(chromium.executablePath(), nativeSocialBrowserArgs(profile, process.platform, process.env.CI),
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const diagnostics = nativeBrowserStartupDiagnostics(profile);
  child.stderr.on('data', diagnostics.append);
  let launchError: NodeJS.ErrnoException | undefined;
  let browser: Browser | undefined;
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.once('error', error => { launchError = error; resolve(); });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await browser?.close(); }
    finally {
      if (child.exitCode === null && child.signalCode === null && !launchError) {
        child.kill('SIGTERM');
        const force = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
        await exited; clearTimeout(force);
      }
      await rm(profile, { recursive: true, force: true });
    }
  })();
  let phase = 'waiting for DevToolsActivePort';
  try {
    let port = '';
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      if (launchError || child.exitCode !== null || child.signalCode !== null) throw new Error('Browser exited.');
      port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(value => value.split('\n')[0]).catch(() => '');
      if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535) break;
      port = ''; await Promise.race([delay(100), exited]);
    }
    if (!port) throw new Error('Browser startup timed out.');
    phase = 'connecting to the native browser';
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 10_000 });
    child.stderr.off('data', diagnostics.append); child.stderr.resume();
    const context = browser.contexts()[0]; context.setDefaultTimeout(10_000);
    return { context, close };
  } catch {
    const error = new Error(`Native social browser failed while ${phase}: ${diagnostics.describe(child.exitCode, child.signalCode, launchError)}`);
    await close(); throw error;
  }
};
