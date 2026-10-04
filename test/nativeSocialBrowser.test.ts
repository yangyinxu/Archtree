import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeBrowserStartupDiagnostics, nativeSocialBrowserArgs } from '../web/e2e-social/support/nativeSocialBrowser';

test('native visibility browser relaxes sandboxing only in explicitly enabled Linux CI', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const ci of [undefined, '', 'false', '0', 'true', '1']) {
      const args = nativeSocialBrowserArgs('/synthetic/profile', platform, ci);
      assert.equal(args.includes('--no-sandbox'), platform === 'linux' && (ci === 'true' || ci === '1'));
      assert.ok(args.includes('--disable-audio-output'));
      assert.ok(args.includes('--remote-debugging-port=0'));
      assert.equal(args.at(-1), 'about:blank');
      assert.ok(!args.some(argument => /headless|enable-automation|disable-background/.test(argument)));
    }
  }
});

test('native startup diagnostics bound stderr and preserve exit, signal and spawn failure categories', () => {
  const diagnostics = nativeBrowserStartupDiagnostics('/synthetic/profile');
  diagnostics.append(Buffer.from('discard-me' + 'x'.repeat(5000)));
  let report = diagnostics.describe(null, 'SIGTRAP');
  assert.ok(report.includes('signal=SIGTRAP'));
  assert.ok(!report.includes('discard-me'));
  assert.equal(JSON.parse(report.split('stderr=')[1]).length, 4096);
  diagnostics.append(Buffer.from('\nSandbox failure in /synthetic/profile\nDevTools listening on ws://127.0.0.1:9999/devtools/browser/synthetic-debug-id\u0000'));
  report = diagnostics.describe(1, null, { name: 'Error', message: 'private detail', code: 'ENOENT' });
  assert.ok(report.includes('exitCode=1; signal=none; spawnError=ENOENT'));
  assert.ok(report.includes('Sandbox failure'));
  assert.ok(report.includes('<temporary profile>'));
  assert.ok(report.includes('<local debugging endpoint>'));
  assert.ok(!report.includes('/synthetic/profile'));
  assert.ok(!report.includes('synthetic-debug-id'));
  assert.ok(!report.includes('private detail'));
  assert.ok(!JSON.parse(report.split('stderr=')[1]).includes('\u0000'));
});
