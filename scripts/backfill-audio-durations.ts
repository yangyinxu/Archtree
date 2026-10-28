// Operational entry point: load the private `.env` before any application module reads configuration.
import 'dotenv/config';
import { open, type FileHandle } from 'node:fs/promises';
import { connectToDatabase, disconnectFromDatabase, getDb } from '../src/infrastructure/database';
import { getS3 } from '../src/infrastructure/s3';
import { AudioDurationBackfillArgumentError, parseAudioDurationBackfillArguments,
    planAudioDurationBackfill } from '../src/services/audio/audioDurationBackfill';
import { probeAudioDurationMs } from '../src/services/roomAudio/audioDurationProbe';

/**
 * Previews the Audio duration backfill from an operator checkout: one JSON line per Audio track whose duration metadata
 * lookup cannot read, then a summary, on stdout and, with --log, appended to that file. It reads the catalog and
 * downloads each candidate's source to measure it; it never writes to the database or storage.
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
        const options = parseAudioDurationBackfillArguments(process.argv.slice(2));
        // Append-only and private: a resumed run extends the same record instead of replacing it.
        if (options.logPath) log = await open(options.logPath, 'a', 0o600);
        await connectToDatabase({ initializeIndexes: false, logReady: false });
        const summary = await planAudioDurationBackfill(options, {
            database: () => getDb()!, storage: getS3, bucket: process.env.S3_BUCKET_NAME ?? '',
            probe: probeAudioDurationMs, record: write
        }, controller.signal);
        await write(summary);
        process.exitCode = signalExitCode ?? 0;
    } catch (error) {
        const message = error instanceof AudioDurationBackfillArgumentError ? error.message
            : 'Audio duration preview could not run. Check the log path, database and storage availability.';
        process.stderr.write(`${message}\n`);
        process.exitCode = signalExitCode ?? 1;
    } finally {
        try { await disconnectFromDatabase(); }
        catch {
            process.stderr.write('The preview database connection could not be closed normally.\n');
            process.exitCode = signalExitCode ?? 1;
        }
        try { await log?.close(); }
        catch {
            process.stderr.write('The preview log could not be closed normally.\n');
            process.exitCode = signalExitCode ?? 1;
        }
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
    }
};

void run().catch(() => {
    process.stderr.write('Audio duration preview stopped unexpectedly.\n');
    process.exitCode = 1;
});
