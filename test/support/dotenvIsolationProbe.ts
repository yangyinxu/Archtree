/**
 * Spawned by test/serverTestEnvironment.test.ts from a directory whose `.env` holds sentinel values.
 * It exercises every former `.env` loader: a stray `dotenv/config` import, module-load configuration in
 * the upload middleware, the full application import graph, and database configuration. It prints which
 * sentinel values became visible; it never prints the values themselves.
 */
import 'dotenv/config';
import { maxAudioUploadMb } from '../../src/middleware/audioUpload';
import '../../src/app';
import { connectToDatabase } from '../../src/infrastructure/database';
import { MissingStartupConfigurationError } from '../../src/infrastructure/startupDiagnostics';

const run = async () => {
    // Without these, a database loader that read `.env` again would restore the sentinel DB_NAME.
    delete process.env.DB_CONN_STRING;
    delete process.env.DB_NAME;
    let missingVariables: readonly string[] = [];
    try {
        await connectToDatabase({ logReady: false });
    } catch (error) {
        if (!(error instanceof MissingStartupConfigurationError)) throw error;
        missingVariables = error.missingVariables;
    }
    const leaked = Object.entries(process.env)
        .filter(([, value]) => String(value).includes('dotenv-sentinel'))
        .map(([key]) => key)
        .sort();
    process.stdout.write(JSON.stringify({ leaked, missingVariables, maxAudioUploadMb }));
};

void run().catch(error => {
    process.stderr.write(`Probe failed: ${error instanceof Error ? error.name : 'unknown'}\n`);
    process.exitCode = 1;
});
