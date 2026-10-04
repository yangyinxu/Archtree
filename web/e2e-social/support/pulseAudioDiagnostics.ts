import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
type ListKind = 'sink-inputs' | 'sinks';

/** Drop device/application identities and all property maps before audio diagnostics reach an artifact. */
export const summarizePulseAudioList = (kind: ListKind, value: unknown) => {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid diagnostic list.');
  const latency = (field: unknown) => typeof field === 'number' && Number.isFinite(field)
    && field >= 0 && field <= Number.MAX_SAFE_INTEGER ? field : null;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid diagnostic item.');
    const row = item as Record<string, unknown>;
    if (kind === 'sink-inputs') return { bufferLatencyUsec: latency(row.buffer_latency_usec),
      sinkLatencyUsec: latency(row.sink_latency_usec), corked: typeof row.corked === 'boolean' ? row.corked : null };
    const timing = row.latency && typeof row.latency === 'object' && !Array.isArray(row.latency)
      ? row.latency as Record<string, unknown> : {};
    return { actualLatencyUsec: latency(timing.actual), configuredLatencyUsec: latency(timing.configured),
      state: typeof row.state === 'string' && ['RUNNING', 'IDLE', 'SUSPENDED', 'INIT', 'UNLINKED', 'INVALID'].includes(row.state)
        ? row.state : null };
  });
};

/** A failed diagnostic records a fixed category; command output and error messages may contain private data. */
const inspectList = async (kind: ListKind) => {
  let output: string;
  try {
    const result = await run('pactl', ['--format=json', 'list', kind],
      { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' });
    output = result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    const reason = failure.code === 'ENOENT' ? 'unavailable' : failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ? 'output-limit' : failure.killed ? 'timeout' : 'command-failed';
    return { status: 'failed' as const, reason };
  }
  try { return { status: 'ok' as const, values: summarizePulseAudioList(kind, JSON.parse(output)) }; }
  catch { return { status: 'failed' as const, reason: 'invalid-output' }; }
};

/** Read the isolated Linux CI server only; local computers never invoke an audio service for this diagnostic. */
export const capturePulseAudioDiagnostics = async () => {
  if (process.platform !== 'linux' || !['true', '1'].includes(process.env.CI ?? '')) return { status: 'skipped' as const };
  const configured = process.env.PULSE_LATENCY_MSEC ?? '';
  const requestedLatencyMs = /^\d{1,5}$/.test(configured) && Number(configured) > 0 && Number(configured) <= 10_000
    ? Number(configured) : null;
  const [sinkInputs, sinks] = await Promise.all([inspectList('sink-inputs'), inspectList('sinks')]);
  return { status: 'captured' as const, requestedLatencyMs, sinkInputs, sinks };
};
