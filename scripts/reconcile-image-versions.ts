import { connectToDatabase, disconnectFromDatabase } from '../src/infrastructure/database';
import { reconcileImageStorageIdentity } from '../src/services/imageStorageRecoveryService';

/** Default inspection is read-only. Apply changes one lifecycle row and never deletes S3 data. */
const run = async () => {
    try {
        const args = new Map<string, string>();
        for (const argument of process.argv.slice(2)) {
            const match = /^(--[a-z-]+)(?:=(.*))?$/.exec(argument);
            if (!match || !['--image-id', '--apply', '--confirm'].includes(match[1]) || args.has(match[1])) throw new Error('Invalid arguments');
            args.set(match[1], match[2] ?? 'true');
        }
        const imageId = args.get('--image-id') ?? '';
        const apply = args.get('--apply') === 'true';
        if (!/^[a-f\d]{24}$/i.test(imageId) || (args.has('--apply') && !apply)
            || (apply && args.get('--confirm') !== 'UPLOAD_WORKERS_STOPPED')) throw new Error('Invalid arguments');
        const db = await connectToDatabase({ initializeIndexes: false, logReady: false });
        console.log(JSON.stringify(await reconcileImageStorageIdentity(db, imageId, apply, apply)));
    } catch {
        console.error('Image version reconciliation failed. Use --image-id=<24-hex-id> for read-only inspection. Stop upload workers before --apply --confirm=UPLOAD_WORKERS_STOPPED. No unknown data is deleted; check permissions, ownership and concurrent changes.');
        process.exitCode = 1;
    } finally { await disconnectFromDatabase(); }
};
void run().catch(() => { console.error('Image reconciliation cleanup failed.'); process.exitCode = 1; });
