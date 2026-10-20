import { getDb } from '../infrastructure/database';
import { importPublicationSupported } from './import/adminImportMediaTypes';

/** Pending canonical copies have durable import/cover evidence before their catalog graph is attached. */
export async function loadAdminCanonicalReservations(bucket: string, limit = 50_000): Promise<Set<string>> {
    const db = getDb(); if (!db) throw new Error('Database is unavailable.');
    const [imports, covers] = await Promise.all([
        db.collection('adminAlbumImports').find({ 'media.publication.bucket': bucket, $or: [{ 'media.publication.state': { $in: ['preparing', 'needsAttention'] } },
            { 'media.publication.state': 'cancelled', 'media.publication.cleanupPending': true },
            // A newer-format approval may be unresolved in a state this release does not know.
            { 'media.publication.schemaVersion': { $nin: [null, 1] }, 'media.publication.state': { $nin: ['complete', 'cancelled'] } }] },
            { projection: { 'media.publication.schemaVersion': 1, 'media.publication.snapshot': 1, 'media.publication.artists': 1, 'media.publication.label': 1, 'media.publication.tracks': 1, 'media.publication.cover': 1 } }).limit(limit + 1).maxTimeMS(3_000).toArray(),
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
        // An unresolved approval in a newer format may reserve keys this release cannot read, so no object is classified.
        if (doc.media?.publication && !importPublicationSupported(doc.media.publication)) throw new Error('Administrator reconciliation cannot classify objects of a newer import publication format.');
        for (const track of doc.media?.publication?.tracks ?? []) if (!track.reused && !track.cleanupComplete) add(track.key);
        if (!doc.media?.publication?.cover?.cleanupComplete) add(doc.media?.publication?.cover?.key);
    }
    for (const doc of covers) add(doc.target?.key);
    return keys;
}
