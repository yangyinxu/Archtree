import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyNativeMediaLine, createNativeMediaEvidenceFilter, nativeMediaEvidenceLimit } from '../scripts/filter-native-media-evidence.mjs';

const browser = (message: string) => `2026-10-14T12:00:00.000Z pw:browser [pid=123][err] 0:00:01.500000000 123 0xabc DEBUG webkitmediaplayer player.cpp:1:test: ${message}`;
const filterOutput = async (chunks: (string | Buffer)[]) => {
  const filter = createNativeMediaEvidenceFilter({ now: () => 10 });
  let output = '';
  filter.on('data', chunk => { output += chunk; });
  await pipeline(Readable.from(chunks), filter);
  return output;
};
const records = (output: string) => output.split('\n').filter(line => line.startsWith('[native-media] '))
  .map(line => JSON.parse(line.slice('[native-media] '.length)));

test('native evidence distinguishes pipeline modes and the pinned seek/buffering transitions', () => {
  const samples: [string, Record<string, unknown>][] = [
    ['Using legacy playbin element: true', { label: 'pipeline-mode', pipeline: 'playbin' }],
    ['Using legacy playbin element: false', { label: 'pipeline-mode', pipeline: 'playbin3' }],
    ['Creating pipeline for video player', { label: 'pipeline-created', media: 'video' }],
    ['WebKitWebSrc has EOS', { label: 'source-eos' }],
    ['Setting high-percent=0 on GstDownloadBuffer to force 100% buffered reporting', { label: 'seek-download-buffer' }],
    ['[Buffering] Pausing pipeline, resetting buffering level to 0 and forcing m_isBuffering true before seeking on stream mode', { label: 'seek-stream-buffer-reset' }],
    ['[Seek] Performing actual seek to 0:00:01.500000000 at rate 1.000000', { label: 'seek-dispatched' }],
    ['[Seek] seeked to 1.5', { label: 'seek-completed' }],
    ['[Buffering] mode: GST_BUFFERING_STREAM, status: 0.000000%', { label: 'buffering-status', mode: 'stream', percent: 0 }],
    ['[Buffering] mode: GST_BUFFERING_DOWNLOAD, status: 100.000000%', { label: 'buffering-status', mode: 'download', percent: 100 }],
    ['State: PAUSED, pending: VOID_PENDING', { label: 'pipeline-state', transition: 'settled', state: 'PAUSED', pending: 'VOID_PENDING' }],
    ['Async: State: READY, pending: PLAYING', { label: 'pipeline-state', transition: 'async', state: 'READY', pending: 'PLAYING' }],
    ['Ready State Changed from HaveEnoughData to HaveCurrentData', { label: 'ready-state', from: 'HaveEnoughData', to: 'HaveCurrentData' }],
    ['Network State Changed from Idle to Loading', { label: 'network-state', from: 'Idle', to: 'Loading' }],
    ['[Buffering] Complete.', { label: 'buffering-complete' }],
    ['[Buffering] Restarting playback (because of buffering or resuming from zero playback rate)', { label: 'buffering-resume' }],
    ['[Buffering] Pausing stream for buffering.', { label: 'buffering-pause' }]
  ];
  for (const [message, expected] of samples) assert.deepEqual(classifyNativeMediaLine(browser(message)), expected);
  assert.equal(classifyNativeMediaLine(browser('[Buffering] mode: private-mode, status: 12%')), null);
  assert.equal(classifyNativeMediaLine(browser('[Buffering] mode: GST_BUFFERING_STREAM, status: 101%')), null);
  assert.equal(classifyNativeMediaLine(browser('State: SECRET, pending: PLAYING')), null);
  assert.equal(classifyNativeMediaLine(browser('Ready State Changed from SecretToken to HaveCurrentData')), null);
});

test('raw browser/GStreamer credentials and URLs never survive, including unknown and ANSI-colored lines', async () => {
  const secret = 'FAKE_CREDENTIAL_DO_NOT_PRINT';
  const url = `https://private.example.test/media?token=${secret}`;
  const output = await filterOutput([
    `Running 3 tests using 1 worker\r\n`,
    `\u001b[35m${browser(`Loading ${url} Authorization: Bearer ${secret}`)}\u001b[0m\r\n`,
    `${browser(`WebKitWebSrc has EOS ${url} cookie=session=${secret}`)}\n`,
    `[pid=123][err] unknown continuation ${secret}\n`,
    `0:00:01.500000000 123 0xabc WARN wavparse parser.c:1:read: ${url}\n`,
    `GStreamer warning: ${url}\n`,
    `GST_DEBUG ${secret}\n`,
    `pw:browser [pid=123] <launching> --token=${secret}\n`,
    `  1) [webkit] › room-playback-feasibility.spec.ts: strict natural progress\n`,
    `    Error: Native playback did not establish credible progress.\n`,
    `  1 failed\n`
  ]);
  assert.doesNotMatch(output, new RegExp(`${secret}|private\\.example|Authorization|cookie=|pw:browser|webkitmediaplayer|GST_DEBUG`));
  assert.deepEqual(records(output), [{ monotonicMs: 0, label: 'source-eos' }]);
  assert.match(output, /Running 3 tests using 1 worker/);
  assert.match(output, /1\) \[webkit\]/);
  assert.match(output, /Error: Native playback did not establish credible progress/);
  assert.match(output, /1 failed/);
});

test('the stream handles split UTF-8, CRLF and a final line without a newline without exposing partial diagnostics', async () => {
  const bytes = Buffer.from(`${browser('WebKitWebSrc has EOS')}\r\n通过 2 passed`);
  const output = await filterOutput(Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1)));
  assert.deepEqual(records(output), [{ monotonicMs: 0, label: 'source-eos' }]);
  assert.ok(output.endsWith('通过 2 passed'));
});

test('native records are capped while later test failures remain visible and oversized lines are discarded completely', async () => {
  const lines = Array.from({ length: 500 }, () => `${browser('WebKitWebSrc has EOS')}\n`);
  const output = await filterOutput([
    `${'x'.repeat(17_000)} FAKE_OVERSIZED_SECRET`, '\n', ...lines,
    `${browser('Unknown private browser detail FAKE_AFTER_LIMIT_SECRET')}\n`, '  1 failed\n'
  ]);
  assert.equal(records(output).length, nativeMediaEvidenceLimit);
  assert.doesNotMatch(output, /FAKE_OVERSIZED_SECRET|FAKE_AFTER_LIMIT_SECRET/);
  assert.ok(output.endsWith('  1 failed\n'));
});

test('repeated downloads leave room for the final seek and ready-state failure without losing load boundaries', async () => {
  const messages: string[] = [];
  for (let load = 0; load < 8; load += 1) {
    messages.push('Creating pipeline for video player', 'Using legacy playbin element: false');
    for (let percent = 4; percent <= 100; percent += 4) {
      messages.push(`[Buffering] mode: GST_BUFFERING_DOWNLOAD, status: ${percent}.000000%`,
        'Async: State: READY, pending: PAUSED');
    }
    messages.push('WebKitWebSrc has EOS', 'State: PAUSED, pending: VOID_PENDING', '[Buffering] Complete.');
  }
  messages.push('State: PLAYING, pending: VOID_PENDING',
    'Setting high-percent=0 on GstDownloadBuffer to force 100% buffered reporting',
    '[Seek] Performing actual seek to 0:00:07.000000000 at rate 1.000000',
    'Async: State: PAUSED, pending: PAUSED', 'Async: State: PAUSED, pending: PLAYING',
    'Ready State Changed from HaveEnoughData to HaveCurrentData',
    'State: PLAYING, pending: VOID_PENDING');
  const output = await filterOutput([messages.map(message => browser(message)).join('\n'), '\n  1 failed\n']);
  const evidence = records(output);
  assert.ok(evidence.length < nativeMediaEvidenceLimit);
  assert.equal(evidence.filter(value => value.label === 'pipeline-created').length, 8);
  assert.equal(evidence.filter(value => value.label === 'pipeline-mode').length, 8);
  assert.equal(evidence.filter(value => value.label === 'source-eos').length, 8);
  assert.deepEqual(evidence.filter(value => value.label === 'buffering-status').map(value => value.percent),
    Array.from({ length: 8 }, () => [4, 28, 52, 76, 100]).flat());
  assert.equal(evidence.filter(value => value.label === 'pipeline-state' && value.state === 'READY').length, 8);
  assert.deepEqual(evidence.slice(-6).map(({ monotonicMs: _time, ...fields }) => fields), [
    { label: 'seek-download-buffer' }, { label: 'seek-dispatched' },
    { label: 'pipeline-state', transition: 'async', state: 'PAUSED', pending: 'PAUSED' },
    { label: 'pipeline-state', transition: 'async', state: 'PAUSED', pending: 'PLAYING' },
    { label: 'ready-state', from: 'HaveEnoughData', to: 'HaveCurrentData' },
    { label: 'pipeline-state', transition: 'settled', state: 'PLAYING', pending: 'VOID_PENDING' }
  ]);
  assert.ok(output.endsWith('  1 failed\n'));
});

test('buffering mode changes and exact empty/full boundaries survive progress compression', async () => {
  const messages = [
    ['DOWNLOAD', 4], ['DOWNLOAD', 20], ['DOWNLOAD', 0], ['DOWNLOAD', 0],
    ['STREAM', 4], ['STREAM', 20], ['STREAM', 28], ['STREAM', 100], ['STREAM', 100], ['STREAM', 0]
  ];
  const output = await filterOutput(messages.map(([mode, percent]) =>
    `${browser(`[Buffering] mode: GST_BUFFERING_${mode}, status: ${percent}.000000%`)}\n`));
  assert.deepEqual(records(output).map(({ mode, percent }) => [mode, percent]), [
    ['download', 4], ['download', 0], ['download', 0], ['stream', 4], ['stream', 28],
    ['stream', 100], ['stream', 100], ['stream', 0]
  ]);
});

test('emitted times are finite, nonnegative and monotonic even if an injected observer clock regresses', async () => {
  const times = [20, 22.1254, 21, Number.NaN];
  const filter = createNativeMediaEvidenceFilter({ now: () => times.shift()! });
  let output = '';
  filter.on('data', chunk => { output += chunk; });
  await pipeline(Readable.from([`${browser('WebKitWebSrc has EOS')}\n`.repeat(3)]), filter);
  assert.deepEqual(records(output).map(value => value.monotonicMs), [2.125, 2.125, 2.125]);
});

test('the real CLI filters diagnostics while preserving the test failure for its pipefail caller', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/filter-native-media-evidence.mjs', import.meta.url))], {
    input: `${browser('Using legacy playbin element: false Authorization: FAKE_CLI_SECRET')}\n  1 failed\n`,
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true
  });
  assert.equal(result.status, 0, 'The filter does not replace the upstream test process exit status.');
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /FAKE_CLI_SECRET|Authorization|pw:browser/);
  assert.equal(records(result.stdout)[0].pipeline, 'playbin3');
  assert.ok(result.stdout.endsWith('  1 failed\n'));
});
