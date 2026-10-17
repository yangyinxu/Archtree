import { getDb } from '../infrastructure/database';

/** Pending canonical copies have durable import/cover evidence before their catalog graph is attached. */
export async function loadAdminCanonicalReservations(bucket: string, limit = 50_000): Promise<Set<string>> {
    const db = getDb(); if (!db) throw new Error('Database is unavailable.');
    const [imports, covers] = await Promise.all([
        db.collection('adminAlbumImports').find({ 'media.publication.bucket': bucket, $or: [{ 'media.publication.state': { $in: ['preparing', 'needsAttention'] } },
            { 'media.publication.state': 'cancelled', 'media.publication.cleanupPending': true }] },
            { projection: { 'media.publication.tracks': 1, 'media.publication.cover': 1 } }).limit(limit + 1).maxTimeMS(3_000).toArray(),
        db.collection('adminCatalogCoverOperations').find({ 'target.bucket': bucket, $or: [{ state: { $nin: ['complete', 'cancelled'] } }, { cleanupPending: true }] },
            { projection: { 'target.key': 1 } }).limit(limit + 1).maxTimeMS(3_000).toArray()
    ]);
    if (imports.length + covers.length > limit) throw new Error('Administrator reconciliation exceeds its record safety limit.');
    const keys = new Set<string>();
    const add = (key: unknown) => {
        if (typeof key === 'string' && /^(?:audio\/[a-f0-9]{24}\/[a-f0-9]{24}|images\/[a-f0-9]{24})$/.test(key)) keys.add(key);
        if (keys.size > limit) throw new Error('Administrator reconciliation exceeds its object safety limit.');
    };
    for (const doc of imports) {
        for (const track of doc.media?.publication?.tracks ?? []) if (!track.reused && !track.cleanupComplete) add(track.key);
        if (!doc.media?.publication?.cover?.cleanupComplete) add(doc.media?.publication?.cover?.key);
    }
    for (const doc of covers) add(doc.target?.key);
    return keys;
}
