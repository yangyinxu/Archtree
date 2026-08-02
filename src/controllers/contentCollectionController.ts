import { NextFunction, Request, Response } from 'express';
import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import {
    CollectionContentType,
    CollectionDynamicSource,
    CollectionMode,
    CollectionPresentation,
    ContentCollection
} from '../models/contentCollection';
import { Page, PageSlug } from '../models/page';

export type ContentCollectionDefinition = {
    presentation: CollectionPresentation;
    mode: CollectionMode;
    contentType: CollectionContentType;
    dynamicSource?: CollectionDynamicSource;
};

const isObjectId = (value: string) => ObjectId.isValid(value);
const ownerId = (document: any) => String(document?.createdBy ?? '');
const pageSlug = (value: unknown): PageSlug | null => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'home' || normalized === 'library' ? normalized : null;
};
const position = (value: unknown) => {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
};
const index = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
};

/** Enforces homogeneous Grid/List definitions and the two device-local dynamic sources. */
export const parseContentCollectionDefinition = (body: any): ContentCollectionDefinition | null => {
    const presentation = body?.presentation === 'grid'
        ? 'grid'
        : body?.presentation === 'list' ? 'list' : null;
    const mode = body?.mode === 'manual'
        ? 'manual'
        : body?.mode === 'dynamic' ? 'dynamic' : null;
    const contentType = body?.contentType === 'album'
        ? 'album'
        : body?.contentType === 'audioTrack' ? 'audioTrack' : null;
    if (!presentation || !mode || !contentType) return null;
    if (presentation === 'grid' && contentType !== 'album') return null;
    if (mode === 'manual') return { presentation, mode, contentType };

    const dynamicSource = body?.dynamicSource === 'downloadedAlbums'
        ? 'downloadedAlbums'
        : body?.dynamicSource === 'downloadedSongs' ? 'downloadedSongs' : null;
    if (!dynamicSource) return null;
    if (dynamicSource === 'downloadedAlbums'
        && (presentation !== 'grid' || contentType !== 'album')) return null;
    if (dynamicSource === 'downloadedSongs'
        && (presentation !== 'list' || contentType !== 'audioTrack')) return null;
    return { presentation, mode, contentType, dynamicSource };
};

export const createContentCollection = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const name = String(req.body.name ?? '').trim();
        const definition = parseContentCollectionDefinition(req.body);
        if (!authReq.auth) return res.status(401).json({ message: 'Missing or invalid credentials.' });
        if (!name || !definition) {
            return res.status(400).json({ message: 'A valid Grid/List definition is required.' });
        }
        const contentCollection = new ContentCollection(
            name,
            definition.presentation,
            definition.mode,
            definition.contentType,
            [],
            authReq.auth.userId,
            authReq.auth.userId,
            definition.dynamicSource
        );
        const result: any = await contentCollection.save();
        return res.status(201).json({
            message: `${definition.presentation === 'grid' ? 'Grid' : 'List'} created successfully.`,
            contentCollection: await ContentCollection.findById(String(result.insertedId))
        });
    } catch (error) {
        return next(error);
    }
};

export const listContentCollections = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.status(401).json({ message: 'Missing or invalid credentials.' });
        return res.status(200).json({
            contentCollections: await ContentCollection.fetchByCreator(authReq.auth.userId)
        });
    } catch (error) {
        return next(error);
    }
};

export const attachContentCollectionToPage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const slug = pageSlug(req.params.slug);
        const collectionId = String(req.body.collectionId ?? '').trim();
        if (!authReq.auth) return res.status(401).json({ message: 'Missing or invalid credentials.' });
        if (!slug || !isObjectId(collectionId)) {
            return res.status(400).json({ message: 'Invalid page slug or collectionId.' });
        }
        const [page, collection]: any[] = await Promise.all([
            Page.findBySlug(slug),
            ContentCollection.findById(collectionId)
        ]);
        if (!page || !collection) return res.status(404).json({ message: 'Page or Grid/List not found.' });
        if (!ensureOwnerOrAdmin(authReq, ownerId(page))
            || !ensureOwnerOrAdmin(authReq, ownerId(collection))) {
            return res.status(403).json({ message: 'Forbidden: creator or admin only.' });
        }
        const items = await Page.addCollectionItem(
            slug,
            collection.presentation,
            collectionId,
            authReq.auth.userId,
            position(req.body.position)
        );
        return res.status(200).json({ message: 'Grid/List attached to page.', items });
    } catch (error) {
        return next(error);
    }
};

export const removeContentCollectionFromPage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const slug = pageSlug(req.params.slug);
        const collectionId = String(req.params.collectionId ?? '').trim();
        if (!authReq.auth) return res.status(401).json({ message: 'Missing or invalid credentials.' });
        if (!slug || !isObjectId(collectionId)) {
            return res.status(400).json({ message: 'Invalid page slug or collectionId.' });
        }
        const page: any = await Page.findBySlug(slug);
        if (!page) return res.status(404).json({ message: 'Page not found.' });
        if (!ensureOwnerOrAdmin(authReq, ownerId(page))) {
            return res.status(403).json({ message: 'Forbidden: creator or admin only.' });
        }
        return res.status(200).json({
            message: 'Grid/List detached from page.',
            items: await Page.removeCollectionItem(slug, collectionId, authReq.auth.userId)
        });
    } catch (error) {
        return next(error);
    }
};

export const addContentCollectionItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const collectionId = String(req.params.collectionId ?? '').trim();
        const contentId = String(req.body.contentId ?? '').trim();
        if (!authReq.auth) return res.status(401).json({ message: 'Missing or invalid credentials.' });
        if (!isObjectId(collectionId) || !isObjectId(contentId)) {
            return res.status(400).json({ message: 'Valid collectionId and contentId are required.' });
        }
        const collection: any = await ContentCollection.findById(collectionId);
        if (!collection) return res.status(404).json({ message: 'Grid/List not found.' });
        if (!ensureOwnerOrAdmin(authReq, ownerId(collection))) {
            return res.status(403).json({ message: 'Forbidden: creator or admin only.' });
        }
        if (collection.mode !== 'manual') {
            return res.status(400).json({ message: 'Dynamic Grid/List items cannot be changed manually.' });
        }
        const backingCollection = collection.contentType === 'album' ? 'albums' : 'audioTracks';
        const content = await getDb()!.collection(backingCollection)
            .find({ _id: ObjectId.createFromHexString(contentId) }).next();
        if (!content) return res.status(404).json({ message: 'Referenced content not found.' });
        const items = await ContentCollection.addItem(
            collectionId,
            { contentType: collection.contentType, contentId },
            authReq.auth.userId,
            position(req.body.position)
        );
        return res.status(200).json({ message: 'Item added to Grid/List.', items });
    } catch (error) {
        return next(error);
    }
};

export const reorderContentCollectionItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const collectionId = String(req.params.collectionId ?? '').trim();
        const fromIndex = index(req.body.fromIndex);
        const toIndex = index(req.body.toIndex);
        if (!authReq.auth) return res.status(401).json({ message: 'Missing or invalid credentials.' });
        if (!isObjectId(collectionId) || fromIndex === null || toIndex === null) {
            return res.status(400).json({ message: 'Valid collectionId and indexes are required.' });
        }
        const collection: any = await ContentCollection.findById(collectionId);
        if (!collection) return res.status(404).json({ message: 'Grid/List not found.' });
        if (!ensureOwnerOrAdmin(authReq, ownerId(collection))) {
            return res.status(403).json({ message: 'Forbidden: creator or admin only.' });
        }
        if (collection.mode !== 'manual') {
            return res.status(400).json({ message: 'Dynamic Grid/List items cannot be reordered.' });
        }
        const items = await ContentCollection.reorderItem(
            collectionId, fromIndex, toIndex, authReq.auth.userId
        );
        if (!items) return res.status(400).json({ message: 'Invalid reorder range.' });
        return res.status(200).json({ message: 'Grid/List items reordered.', items });
    } catch (error) {
        return next(error);
    }
};

export const deleteContentCollection = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const collectionId = String(req.params.collectionId ?? '').trim();
        if (!authReq.auth) return res.status(401).json({ message: 'Missing or invalid credentials.' });
        if (!isObjectId(collectionId)) return res.status(400).json({ message: 'Invalid collectionId.' });
        const collection: any = await ContentCollection.findById(collectionId);
        if (!collection) return res.status(404).json({ message: 'Grid/List not found.' });
        if (!ensureOwnerOrAdmin(authReq, ownerId(collection))) {
            return res.status(403).json({ message: 'Forbidden: creator or admin only.' });
        }
        await Page.detachCollectionFromAllPages(collectionId, authReq.auth.userId);
        await ContentCollection.deleteById(collectionId);
        return res.status(200).json({ message: 'Grid/List deleted successfully.' });
    } catch (error) {
        return next(error);
    }
};
