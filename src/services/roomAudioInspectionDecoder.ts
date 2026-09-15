import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { InvalidRoomAudio } from './roomAudioInspectionReader';

let activeDecoders = 0;

/** Missing executable capabilities are repairable runtime faults, not evidence against the inspected media. */
const missingRuntimeCapability = (diagnostic: string) => [
    /unrecognized option\b/i,
    /unknown (?:decoder|encoder|input format|output format)\b/i,
    /(?:decoder|encoder|protocol)(?: \([^\r\n)]{1,80}\))? not found\b/i,
    /could not find (?:decoder|encoder)\b/i,
    /requested (?:input|output) format [^\r\n]{1,100} is not known\b/i,
    /automatic encoder selection failed\b/i,
    /option [^\r\n]{1,80} not found\b/i,
    /error while loading shared libraries\b|library not loaded\b/i
].some(pattern => pattern.test(diagnostic));

export type RoomAudioInspectionErrorCode = 'decoder_unavailable' | 'analysis_timeout' | 'analysis_failed';

/** Operational failures remain retryable and expose only a fixed code, never media paths or decoder diagnostics. */
export class RoomAudioInspectionError extends Error {
    constructor(readonly code: RoomAudioInspectionErrorCode) { super(code); this.name = 'RoomAudioInspectionError'; }
}

/** Fully decodes to a null muxer; no playback device, network protocol, shell or output media is used. */
export const decodeRoomAudio = async (
    file: Pick<Express.Multer.File, 'size' | 'path' | 'buffer'>,
    format: 'mp3' | 'm4a-aac',
    expectedDurationMs: number,
    signal?: AbortSignal
) => {
    signal?.throwIfAborted();
    const binary = process.env.ROOM_AUDIO_FFMPEG_PATH || 'ffmpeg';
    if (binary !== 'ffmpeg' && !isAbsolute(binary)) throw new RoomAudioInspectionError('decoder_unavailable');
    if (activeDecoders >= 2) throw new RoomAudioInspectionError('analysis_failed');
    activeDecoders += 1;
    let directory: string | undefined;
    try {
        let input = file.path;
        if (!input) {
            directory = await mkdtemp(join(tmpdir(), 'archtree-room-analysis-'));
            input = join(directory, 'input');
            await writeFile(input, file.buffer, { mode: 0o600, signal });
        }
        if (!isAbsolute(input)) throw new RoomAudioInspectionError('analysis_failed');
        const args = [
            '-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-xerror', '-max_error_rate', '0',
            '-max_alloc', '33554432', '-threads', '1', '-filter_threads', '1',
            '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,mov', '-max_streams', '2',
            '-err_detect', 'crccheck+bitstream+buffer+explode', '-f', format === 'mp3' ? 'mp3' : 'mov', '-i', input,
            '-map', '0:a:0', '-vn', '-sn', '-dn', '-threads', '1', '-progress', 'pipe:1', '-f', 'null', '-'
        ];
        await new Promise<void>((resolve, reject) => {
            const child = spawn(binary, args, {
                shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
                env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }
            });
            let failure: Error | undefined; let pending = ''; let outputBytes = 0; let diagnosticBytes = 0;
            let finalDurationMs = 0; let completed = false; let unavailable = false; let diagnosticTail = '';
            const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
            const onAbort = () => stop(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
            const timer = setTimeout(() => stop(new RoomAudioInspectionError('analysis_timeout')), 60_000);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
            child.stdout.on('data', (buffer: Buffer) => {
                outputBytes += buffer.length;
                if (outputBytes > 256 * 1024) { stop(new RoomAudioInspectionError('analysis_failed')); return; }
                pending += buffer.toString('utf8');
                if (pending.length > 8192) { stop(new RoomAudioInspectionError('analysis_failed')); return; }
                let newline: number;
                while ((newline = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
                    if (line.startsWith('out_time_us=')) {
                        const value = line.slice(12);
                        if (!/^\d{1,15}$/.test(value)) { stop(new InvalidRoomAudio()); return; }
                        finalDurationMs = Number(value) / 1000;
                        if (finalDurationMs > expectedDurationMs + 100) { stop(new InvalidRoomAudio()); return; }
                    } else if (line === 'progress=end') completed = true;
                }
            });
            // Inspect at most 8 KiB and retain only a short overlap until close, so split messages stay classifiable without logging payloads.
            child.stderr.on('data', (buffer: Buffer) => {
                const inspected = buffer.subarray(0, Math.max(0, 8192 - diagnosticBytes)).toString('utf8');
                const diagnostic = diagnosticTail + inspected;
                unavailable ||= missingRuntimeCapability(diagnostic);
                diagnosticTail = diagnostic.slice(-256);
                diagnosticBytes += buffer.length;
                if (diagnosticBytes > 8192) stop(unavailable ? new RoomAudioInspectionError('decoder_unavailable') : new InvalidRoomAudio());
            });
            child.once('error', () => { failure ??= new RoomAudioInspectionError('decoder_unavailable'); });
            child.once('close', (code, processSignal) => {
                clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
                diagnosticTail = '';
                if (failure) reject(failure);
                else if (unavailable) reject(new RoomAudioInspectionError('decoder_unavailable'));
                else if (processSignal) reject(new RoomAudioInspectionError('analysis_failed'));
                else if (code !== 0 || diagnosticBytes || !completed || !finalDurationMs
                    || Math.abs(finalDurationMs - expectedDurationMs) > 100) reject(new InvalidRoomAudio());
                else resolve();
            });
        });
    } finally {
        try { if (directory) await rm(directory, { recursive: true, force: true }); }
        finally { activeDecoders -= 1; }
    }
};
