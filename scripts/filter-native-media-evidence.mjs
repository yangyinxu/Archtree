import { resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export const nativeMediaEvidenceLimit = 200;
const maximumLineCharacters = 16_384;
const statePattern = '(?:VOID_PENDING|NULL|READY|PAUSED|PLAYING)';
const readyStates = new Map([
  ['havenothing', 'HaveNothing'], ['havemetadata', 'HaveMetadata'], ['havecurrentdata', 'HaveCurrentData'],
  ['havefuturedata', 'HaveFutureData'], ['haveenoughdata', 'HaveEnoughData']
]);
const networkStates = new Map(['Empty', 'Idle', 'Loading', 'Loaded', 'FormatError', 'NetworkError', 'DecodeError']
  .map(value => [value.toLowerCase(), value]));

/** Browser diagnostics are never forwarded verbatim, including unknown messages and launch call-log copies. */
const isBrowserDiagnostic = line => /pw:browser|webkitmediaplayer|\b(?:GST(?:_[A-Z0-9]+)?|GStreamer)\b|\bgst_[a-z0-9_]+/i.test(line)
  || /\[pid(?:=|:)\s*\d+\]|<(?:launching|launched|kill|gracefully close start|gracefully close end)>/i.test(line)
  || /^\s*\d+:\d{2}:\d{2}\.\d+\s+\d+\s+0x[a-f\d]+\s+(?:ERROR|WARN|FIXME|INFO|DEBUG|LOG|TRACE)\b/i.test(line);

/** Extracts fixed labels and bounded numbers from pinned WebKit messages; no source text becomes a field. */
export const classifyNativeMediaLine = input => {
  const line = stripVTControlCharacters(input);
  if (!isBrowserDiagnostic(line)) return null;
  let match;
  if ((match = /Using legacy playbin element:\s*(true|false|1|0)\b/i.exec(line))) {
    return { label: 'pipeline-mode', pipeline: /^(true|1)$/i.test(match[1]) ? 'playbin' : 'playbin3' };
  }
  if ((match = /Creating pipeline for (audio|video) player\b/i.exec(line))) {
    return { label: 'pipeline-created', media: match[1].toLowerCase() };
  }
  if ((match = /\[Buffering\]\s+mode:\s*(?:GST_BUFFERING_)?(STREAM|DOWNLOAD|TIMESHIFT|LIVE),\s*status:\s*(\d{1,3}(?:\.\d{1,6})?)%/i.exec(line))) {
    const percent = Number(match[2]);
    return percent <= 100 ? { label: 'buffering-status', mode: match[1].toLowerCase(), percent } : null;
  }
  if ((match = new RegExp(`(?:^|\\s)(?:(Async|Failure|No preroll):\\s*)?State:\\s*(${statePattern}),\\s*pending:\\s*(${statePattern})\\b`, 'i').exec(line))) {
    return { label: 'pipeline-state', transition: match[1]?.toLowerCase().replace(' ', '-') ?? 'settled',
      state: match[2].toUpperCase(), pending: match[3].toUpperCase() };
  }
  if ((match = /Ready State Changed from ([A-Za-z_]+) to ([A-Za-z_]+)\b/.exec(line))) {
    const from = readyStates.get(match[1].replaceAll('_', '').toLowerCase());
    const to = readyStates.get(match[2].replaceAll('_', '').toLowerCase());
    return from && to ? { label: 'ready-state', from, to } : null;
  }
  if ((match = /Network State Changed from ([A-Za-z]+) to ([A-Za-z]+)\b/.exec(line))) {
    const from = networkStates.get(match[1].toLowerCase()), to = networkStates.get(match[2].toLowerCase());
    return from && to ? { label: 'network-state', from, to } : null;
  }
  const labels = [
    [/Setting high-percent=0 on GstDownloadBuffer to force 100%+ buffered reporting/, 'seek-download-buffer'],
    [/\[Buffering\] Pausing pipeline, resetting buffering level to 0 and forcing m_isBuffering true before seeking on stream mode/, 'seek-stream-buffer-reset'],
    [/WebKitWebSrc has EOS\b/, 'source-eos'],
    [/\[Seek\] Performing actual seek\b/, 'seek-dispatched'],
    [/\[Seek\] seeked to\b/, 'seek-completed'],
    [/\[Buffering\] Complete\./, 'buffering-complete'],
    [/\[Buffering\] Restarting playback\b/, 'buffering-resume'],
    [/\[Buffering\] Pausing stream for buffering\./, 'buffering-pause'],
    [/\[Buffering\] Pausing stream because of zero playback rate\./, 'zero-rate-pause'],
    [/Media element is muted and not visible in viewport, pausing it to save resources\./, 'viewport-pause'],
    [/Saving state for when player becomes visible:\s*PLAYING\b/, 'viewport-play-deferred']
  ];
  const label = labels.find(([pattern]) => pattern.test(line))?.[1];
  return label ? { label } : null;
};

/** Streams ordinary test output unchanged while capping sanitized native evidence and incomplete-line memory. */
export const createNativeMediaEvidenceFilter = ({ now = () => performance.now() } = {}) => {
  const decoder = new StringDecoder('utf8');
  const startedAt = now();
  let pending = '', droppingLine = false, evidenceCount = 0, previousMonotonicMs = 0;
  let previousPipelineState = '', previousBufferingBucket = '';
  const filter = new Transform({
    transform(chunk, _encoding, callback) {
      consume(decoder.write(chunk));
      callback();
    },
    flush(callback) {
      consume(decoder.end());
      if (pending && !droppingLine) emitLine(pending.replace(/\r$/, ''), false);
      callback();
    }
  });
  const emitLine = (line, newline) => {
    const clean = stripVTControlCharacters(line);
    if (!isBrowserDiagnostic(clean)) { filter.push(line + (newline ? '\n' : '')); return; }
    if (evidenceCount >= nativeMediaEvidenceLimit) return;
    const fields = classifyNativeMediaLine(clean);
    if (!fields) return;
    // Download progress can alternate with hundreds of identical state reports before a seek begins.
    if (fields.label === 'pipeline-created') {
      previousPipelineState = ''; previousBufferingBucket = '';
    } else if (fields.label === 'pipeline-state') {
      const state = `${fields.transition}:${fields.state}:${fields.pending}`;
      if (state === previousPipelineState) return;
      previousPipelineState = state;
    } else if (fields.label === 'buffering-status') {
      const bucket = `${fields.mode}:${Math.floor(fields.percent / 25)}`;
      if (fields.percent !== 0 && fields.percent !== 100 && bucket === previousBufferingBucket) return;
      previousBufferingBucket = bucket;
    }
    const elapsed = now() - startedAt;
    previousMonotonicMs = Math.max(previousMonotonicMs, Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed * 1000) / 1000) : 0);
    evidenceCount += 1;
    filter.push(`[native-media] ${JSON.stringify({ monotonicMs: previousMonotonicMs, ...fields })}\n`);
  };
  const consume = text => {
    let offset = 0;
    while (offset < text.length) {
      const end = text.indexOf('\n', offset);
      const fragment = text.slice(offset, end === -1 ? text.length : end);
      if (!droppingLine) {
        if (pending.length + fragment.length > maximumLineCharacters) { pending = ''; droppingLine = true; }
        else pending += fragment;
      }
      if (end === -1) return;
      if (!droppingLine) emitLine(pending.replace(/\r$/, ''), true);
      pending = ''; droppingLine = false; offset = end + 1;
    }
  };
  return filter;
};

// The caller retains the test process's failure via pipefail; filtering never interprets a test result as success.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void pipeline(process.stdin, createNativeMediaEvidenceFilter(), process.stdout).catch(() => {
    process.stderr.write('Native media evidence filtering failed.\n'); process.exitCode = 1;
  });
}
