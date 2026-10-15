import { createHash } from 'node:crypto';
import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { getDatabaseClient, getDb } from '../infrastructure/database';
import { isAdminCatalogEditingEnabled, isAdminVisibilityEditingEnabled } from '../services/adminCapabilityService';
import { readyAlbumLifecycleFilter, touchReadyAlbumReferences } from '../services/albumReferenceFenceService';
import { orderedAlbumTrackIds } from '../services/albumTrackLinkService';
import { readyArtistLifecycleFilter } from '../services/artistReferenceFenceService';
import { readyOrganizationLifecycleFilter } from '../services/organizationReferenceFenceService';
import { readyAudioStorageFilter } from '../utils/audioStorageKey';
import { catalogSearchFilter, withCatalogSearchUpdate } from '../utils/catalogSearch';
import { normalizeCatalogCredits } from '../models/catalogCredit';
import { organizationTypes } from '../models/organization';
import { replaceCatalogCreditsWithinTransaction } from '../services/catalogCreditService';
import { requireCatalogCreditWrites } from '../config/catalogCreditRollout';
import { pageItemIdentity } from '../utils/pageItemIdentity';
import { touchAvailablePageItemReferences } from '../services/pageReferenceLifecycleService';
import { parseImportDate, cleanText, uuid, type ImportDate } from './adminImportContract';
import { adminCatalogArtworkSource } from './adminCatalogArtworkSource';

export type AdminCatalogKind = 'album' | 'artist' | 'audioTrack' | 'organization';
export class AdminCatalogError extends Error {
    constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (status: number, code: string): never => { throw new AdminCatalogError(status, code); };
const configs = {
    album: { collection: 'albums', field: 'title', ready: readyAlbumLifecycleFilter },
    artist: { collection: 'artists', field: 'name', ready: readyArtistLifecycleFilter },
    audioTrack: { collection: 'audioTracks', field: 'title', ready: readyAudioStorageFilter },
    organization: { collection: 'organizations', field: 'name', ready: readyOrganizationLifecycleFilter }
} as const;
export const adminCatalogKind = (value: unknown): AdminCatalogKind =>
    typeof value === 'string' && hasOwn(configs, value) ? value as AdminCatalogKind : fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
const id = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)
    ? new ObjectId(value) : fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
    if (Object.keys(value).some(key => !keys.includes(key))) fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
};
const date = (value: unknown): ImportDate | null => {
    if (!value || typeof value !== 'object') return null;
    try { return parseImportDate({ year: (value as any).year, month: (value as any).month ?? null, day: (value as any).day ?? null }); }
    catch { return null; }
};
/** Legacy metadata remains repairable without emitting controls or truncated surrogate pairs to strict clients. */
const text = (value: unknown, maximum: number, multiline = false) => {
    if (typeof value !== 'string') return '';
    return value.normalize('NFC').replace(/\r\n?/g, '\n')
        .replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, '')
        .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
        .slice(0, maximum).replace(/[\ud800-\udbff]$/, '');
};
const visibility = (value: unknown) => value === undefined ? 'public' : value === 'public' ? 'public' : 'hidden';

/** A metadata hash detects edits through legacy writers as well as this new API. */
const revision = (value: unknown) => `cr_${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}`;
export const adminCatalogEditableFields = (kind: AdminCatalogKind, doc: any): Record<string, unknown> => {
    if (kind === 'artist') return { name: text(doc.name, 200), bio: text(doc.bio, 10_000, true), birthDate: date(doc.birthDate) };
    if (kind === 'organization') return { name: text(doc.name, 200), description: text(doc.description, 10_000, true), organizationType: organizationTypes.includes(doc.organizationType) ? doc.organizationType : 'other' };
    let credits = null;
    try { if (Array.isArray(doc.credits)) credits = normalizeCatalogCredits(doc.credits); } catch { /* Private editor exposes a repairable absent list. */ }
    return { title: text(doc.title, 300), releaseDate: date(doc.releaseDate), credits,
        attributionStatus: doc.attributionStatus === 'documented' ? 'documented' : 'unknown',
        ...(kind === 'audioTrack' ? { trackNumber: Number.isInteger(doc.trackNumber) && doc.trackNumber > 0 && doc.trackNumber <= 9999 ? doc.trackNumber : null } : {}) };
};
const fields = adminCatalogEditableFields;
const stateForRevision = (kind: AdminCatalogKind, doc: any) => ({
    fields: fields(kind, doc), rawMetadata: [doc.title, doc.name, doc.bio, doc.description, doc.birthDate, doc.releaseDate, doc.credits, doc.attributionStatus, doc.trackNumber, doc.organizationType], visibility: doc.visibility ?? 'public', coverArtId: doc.coverArtId ?? null,
    coverArtUrl: doc.coverArtUrl ?? null, artistIds: doc.artistIds ?? null, albumId: doc.albumId ?? null,
    audioTrackIds: doc.audioTrackIds ?? null, creditRevision: doc.creditRevision ?? null,
    adminRevision: doc.adminRevision ?? 0, lifecycleStatus: doc.lifecycleStatus ?? null,
    publicationStatus: doc.publicationStatus ?? null, uploadStatus: doc.uploadStatus ?? null
});

export const adminCatalogItemRevision = (kind: AdminCatalogKind, doc: any) => revision(stateForRevision(kind, doc));

/** All private writes and snapshots fence the current database-backed administrator role. */
export const withCurrentAdministrator = async <T>(actor: string, work: (session: ClientSession) => Promise<T>): Promise<T> => {
    const session = getDatabaseClient().startSession(); let result!: T;
    try {
        await session.withTransaction(async () => {
            const touched = await getDb()!.collection('users').updateOne({ _id: id(actor), role: 'admin' },
                { $inc: { adminMutationRevision: 1 } }, { session });
            if (touched.matchedCount !== 1) fail(403, 'ADMIN_PERMISSION_REQUIRED');
            result = await work(session);
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 });
        return result;
    } finally { await session.endSession(); }
};

export const readAdminCatalogRecord = (kind: AdminCatalogKind, rawId: string, session?: ClientSession) =>
    getDb()!.collection(configs[kind].collection).findOne({ _id: id(rawId), ...configs[kind].ready }, { session, maxTimeMS: 1_000 });

export const adminCatalogSnapshot = async (kind: AdminCatalogKind, doc: any, session: ClientSession) => {
    let effectiveVisibility = visibility(doc.visibility);
    if (kind === 'audioTrack' && doc.albumId) {
        const albumId = String(doc.albumId).toLowerCase();
        const album = /^[0-9a-f]{24}$/.test(albumId) ? await readAdminCatalogRecord('album', albumId, session) : null;
        if (!album || visibility(album.visibility) === 'hidden') effectiveVisibility = 'hidden';
    }
    const ownerId = String(doc._id);
    const artwork = adminCatalogArtworkSource(doc);
    return { kind, id: ownerId, revision: revision(stateForRevision(kind, doc)), visibility: visibility(doc.visibility), effectiveVisibility,
        fields: fields(kind, doc), coverUrl: artwork ? `/api/admin/v1/catalog/${kind}/${ownerId}/artwork` : null,
        mediaUrl: kind === 'audioTrack' ? `/api/admin/v1/catalog/audioTrack/${ownerId}/media` : null,
        capabilities: { editing: isAdminCatalogEditingEnabled(), visibility: isAdminVisibilityEditingEnabled() } };
};

export const getAdminCatalogItem = (actor: string, kind: AdminCatalogKind, rawId: string) => withCurrentAdministrator(actor, async session => {
    const doc = await readAdminCatalogRecord(kind, rawId, session);
    if (!doc) return fail(404, 'ADMIN_CATALOG_NOT_FOUND');
    return { item: await adminCatalogSnapshot(kind, doc, session) };
});

/** Bounded inventory includes hidden content only behind this private role-checked route. */
export const listAdminCatalog = (actor: string, kind: AdminCatalogKind, query: Record<string, unknown>) => withCurrentAdministrator(actor, async session => {
    exact(query, ['query', 'cursor']);
    const search = query.query === undefined ? '' : cleanText(query.query, 100, true);
    const filter: Document = { $and: [configs[kind].ready,
        ...(search ? [catalogSearchFilter(configs[kind].field, search)] : []),
        ...(query.cursor ? [{ _id: { $gt: id(query.cursor) } }] : [])] };
    const rows = await getDb()!.collection(configs[kind].collection).find(filter, { session, maxTimeMS: 3_000 }).sort({ _id: 1 }).limit(26).toArray();
    return { items: await Promise.all(rows.slice(0, 25).map(doc => adminCatalogSnapshot(kind, doc, session))), nextCursor: rows.length > 25 ? String(rows[24]._id) : null };
});

const parseFields = (kind: AdminCatalogKind, value: unknown) => {
    const input = record(value);
    const permitted = kind === 'artist' ? ['name', 'bio', 'birthDate'] : kind === 'organization' ? ['name', 'description', 'organizationType']
        : ['title', 'releaseDate', 'credits', 'attributionStatus', ...(kind === 'audioTrack' ? ['trackNumber'] : [])];
    exact(input, permitted);
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (['bio', 'description'].includes(key) && typeof value === 'string') {
            const normalized = value.replace(/\r\n?/g, '\n');
            cleanText(normalized.replace(/\n/g, ' '), 10_000, true);
            output[key] = normalized.normalize('NFC').trim();
        } else if (['title', 'name', 'bio', 'description'].includes(key)) output[key] = cleanText(value, key === 'title' ? 300 : key === 'name' ? 200 : 10_000, key === 'bio' || key === 'description');
        else if (key === 'releaseDate' || key === 'birthDate') {
            const parsed = parseImportDate(value);
            output[key] = parsed ? { year: parsed.year, ...(parsed.month === null ? {} : { month: parsed.month }), ...(parsed.day === null ? {} : { day: parsed.day }) } : {};
        }
        else if (key === 'trackNumber') { if (value !== null && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 9999)) fail(400, 'ADMIN_CATALOG_INVALID_INPUT'); output[key] = value; }
        else if (key === 'organizationType') { if (!organizationTypes.includes(value as any)) fail(400, 'ADMIN_CATALOG_INVALID_INPUT'); output[key] = value; }
        else output[key] = value;
    }
    if (hasOwn(output, 'credits') !== hasOwn(output, 'attributionStatus')) fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    return output;
};

/** Previously public external artwork cannot be recalled by changing a database enum. */
const assertHiddenDelivery = async (kind: AdminCatalogKind, doc: any, session: ClientSession) => {
    if (!isAdminVisibilityEditingEnabled()) fail(503, 'ADMIN_VISIBILITY_UNAVAILABLE');
    const hasExternal = (value: any) => !value.coverArtId && typeof value.coverArtUrl === 'string' && /^https?:/i.test(value.coverArtUrl);
    if (hasExternal(doc)) fail(409, 'ADMIN_VISIBILITY_STORAGE_MIGRATION_REQUIRED');
    if (kind === 'album' && await getDb()!.collection('audioTracks').findOne({ albumId: { $in: [String(doc._id), doc._id, String(doc._id).toUpperCase()] },
        coverArtId: { $in: [null, ''] }, coverArtUrl: { $regex: '^https?:', $options: 'i' } }, { session, projection: { _id: 1 } })) fail(409, 'ADMIN_VISIBILITY_STORAGE_MIGRATION_REQUIRED');
};

type CatalogReceipt = { actor: string; operationId: string; fingerprint: string; result: unknown; expiresAt: Date };
const receipts = () => getDb()!.collection<CatalogReceipt>('adminCatalogMutations');
const parseMutation = (raw: unknown, keys: string[]) => {
    const body = record(raw); exact(body, ['operationId', 'expectedRevision', ...keys]);
    if (!uuid(body.operationId) || typeof body.expectedRevision !== 'string' || !/^cr_[A-Za-z0-9_-]{43}$/.test(body.expectedRevision)) fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    return body as Record<string, unknown> & { operationId: string; expectedRevision: string };
};
const replay = async (actor: string, body: { operationId: string }, fingerprint: string, session: ClientSession) => {
    const previous = await receipts().findOne({ actor, operationId: body.operationId }, { session });
    if (!previous) return null;
    if (previous.fingerprint !== fingerprint) fail(409, 'ADMIN_CATALOG_IDEMPOTENCY_CONFLICT');
    return previous.result;
};
const receipt = async (actor: string, body: { operationId: string }, fingerprint: string, result: unknown, session: ClientSession) => {
    await receipts().deleteMany({ actor, expiresAt: { $lte: new Date() } }, { session });
    if (await receipts().countDocuments({ actor }, { session, limit: 256 }) >= 256) fail(429, 'ADMIN_CATALOG_RECEIPT_LIMIT');
    await receipts().insertOne({ actor, operationId: body.operationId, fingerprint, result, expiresAt: new Date(Date.now() + 7 * 86_400_000) }, { session });
};

/** Partial metadata patches never reassign media, replace memberships, or mutate a reused entity implicitly. */
export const editAdminCatalogItem = (actor: string, kind: AdminCatalogKind, rawId: string, raw: unknown) => {
    const body = parseMutation(raw, ['fields', 'visibility']);
    const patch = body.fields === undefined ? {} : parseFields(kind, body.fields);
    const desiredVisibility = body.visibility;
    if (desiredVisibility !== undefined && desiredVisibility !== 'public' && desiredVisibility !== 'hidden') fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    if (!Object.keys(patch).length && desiredVisibility === undefined) fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    const fingerprint = revision([kind, rawId, body]);
    return withCurrentAdministrator(actor, async session => {
        const previous = await replay(actor, body, fingerprint, session); if (previous) return previous;
        if (!isAdminCatalogEditingEnabled()) fail(503, 'ADMIN_CATALOG_EDITING_UNAVAILABLE');
        const doc = await readAdminCatalogRecord(kind, rawId, session); if (!doc) return fail(404, 'ADMIN_CATALOG_NOT_FOUND');
        if (revision(stateForRevision(kind, doc)) !== body.expectedRevision) fail(409, 'ADMIN_CATALOG_REVISION_CONFLICT');
        if (desiredVisibility !== undefined && desiredVisibility !== visibility(doc.visibility)) {
            if (!isAdminVisibilityEditingEnabled()) fail(503, 'ADMIN_VISIBILITY_UNAVAILABLE');
            if (desiredVisibility === 'hidden') await assertHiddenDelivery(kind, doc, session);
        }
        const actualPatch = { ...patch };
        if (hasOwn(actualPatch, 'credits')) {
            requireCatalogCreditWrites();
            await replaceCatalogCreditsWithinTransaction(session, kind as 'album' | 'audioTrack', rawId, actualPatch.credits, actualPatch.attributionStatus, Number(doc.creditRevision ?? 0));
            delete actualPatch.credits; delete actualPatch.attributionStatus;
        }
        await getDb()!.collection(configs[kind].collection).updateOne({ _id: doc._id, ...configs[kind].ready }, {
            $set: { ...withCatalogSearchUpdate(actualPatch, configs[kind].field), ...(desiredVisibility !== undefined ? { visibility: desiredVisibility } : {}), updatedAt: new Date() },
            $inc: { adminRevision: 1, referenceRevision: 1 }
        }, { session });
        if (kind === 'audioTrack' && hasOwn(actualPatch, 'trackNumber') && doc.albumId) {
            const albumId = String(doc.albumId).toLowerCase();
            await touchReadyAlbumReferences([albumId], session);
            const parent = await readAdminCatalogRecord('album', albumId, session);
            const members = parent?.audioTrackIds;
            if (!Array.isArray(members) || members.length > 10_000 || members.some(value => typeof value !== 'string' || !/^[0-9a-f]{24}$/.test(value))) fail(409, 'ADMIN_CATALOG_MEMBERSHIP_REPAIR_REQUIRED');
            const ordered = await orderedAlbumTrackIds(session, members);
            await getDb()!.collection('albums').updateOne({ _id: parent!._id }, { $set: { audioTrackIds: ordered, updatedAt: new Date() }, $inc: { adminRevision: 1 } }, { session });
        }
        const updated = await readAdminCatalogRecord(kind, rawId, session);
        const result = { item: await adminCatalogSnapshot(kind, updated, session), receipt: { operationId: body.operationId } };
        await receipt(actor, body, fingerprint, result, session);
        return result;
    });
};

/** Resolves bounded display metadata privately so an approval identifies the actual placement. */
const pageSnapshot = async (page: any, session: ClientSession) => {
    const sourceItems = Array.isArray(page.items) ? page.items : [];
    if (sourceItems.length > 1000) fail(409, 'ADMIN_PAGE_ITEMS_LIMIT');
    const referenceIds = (carousel: boolean): string[] => [...new Set<string>(sourceItems
        .filter((item: any) => carousel ? item?.itemType === 'carousel' : ['grid', 'list'].includes(item?.itemType))
        .map((item: any) => String(carousel ? item.carouselId : item.collectionId).trim().toLowerCase())
        .filter((value: string) => /^[a-f0-9]{24}$/.test(value)))];
    const readReferences = async (collection: string, ids: string[]) => new Map((ids.length ? await getDb()!.collection(collection)
        .find({ _id: { $in: ids.map(value => new ObjectId(value)) } }, { session, projection: { name: 1, mode: 1, presentation: 1 }, maxTimeMS: 1000 })
        .limit(1000).toArray() : []).map(doc => [String(doc._id), doc]));
    const carousels = await readReferences('carousels', referenceIds(true));
    const collections = await readReferences('contentCollections', referenceIds(false));
    const items = sourceItems.flatMap((item: any) => {
        if (!['carousel', 'grid', 'list'].includes(item?.itemType)) return [];
        const itemId = pageItemIdentity(item);
        const referenceId = String(item.itemType === 'carousel' ? item.carouselId : item.collectionId).trim().toLowerCase();
        const reference = (item.itemType === 'carousel' ? carousels : collections).get(referenceId);
        const mode = reference?.mode ?? 'manual';
        const supported = item.itemType === 'carousel' ? ['manual', 'artist', 'personalized'].includes(mode)
            : reference?.presentation === item.itemType && ['manual', 'dynamic'].includes(mode);
        const referenceStatus = !reference ? 'missing' as const : supported ? 'ready' as const : 'unsupported' as const;
        const sourceMode = referenceStatus !== 'ready' ? null : mode === 'manual' ? 'manual' as const : 'dynamic' as const;
        const order = Number(item.order ?? 0);
        return itemId ? [{ itemId, itemType: item.itemType, visibility: visibility(item.visibility), order: Number.isFinite(order) ? order : 0,
            referenceId: text(referenceId, 24), name: reference ? text(reference.name, 300).trim() || null : null, sourceMode, referenceStatus }] : [];
    });
    return { slug: page.slug, title: text(page.title, 300), revision: revision({ items: page.items, title: page.title,
        references: items.map((item: any) => [item.itemId, item.name, item.sourceMode, item.referenceStatus]) }), items };
};
export const getAdminPage = (actor: string, slug: string) => withCurrentAdministrator(actor, async session => {
    if (!['home', 'library'].includes(slug)) return fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    const page = await getDb()!.collection('pages').findOne({ slug }, { session });
    if (!page) return fail(404, 'ADMIN_CATALOG_NOT_FOUND');
    return { page: await pageSnapshot(page, session) };
});
export const editAdminPageItem = (actor: string, slug: string, itemId: string, raw: unknown) => {
    id(itemId); if (!['home', 'library'].includes(slug)) return fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    const body = parseMutation(raw, ['visibility']);
    if (body.visibility !== 'public' && body.visibility !== 'hidden') fail(400, 'ADMIN_CATALOG_INVALID_INPUT');
    const fingerprint = revision([slug, itemId, body]);
    return withCurrentAdministrator(actor, async session => {
        const previous = await replay(actor, body, fingerprint, session); if (previous) return previous;
        if (!isAdminVisibilityEditingEnabled()) fail(503, 'ADMIN_VISIBILITY_UNAVAILABLE');
        const page = await getDb()!.collection('pages').findOne({ slug }, { session });
        if (!page) return fail(404, 'ADMIN_CATALOG_NOT_FOUND');
        const snapshot = await pageSnapshot(page, session);
        if (snapshot.revision !== body.expectedRevision) fail(409, 'ADMIN_CATALOG_REVISION_CONFLICT');
        const matches = page.items.filter((item: any) => pageItemIdentity(item) === itemId);
        // Ambiguous legacy identities must be repaired through composition editing first.
        if (matches.length !== 1) fail(409, 'ADMIN_PAGE_ITEM_IDENTITY_CONFLICT');
        // Fence the named target against concurrent rename/deletion while this approval commits.
        if (snapshot.items.find((item: any) => item.itemId === itemId)?.referenceStatus === 'ready') {
            await touchAvailablePageItemReferences(matches, session);
        }
        const items = page.items.map((item: any) => pageItemIdentity(item) === itemId ? { ...item, itemId, visibility: body.visibility } : item);
        await getDb()!.collection('pages').updateOne({ _id: page._id }, { $set: { items, updatedAt: new Date(), updatedBy: actor } }, { session });
        const result = { page: await pageSnapshot({ ...page, items }, session), receipt: { operationId: body.operationId } };
        await receipt(actor, body, fingerprint, result, session); return result;
    });
};
