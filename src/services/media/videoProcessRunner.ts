import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type VideoProcessingIssue = 'invalid_source' | 'unsupported_layout' | 'processor_unavailable' | 'processor_busy' | 'processing_timeout' | 'processing_failed';

/** Fixed operational codes keep decoder diagnostics, local paths and source metadata private. */
export class VideoProcessingError extends Error {
    constructor(readonly code: VideoProcessingIssue) { super(code); this.name = 'VideoProcessingError'; }
}

/** Runs one bounded local media tool without a shell, inherited secrets or network protocols. */
export async function runVideoProcess(binary: string, args: string[], options: {
    signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void; failureCode?: 'invalid_source' | 'processing_failed';
} = {}): Promise<string> {
    options.signal?.throwIfAborted();
    if (!['ffmpeg', 'ffprobe'].includes(binary) && !isAbsolute(binary)) throw new VideoProcessingError('processor_unavailable');
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } });
        let failure: Error | undefined, stdout = '', pending = '', diagnostics = '', stdoutBytes = 0, diagnosticBytes = 0;
        const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
        const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new DOMException('Aborted', 'AbortError'));
        const timer = setTimeout(() => stop(new VideoProcessingError('processing_timeout')), options.timeoutMs ?? 900_000);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        child.stdout.on('data', (buffer: Buffer) => {
            stdoutBytes += buffer.length;
            if (stdoutBytes > (options.onLine ? 2 * 1024 ** 2 : 256 * 1024)) { stop(new VideoProcessingError('processing_failed')); return; }
            if (!options.onLine) { stdout += buffer.toString('utf8'); return; }
            pending += buffer.toString('utf8');
            if (pending.length > 16_384) { stop(new VideoProcessingError('processing_failed')); return; }
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
                try { options.onLine(line); } catch { stop(new VideoProcessingError('processing_failed')); }
            }
        });
        child.stderr.on('data', (buffer: Buffer) => {
            diagnosticBytes += buffer.length;
            diagnostics += buffer.subarray(0, Math.max(0, 16_384 - diagnostics.length)).toString('utf8');
            if (diagnosticBytes > 64 * 1024) stop(new VideoProcessingError('processing_failed'));
        });
        child.once('error', () => { failure ??= new VideoProcessingError('processor_unavailable'); });
        child.once('close', (code) => {
            clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
            if (failure) reject(failure);
            else if (code !== 0) reject(new VideoProcessingError(/unknown encoder|encoder.*not found|unknown decoder|decoder.*not found|unrecognized option|error while loading shared libraries|library not loaded/i.test(diagnostics)
                ? 'processor_unavailable' : /no space left|permission denied|read-only file system|input\/output error|cannot allocate memory|out of memory/i.test(diagnostics)
                    ? 'processing_failed' : options.failureCode ?? 'invalid_source'));
            else resolve(stdout);
        });
    });
}
