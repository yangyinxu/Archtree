import { NextFunction, Request, Response } from 'express';
import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import {
    ArtistCarouselConfig,
    Carousel,
    CarouselContentType,
    CarouselMode
} from '../models/carousel';
import { Page, PageSlug } from '../models/page';
import { Artist } from '../models/artist';

// v1 only allows composition pages for Home and Library.
const allowedSlugs: PageSlug[] = ['home', 'library'];

const getPageSlug = (value: string): PageSlug | null => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'home' || normalized === 'library') {
        return normalized;
    }

    return null;
};

const parseOptionalPosition = (value: unknown) => {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
        return undefined;
    }

    return Math.max(0, Math.floor(parsed));
};

const parseRequiredIndex = (value: unknown) => {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
        return null;
    }

    return Math.max(0, Math.floor(parsed));
};

const isValidContentType = (value: string): value is CarouselContentType => {
    return value === 'post' || value === 'album' || value === 'audioTrack';
};

const validateObjectId = (value: string) => {
    try {
        ObjectId.createFromHexString(value);
        return true;
    } catch (error) {
        return false;
    }
};

const parseCarouselDefinition = (body: any): { mode: CarouselMode; artistConfig?: ArtistCarouselConfig } | null => {
    const mode: CarouselMode = body?.mode === 'artist' ? 'artist' : 'manual';
    if (mode === 'manual') return { mode };

    const artistId = String(body?.artistId ?? '').trim();
    const contentType = String(body?.artistContentType ?? '').trim();
    const sort = body?.artistSort === 'titleAsc' ? 'titleAsc' : 'releaseDateDesc';
    const requestedLimit = Number(body?.artistLimit ?? 20);
    if (!validateObjectId(artistId) || (contentType !== 'album' && contentType !== 'audioTrack') || !Number.isFinite(requestedLimit)) {
        return null;
    }

    return {
        mode,
        artistConfig: {
            artistId,
            contentType,
            sort,
            limit: Math.max(1, Math.min(Math.floor(requestedLimit), 100))
        }
    };
};

const doesContentExist = async (contentType: CarouselContentType, contentId: string) => {
    if (!validateObjectId(contentId)) {
        return false;
    }

    const db = getDb();
    // Resolve content type to backing collection for referential integrity checks.
    const lookup = {
        post: 'posts',
        album: 'albums',
        audioTrack: 'audioTracks'
    };

    const doc = await db!
        .collection(lookup[contentType])
        .find({ _id: ObjectId.createFromHexString(contentId) })
        .next();

    return Boolean(doc);
};

const getOwnerId = (doc: any) => {
    return String(doc?.createdBy ?? '');
};

const redirectWithMessage = (res: Response, message: string) => {
    res.redirect(`/content/manage?message=${encodeURIComponent(message)}`);
};

export const upsertPage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const title = String(req.body.title ?? '').trim();
        if (!slug || !title) {
            return res.status(400).json({ message: 'Invalid slug or title. Allowed slugs: home, library.' });
        }

        const existingPage: any = await Page.findBySlug(slug);
        if (existingPage && !ensureOwnerOrAdmin(authReq, getOwnerId(existingPage))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can modify this page.' });
        }

        await Page.upsertBySlug(slug, title, authReq.auth.userId);
        const page = await Page.findBySlug(slug);

        return res.status(200).json({
            message: 'Page saved successfully.',
            page
        });
    } catch (error) {
        return next(error);
    }
};

export const getPageBySlug = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const slug = getPageSlug(String(req.params.slug ?? ''));
        if (!slug) {
            return res.status(400).json({ message: 'Invalid page slug.' });
        }

        const page = await Page.findBySlug(slug);
        if (!page) {
            return res.status(404).json({ message: 'Page not found.' });
        }

        return res.status(200).json({ page });
    } catch (error) {
        return next(error);
    }
};

export const getExpandedPageBySlug = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const slug = getPageSlug(String(req.params.slug ?? ''));
        if (!slug) {
            return res.status(400).json({ message: 'Invalid page slug.' });
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return res.status(404).json({ message: 'Page not found.' });
        }

        const orderedItems = Array.isArray(page.items)
            ? [...page.items]
                .sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0))
                .slice(0, 100)
            : [];

        const carouselIds = orderedItems
            .map((item: any) => String(item.carouselId ?? ''))
            .filter(Boolean);

        // Expand carousel references into full carousel payloads for client rendering.
        const carousels: any[] = await Carousel.fetchByIds(carouselIds);
        const carouselMap = new Map<string, any>();
        for (const carousel of carousels) {
            carouselMap.set(String(carousel._id), {
                ...carousel,
                items: Array.isArray(carousel.items)
                    ? [...carousel.items].sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0))
                    : []
            });
        }

        const expandedItems = orderedItems.map((item: any) => ({
            ...item,
            carousel: carouselMap.get(String(item.carouselId ?? '')) ?? null
        }));

        return res.status(200).json({
            page: {
                ...page,
                items: expandedItems
            }
        });
    } catch (error) {
        return next(error);
    }
};

export const listPages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const pages = await Page.fetchAll();
        return res.status(200).json({
            allowedSlugs,
            pages
        });
    } catch (error) {
        return next(error);
    }
};

export const createCarousel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const name = String(req.body.name ?? '').trim();
        const definition = parseCarouselDefinition(req.body);
        if (!name || !definition) {
            return res.status(400).json({ message: 'Carousel name and configuration are required.' });
        }
        if (definition.artistConfig) {
            const artist = await Artist.findById(definition.artistConfig.artistId);
            if (!artist || !ensureOwnerOrAdmin(authReq, String(artist.createdBy ?? ''))) {
                return res.status(404).json({ message: 'Configured artist was not found or cannot be used.' });
            }
        }

        const carousel = new Carousel(
            name,
            [],
            authReq.auth.userId,
            authReq.auth.userId,
            definition.mode,
            definition.artistConfig
        );
        const result: any = await carousel.save();
        const saved = await Carousel.findById(String(result.insertedId));
        const resolved = saved ? await Carousel.resolveCarousel(saved) : null;

        return res.status(201).json({
            message: 'Carousel created successfully.',
            carousel: resolved
        });
    } catch (error) {
        return next(error);
    }
};

export const updateArtistCarousel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const carouselId = String(req.params.carouselId ?? '').trim();
        const name = String(req.body.name ?? '').trim();
        const definition = parseCarouselDefinition({ ...req.body, mode: 'artist' });
        if (!validateObjectId(carouselId) || !name || !definition?.artistConfig) {
            return res.status(400).json({ message: 'Valid artist carousel configuration is required.' });
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel || carousel.mode !== 'artist') {
            return res.status(404).json({ message: 'Artist carousel not found.' });
        }
        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can modify this carousel.' });
        }

        const artist = await Artist.findById(definition.artistConfig.artistId);
        if (!artist || !ensureOwnerOrAdmin(authReq, String(artist.createdBy ?? ''))) {
            return res.status(404).json({ message: 'Configured artist was not found or cannot be used.' });
        }

        await Carousel.updateById(carouselId, {
            name,
            mode: 'artist',
            artistConfig: definition.artistConfig,
            items: [],
            updatedBy: authReq.auth.userId
        });
        const saved = await Carousel.findById(carouselId);
        return res.status(200).json({
            message: 'Artist carousel updated successfully.',
            carousel: saved ? await Carousel.resolveCarousel(saved) : null
        });
    } catch (error) {
        return next(error);
    }
};

export const renameManualCarousel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const carouselId = String(req.params.carouselId ?? '').trim();
        const name = String(req.body.name ?? '').trim();
        if (!validateObjectId(carouselId) || !name) {
            return res.status(400).json({ message: 'Valid carousel ID and name are required.' });
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel || carousel.mode === 'artist') {
            return res.status(404).json({ message: 'Manual carousel not found.' });
        }
        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can rename this carousel.' });
        }

        await Carousel.updateById(carouselId, {
            name,
            updatedBy: authReq.auth.userId
        });
        return res.status(200).json({
            message: 'Carousel renamed successfully.',
            carousel: await Carousel.findById(carouselId)
        });
    } catch (error) {
        return next(error);
    }
};

export const listCarouselsByUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const carousels = await Carousel.fetchByCreator(authReq.auth.userId);
        return res.status(200).json({ carousels });
    } catch (error) {
        return next(error);
    }
};

export const attachCarouselToPage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const slug = getPageSlug(String(req.params.slug ?? req.body.slug ?? ''));
        const carouselId = String(req.body.carouselId ?? '').trim();
        if (!slug || !validateObjectId(carouselId)) {
            return res.status(400).json({ message: 'Invalid slug or carouselId.' });
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return res.status(404).json({ message: 'Page not found. Create it first.' });
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(page))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can modify this page.' });
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return res.status(404).json({ message: 'Carousel not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can attach this carousel.' });
        }

        const position = parseOptionalPosition(req.body.position);
        const items = await Page.addCarouselItem(slug, carouselId, authReq.auth.userId, position);

        return res.status(200).json({
            message: 'Carousel attached to page.',
            items
        });
    } catch (error) {
        return next(error);
    }
};

export const removeCarouselFromPage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const slug = getPageSlug(String(req.params.slug ?? ''));
        const carouselId = String(req.params.carouselId ?? '').trim();
        if (!slug || !validateObjectId(carouselId)) {
            return res.status(400).json({ message: 'Invalid slug or carouselId.' });
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return res.status(404).json({ message: 'Page not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(page))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can modify this page.' });
        }

        const items = await Page.removeCarouselItem(slug, carouselId, authReq.auth.userId);

        return res.status(200).json({
            message: 'Carousel detached from page.',
            items
        });
    } catch (error) {
        return next(error);
    }
};

export const reorderPageItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const slug = getPageSlug(String(req.params.slug ?? req.body.slug ?? ''));
        const fromIndex = parseRequiredIndex(req.body.fromIndex);
        const toIndex = parseRequiredIndex(req.body.toIndex);

        if (!slug || fromIndex === null || toIndex === null) {
            return res.status(400).json({ message: 'Invalid slug or index values.' });
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return res.status(404).json({ message: 'Page not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(page))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can modify this page.' });
        }

        const items = await Page.reorderItem(slug, fromIndex, toIndex, authReq.auth.userId);
        if (!items) {
            return res.status(400).json({ message: 'Invalid reorder range for page items.' });
        }

        return res.status(200).json({
            message: 'Page items reordered successfully.',
            items
        });
    } catch (error) {
        return next(error);
    }
};

export const addCarouselItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const carouselId = String(req.params.carouselId ?? '').trim();
        const contentType = String(req.body.contentType ?? '').trim();
        const contentId = String(req.body.contentId ?? '').trim();
        if (!validateObjectId(carouselId) || !isValidContentType(contentType) || !contentId) {
            return res.status(400).json({ message: 'Invalid carouselId, contentType, or contentId.' });
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return res.status(404).json({ message: 'Carousel not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can modify this carousel.' });
        }
        if (carousel.mode === 'artist') {
            return res.status(400).json({ message: 'Artist carousels are populated automatically and cannot accept manual items.' });
        }

        const contentExists = await doesContentExist(contentType, contentId);
        if (!contentExists) {
            return res.status(404).json({ message: 'Referenced content not found.' });
        }

        const position = parseOptionalPosition(req.body.position);
        const items = await Carousel.addItem(
            carouselId,
            {
                contentType,
                contentId
            },
            authReq.auth.userId,
            position
        );

        return res.status(200).json({
            message: 'Item added to carousel.',
            items
        });
    } catch (error) {
        return next(error);
    }
};

export const reorderCarouselItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const carouselId = String(req.params.carouselId ?? '').trim();
        const fromIndex = parseRequiredIndex(req.body.fromIndex);
        const toIndex = parseRequiredIndex(req.body.toIndex);

        if (!validateObjectId(carouselId) || fromIndex === null || toIndex === null) {
            return res.status(400).json({ message: 'Invalid carouselId or index values.' });
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return res.status(404).json({ message: 'Carousel not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can modify this carousel.' });
        }
        if (carousel.mode === 'artist') {
            return res.status(400).json({ message: 'Artist carousels are populated automatically and cannot be reordered.' });
        }

        const items = await Carousel.reorderItem(carouselId, fromIndex, toIndex, authReq.auth.userId);
        if (!items) {
            return res.status(400).json({ message: 'Invalid reorder range for carousel items.' });
        }

        return res.status(200).json({
            message: 'Carousel items reordered successfully.',
            items
        });
    } catch (error) {
        return next(error);
    }
};

export const moveCarouselItemBetweenCarousels = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const sourceCarouselId = String(req.params.sourceCarouselId ?? '').trim();
        const targetCarouselId = String(req.body.targetCarouselId ?? '').trim();
        const fromIndex = parseRequiredIndex(req.body.fromIndex);
        const toIndex = parseRequiredIndex(req.body.toIndex);

        if (!validateObjectId(sourceCarouselId) || !validateObjectId(targetCarouselId) || fromIndex === null || toIndex === null) {
            return res.status(400).json({ message: 'Invalid carousel IDs or index values.' });
        }

        const source: any = await Carousel.findById(sourceCarouselId);
        const target: any = await Carousel.findById(targetCarouselId);

        if (!source || !target) {
            return res.status(404).json({ message: 'Source or target carousel not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(source)) || !ensureOwnerOrAdmin(authReq, getOwnerId(target))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can modify these carousels.' });
        }
        if (source.mode === 'artist' || target.mode === 'artist') {
            return res.status(400).json({ message: 'Items cannot be moved into or out of an artist carousel.' });
        }

        const result = await Carousel.moveItemBetweenCarousels(
            sourceCarouselId,
            targetCarouselId,
            fromIndex,
            toIndex,
            authReq.auth.userId
        );

        if (!result) {
            return res.status(400).json({ message: 'Invalid move operation.' });
        }

        return res.status(200).json({
            message: 'Carousel item moved successfully.',
            ...result
        });
    } catch (error) {
        return next(error);
    }
};

export const deleteCarousel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }

        const carouselId = String(req.params.carouselId ?? '').trim();
        if (!validateObjectId(carouselId)) {
            return res.status(400).json({ message: 'Invalid carouselId.' });
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return res.status(404).json({ message: 'Carousel not found.' });
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return res.status(403).json({ message: 'Forbidden: only creator or admin can delete this carousel.' });
        }

        // Deletion policy: detach from all pages first, then delete the carousel.
        await Page.detachCarouselFromAllPages(carouselId, authReq.auth.userId);
        await Carousel.deleteById(carouselId);

        return res.status(200).json({
            message: 'Carousel deleted and detached from all pages.'
        });
    } catch (error) {
        return next(error);
    }
};

export const createOrUpdatePageWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const title = String(req.body.title ?? '').trim();
        if (!slug || !title) {
            return redirectWithMessage(res, 'Invalid page slug or missing title. Allowed slugs: home, library.');
        }

        const existingPage: any = await Page.findBySlug(slug);
        if (existingPage && !ensureOwnerOrAdmin(authReq, getOwnerId(existingPage))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this page.');
        }

        await Page.upsertBySlug(slug, title, authReq.auth.userId);
        return redirectWithMessage(res, 'Page saved successfully.');
    } catch (error) {
        return next(error);
    }
};

export const createCarouselWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const name = String(req.body.name ?? '').trim();
        const definition = parseCarouselDefinition(req.body);
        if (!name || !definition) {
            return redirectWithMessage(res, 'Carousel name and configuration are required.');
        }
        if (definition.artistConfig) {
            const artist = await Artist.findById(definition.artistConfig.artistId);
            if (!artist || !ensureOwnerOrAdmin(authReq, String(artist.createdBy ?? ''))) {
                return redirectWithMessage(res, 'Configured artist was not found or cannot be used.');
            }
        }

        const carousel = new Carousel(
            name,
            [],
            authReq.auth.userId,
            authReq.auth.userId,
            definition.mode,
            definition.artistConfig
        );
        await carousel.save();

        return redirectWithMessage(res, definition.mode === 'artist'
            ? 'Artist carousel created successfully.'
            : 'Carousel created successfully.');
    } catch (error) {
        return next(error);
    }
};

export const updateArtistCarouselWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const carouselId = String(req.body.carouselId ?? '').trim();
        const name = String(req.body.name ?? '').trim();
        const definition = parseCarouselDefinition({ ...req.body, mode: 'artist' });
        if (!validateObjectId(carouselId) || !name || !definition?.artistConfig) {
            return redirectWithMessage(res, 'Valid artist carousel configuration is required.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel || carousel.mode !== 'artist') {
            return redirectWithMessage(res, 'Artist carousel not found.');
        }
        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this carousel.');
        }

        const artist = await Artist.findById(definition.artistConfig.artistId);
        if (!artist || !ensureOwnerOrAdmin(authReq, String(artist.createdBy ?? ''))) {
            return redirectWithMessage(res, 'Configured artist was not found or cannot be used.');
        }

        await Carousel.updateById(carouselId, {
            name,
            mode: 'artist',
            artistConfig: definition.artistConfig,
            items: [],
            updatedBy: authReq.auth.userId
        });
        return redirectWithMessage(res, 'Artist carousel updated successfully.');
    } catch (error) {
        return next(error);
    }
};

export const renameManualCarouselWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const carouselId = String(req.body.carouselId ?? '').trim();
        const name = String(req.body.name ?? '').trim();
        if (!validateObjectId(carouselId) || !name) {
            return redirectWithMessage(res, 'Valid manual carousel and name are required.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel || carousel.mode === 'artist') {
            return redirectWithMessage(res, 'Manual carousel not found.');
        }
        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can rename this carousel.');
        }

        await Carousel.updateById(carouselId, {
            name,
            updatedBy: authReq.auth.userId
        });
        return redirectWithMessage(res, 'Carousel renamed successfully.');
    } catch (error) {
        return next(error);
    }
};

export const attachCarouselToPageWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const carouselId = String(req.body.carouselId ?? '').trim();
        if (!slug || !validateObjectId(carouselId)) {
            return redirectWithMessage(res, 'Invalid slug or carousel ID.');
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return redirectWithMessage(res, 'Page not found. Create it first.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(page))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this page.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return redirectWithMessage(res, 'Carousel not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can attach this carousel.');
        }

        const position = parseOptionalPosition(req.body.position);
        await Page.addCarouselItem(slug, carouselId, authReq.auth.userId, position);

        return redirectWithMessage(res, 'Carousel attached to page.');
    } catch (error) {
        return next(error);
    }
};

export const reorderPageItemsWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const fromIndex = parseRequiredIndex(req.body.fromIndex);
        const toIndex = parseRequiredIndex(req.body.toIndex);
        if (!slug || fromIndex === null || toIndex === null) {
            return redirectWithMessage(res, 'Invalid slug or index values.');
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return redirectWithMessage(res, 'Page not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(page))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this page.');
        }

        const updated = await Page.reorderItem(slug, fromIndex, toIndex, authReq.auth.userId);
        if (!updated) {
            return redirectWithMessage(res, 'Invalid reorder range for page items.');
        }

        return redirectWithMessage(res, 'Page items reordered successfully.');
    } catch (error) {
        return next(error);
    }
};

export const detachCarouselFromPageWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const carouselId = String(req.body.carouselId ?? '').trim();
        if (!slug || !validateObjectId(carouselId)) {
            return redirectWithMessage(res, 'Invalid slug or carousel ID.');
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return redirectWithMessage(res, 'Page not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(page))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this page.');
        }

        await Page.removeCarouselItem(slug, carouselId, authReq.auth.userId);

        return redirectWithMessage(res, 'Carousel detached from page.');
    } catch (error) {
        return next(error);
    }
};

export const addCarouselItemWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const carouselId = String(req.body.carouselId ?? '').trim();
        const contentType = String(req.body.contentType ?? '').trim();
        const contentId = String(req.body.contentId ?? '').trim();

        if (!validateObjectId(carouselId) || !isValidContentType(contentType) || !contentId) {
            return redirectWithMessage(res, 'Invalid carousel, content type, or content ID.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return redirectWithMessage(res, 'Carousel not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this carousel.');
        }
        if (carousel.mode === 'artist') {
            return redirectWithMessage(res, 'Artist carousels are populated automatically and cannot accept manual items.');
        }

        const contentExists = await doesContentExist(contentType, contentId);
        if (!contentExists) {
            return redirectWithMessage(res, 'Referenced content not found.');
        }

        const position = parseOptionalPosition(req.body.position);
        await Carousel.addItem(carouselId, {
            contentType,
            contentId
        }, authReq.auth.userId, position);

        return redirectWithMessage(res, 'Carousel item added successfully.');
    } catch (error) {
        return next(error);
    }
};

export const reorderCarouselItemsWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const carouselId = String(req.body.carouselId ?? '').trim();
        const fromIndex = parseRequiredIndex(req.body.fromIndex);
        const toIndex = parseRequiredIndex(req.body.toIndex);

        if (!validateObjectId(carouselId) || fromIndex === null || toIndex === null) {
            return redirectWithMessage(res, 'Invalid carousel or index values.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return redirectWithMessage(res, 'Carousel not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this carousel.');
        }
        if (carousel.mode === 'artist') {
            return redirectWithMessage(res, 'Artist carousels are populated automatically and cannot be reordered.');
        }

        const updated = await Carousel.reorderItem(carouselId, fromIndex, toIndex, authReq.auth.userId);
        if (!updated) {
            return redirectWithMessage(res, 'Invalid reorder range for carousel items.');
        }

        return redirectWithMessage(res, 'Carousel items reordered successfully.');
    } catch (error) {
        return next(error);
    }
};

export const moveCarouselItemBetweenCarouselsWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const sourceCarouselId = String(req.body.sourceCarouselId ?? '').trim();
        const targetCarouselId = String(req.body.targetCarouselId ?? '').trim();
        const rawFromIndexes: unknown[] = Array.isArray(req.body.fromIndexes)
            ? req.body.fromIndexes as unknown[]
            : req.body.fromIndexes !== undefined ? [req.body.fromIndexes] : [];
        const fromIndexes = [...new Set<number>(rawFromIndexes
            .map((value: unknown) => parseRequiredIndex(value))
            .filter((value): value is number => value !== null))];

        if (!validateObjectId(sourceCarouselId) || !validateObjectId(targetCarouselId) || sourceCarouselId === targetCarouselId || fromIndexes.length === 0) {
            return redirectWithMessage(res, 'Invalid move parameters.');
        }

        const source: any = await Carousel.findById(sourceCarouselId);
        const target: any = await Carousel.findById(targetCarouselId);
        if (!source || !target) {
            return redirectWithMessage(res, 'Source or target carousel not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(source)) || !ensureOwnerOrAdmin(authReq, getOwnerId(target))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify these carousels.');
        }
        if (source.mode === 'artist' || target.mode === 'artist') {
            return redirectWithMessage(res, 'Items cannot be moved into or out of an artist carousel.');
        }

        const result = await Carousel.moveItemsBetweenCarousels(sourceCarouselId, targetCarouselId, fromIndexes, authReq.auth.userId);
        if (!result) {
            return redirectWithMessage(res, 'Invalid move operation.');
        }

        return redirectWithMessage(res, `${fromIndexes.length} carousel item${fromIndexes.length === 1 ? '' : 's'} moved successfully.`);
    } catch (error) {
        return next(error);
    }
};

export const deleteCarouselWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const carouselId = String(req.body.carouselId ?? '').trim();
        if (!validateObjectId(carouselId)) {
            return redirectWithMessage(res, 'Invalid carousel ID.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return redirectWithMessage(res, 'Carousel not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(carousel))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can delete this carousel.');
        }

        await Page.detachCarouselFromAllPages(carouselId, authReq.auth.userId);
        await Carousel.deleteById(carouselId);

        return redirectWithMessage(res, 'Carousel deleted and detached from all pages.');
    } catch (error) {
        return next(error);
    }
};
