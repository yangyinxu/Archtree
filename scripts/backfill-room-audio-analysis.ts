// Operational entry point: load the private `.env` before any application module reads configuration.
import 'dotenv/config';
import { open, type FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { connectToDatabase, disconnectFromDatabase } from '../src/infrastructure/database';
import { analyzeRoomAudioTrack, listRoomAudioAnalysis } from '../src/services/roomAudioAnalysisService';
import { parseRoomAudioBackfillArguments, RoomAudioBackfillArgumentError,
    runRoomAudioAnalysisBackfill } from '../src/services/roomAudioAnalysisBackfill';
import { assertRoomAudioRuntime } from './check-runtime.mjs';

/** Applying without a capable decoder would download every compressed source only to fail. */
class DecoderUnavailableError extends Error {
    constructor() {
        super('Room audio decoder is unavailable. Install FFmpeg, confirm node scripts/check-runtime.mjs --room-audio, or set ROOM_AUDIO_FFMPEG_PATH to its absolute path, then retry.');
    }
}

/**
 * Runs a paced, resumable catalog backfill from an operator checkout. Each per-track result and the
 * final summary are JSON lines on stdout and, with --log, appended to that file.
 */
const run = async () => {
    const controller = new AbortController();
    let signalExitCode: number | undefined;
    const interrupt = () => { signalExitCode = 130; controller.abort(); };
    const terminate = () => { signalExitCode = 143; controller.abort(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    let log: FileHandle | undefined;
    const write = async (value: object) => {
        const line = `${JSON.stringify(value)}\n`;
        process.stdout.write(line);
        await log?.appendFile(line, 'utf8');
    };
    try {
        const options = parseRoomAudioBackfillArguments(process.argv.slice(2));
        if (options.apply) {
            try { assertRoomAudioRuntime(); } catch { throw new DecoderUnavailableError(); }
        }
        // Append-only and private: a resumed run extends the same audit trail instead of replacing it.
        if (options.logPath) log = await open(options.logPath, 'a', 0o600);
        await connectToDatabase({ initializeIndexes: false, logReady: false });
        const summary = await runRoomAudioAnalysisBackfill(options, {
            list: listRoomAudioAnalysis,
            analyze: analyzeRoomAudioTrack,
            record: write,
            sleep: (milliseconds, signal) => delay(milliseconds, undefined, { signal }).catch(() => undefined)
        }, controller.signal);
        await write(summary);
        process.exitCode = signalExitCode ?? (summary.stopped ? 2 : 0);
    } catch (error) {
        const message = error instanceof RoomAudioBackfillArgumentError || error instanceof DecoderUnavailableError ? error.message
            : 'Room audio backfill could not run. Check administrator access, the log path, and database availability.';
        process.stderr.write(`${message}\n`);
        process.exitCode = signalExitCode ?? 1;
    } finally {
        try { await disconnectFromDatabase(); }
        catch {
            process.stderr.write('The backfill database connection could not be closed normally.\n');
            process.exitCode = signalExitCode ?? 1;
        }
        try { await log?.close(); }
        catch {
            process.stderr.write('The backfill log could not be closed normally.\n');
            process.exitCode = signalExitCode ?? 1;
        }
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
    }
};

void run().catch(() => {
    process.stderr.write('Room audio backfill stopped unexpectedly.\n');
    process.exitCode = 1;
});
