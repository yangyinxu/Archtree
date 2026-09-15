import { connectToDatabase, disconnectFromDatabase } from '../src/infrastructure/database';
import { analyzeRoomAudioTrack, listRoomAudioAnalysis } from '../src/services/roomAudioAnalysisService';
import { parseRoomAudioAnalysisArguments, RoomAudioAnalysisArgumentError, runRoomAudioAnalysisBatch } from '../src/services/roomAudioAnalysisBatch';

/** Runs one explicit, resumable page without schema changes, hidden retries or provider output. */
const run = async () => {
    const controller = new AbortController();
    let signalExitCode: number | undefined;
    const interrupt = () => { signalExitCode = 130; controller.abort(); };
    const terminate = () => { signalExitCode = 143; controller.abort(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    try {
        const options = parseRoomAudioAnalysisArguments(process.argv.slice(2));
        await connectToDatabase({ initializeIndexes: false, logReady: false });
        const report = await runRoomAudioAnalysisBatch(options, {
            list: listRoomAudioAnalysis, analyze: analyzeRoomAudioTrack
        }, controller.signal);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.exitCode = signalExitCode ?? (report.stopped ? 2 : 0);
    } catch (error) {
        const message = error instanceof RoomAudioAnalysisArgumentError ? error.message
            : 'Room audio analysis could not run. Check administrator access, arguments, and database availability.';
        process.stderr.write(`${message}\n`);
        process.exitCode = signalExitCode ?? 1;
    } finally {
        try { await disconnectFromDatabase(); }
        catch {
            process.stderr.write('The analysis database connection could not be closed normally.\n');
            process.exitCode = signalExitCode ?? 1;
        }
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
    }
};

void run().catch(() => {
    process.stderr.write('Room audio analysis stopped unexpectedly.\n');
    process.exitCode = 1;
});
