import { connectToDatabase, disconnectFromDatabase } from '../src/infrastructure/database';
import { migrateCatalogCredits } from '../src/services/catalogCreditMigrationService';

const args = new Map(process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.split('=');
    return [key, value.join('=') || 'true'];
}));
const apply = args.get('--apply') === 'true';
if (apply && args.get('--confirm') !== 'APPLY_CATALOG_CREDITS') {
    throw new Error('Apply mode requires --confirm=APPLY_CATALOG_CREDITS. Run dry-run first.');
}

await connectToDatabase();
try {
    const result = await migrateCatalogCredits({
        apply,
        limit: Number(args.get('--limit') ?? 100),
        afterAlbumId: args.get('--after-album'),
        afterAudioTrackId: args.get('--after-track'),
        markUnattributedUnknown: args.get('--mark-unattributed-unknown') === 'true'
    });
    const actionCounts = result.outcomes.reduce<Record<string, number>>((counts, outcome) => {
        counts[outcome.action] = (counts[outcome.action] ?? 0) + 1;
        return counts;
    }, {});
    process.stdout.write(`${JSON.stringify({
        dryRun: result.dryRun,
        limit: result.limit,
        actionCounts,
        findingCount: result.findings.length,
        findingSample: result.findings.slice(0, 25),
        next: result.next
    }, null, 2)}\n`);
} finally {
    await disconnectFromDatabase();
}
