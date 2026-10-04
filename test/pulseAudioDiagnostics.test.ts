import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { summarizePulseAudioList } from '../web/e2e-social/support/pulseAudioDiagnostics';

test('PulseAudio sink-input diagnostics retain only latency and corked fields', () => {
  const result = summarizePulseAudioList('sink-inputs', [{ buffer_latency_usec: 2000.25, sink_latency_usec: 3100,
    corked: false, name: 'private-name', owner_module: 123, client: 'private-client',
    properties: { token: 'private-token', 'application.name': 'private-application' } }]);
  assert.deepEqual(result, [{ bufferLatencyUsec: 2000.25, sinkLatencyUsec: 3100, corked: false }]);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('PulseAudio sink diagnostics exclude device identities and nested property maps', () => {
  const result = summarizePulseAudioList('sinks', [{ latency: { actual: 45, configured: 100000, secret: 'private-value' },
    state: 'RUNNING', name: 'private-device', description: 'private-description', properties: { user: 'private-user' },
    ports: [{ name: 'private-port' }], monitor_source: 'private-source' }]);
  assert.deepEqual(result, [{ actualLatencyUsec: 45, configuredLatencyUsec: 100000, state: 'RUNNING' }]);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('invalid diagnostic values remain unavailable rather than leaking strings or becoming zero', () => {
  for (const invalid of [undefined, null, 'private-value', true, {}, [], -1, NaN, Infinity, Number.MAX_VALUE]) {
    assert.deepEqual(summarizePulseAudioList('sink-inputs', [{ buffer_latency_usec: invalid, sink_latency_usec: invalid, corked: 'private-value' }]),
      [{ bufferLatencyUsec: null, sinkLatencyUsec: null, corked: null }]);
    assert.deepEqual(summarizePulseAudioList('sinks', [{ latency: { actual: invalid, configured: invalid }, state: 'private-value' }]),
      [{ actualLatencyUsec: null, configuredLatencyUsec: null, state: null }]);
  }
  assert.deepEqual(summarizePulseAudioList('sinks', [{ latency: [], state: 'SUSPENDED' }]),
    [{ actualLatencyUsec: null, configuredLatencyUsec: null, state: 'SUSPENDED' }]);
  assert.deepEqual(summarizePulseAudioList('sink-inputs', [{ buffer_latency_usec: 0, sink_latency_usec: 0, corked: true }]),
    [{ bufferLatencyUsec: 0, sinkLatencyUsec: 0, corked: true }]);
});

test('diagnostic lists reject malformed rows and excessive counts while permitting empty results', () => {
  for (const kind of ['sinks', 'sink-inputs'] as const) {
    for (const invalid of [null, {}, 'private-value', [null], [1], [[]], Array.from({ length: 33 }, () => ({}))]) {
      assert.throws(() => summarizePulseAudioList(kind, invalid), /^Error: Invalid diagnostic (list|item)\.$/);
    }
    assert.deepEqual(summarizePulseAudioList(kind, []), []);
    assert.equal(summarizePulseAudioList(kind, Array.from({ length: 32 }, () => ({}))).length, 32);
  }
});

test('macOS skips audio-service diagnostics even when CI is set', () => {
  // Isolate the platform override and trap process execution so this also proves the guard on Linux runners.
  const helper = pathToFileURL(resolve('web/e2e-social/support/pulseAudioDiagnostics.ts')).href;
  const script = `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    childProcess.execFile = () => { throw new Error('Audio service must not be invoked.'); };
    syncBuiltinESMExports();
    const { capturePulseAudioDiagnostics } = await import(${JSON.stringify(helper)});
    assert.deepEqual(await capturePulseAudioDiagnostics(), { status: 'skipped' });
  `;
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { env: { ...process.env, CI: 'true' }, timeout: 5000, maxBuffer: 4096, stdio: 'pipe' });
});
