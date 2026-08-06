import { NextFunction, Request, Response } from 'express';
import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import {
    ArtistCarouselConfig,
    Carousel,
    CarouselContentType,
    CarouselMode,
    PersonalizedCarouselConfig
} from '../models/carousel';
import { Page, PageSlug } from '../models/page';
import { ContentCollection } from '../models/contentCollection';
import { Artist } from '../models/artist';
import {
    projectPublicAlbums,
    projectPublicAudioTracks,
    readyPublicAudioFilter,
    toPublicFeedPost
} from '../services/publicCatalogService';
import { toPublicExpandedPage, toPublicPage } from '../services/publicPageService';
import { boundedLimit, boundedOffset } from '../utils/pagination';
import { readyAlbumLifecycleFilter } from '../services/albumReferenceFenceService';
import { deleteCarouselAndPageReferences } from '../services/pageReferenceLifecycleService';

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

const parseCarouselDefinition = (body: any): {
    mode: CarouselMode;
    artistConfig?: ArtistCarouselConfig;
    personalizedConfig?: PersonalizedCarouselConfig;
} | null => {
    const mode: CarouselMode = body?.mode === 'artist'
        ? 'artist'
        : body?.mode === 'personalized' ? 'personalized' : 'manual';
    if (mode === 'manual') return { mode };
    if (mode === 'personalized') {
        const source = String(body?.personalizedSource ?? '').trim();
        const requestedLimit = Number(body?.personalizedLimit ?? 20);
        if ((source !== 'recentlySaved' && source !== 'recentlyPlayed') || !Number.isFinite(requestedLimit)) {
            return null;
        }
        return {
            mode,
            personalizedConfig: {
                source,
                limit: Math.max(1, Math.min(Math.floor(requestedLimit), 20))
            }
        };
    }

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

const redirectWithMessage = (res: Response, message: string) => {
    res.redirect(`/content/manage?message=${encodeURIComponent(message)}`);
};

/** Keeps Web composition mutations admin-only if their route guard is bypassed. */
const rejectNonAdminWebMutation = (req: AuthenticatedRequest, res: Response) => {
    if (req.auth?.role === 'admin') return false;
    res.status(403).type('text/plain').send('Administrator access is required.');
    return true;
};

export const upsertPage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
        }

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const title = String(req.body.title ?? '').trim();
        if (!slug || !title) {
            return res.status(400).json({ message: 'Invalid slug or title. Allowed slugs: home, library.' });
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

        return res.status(200).json({ page: toPublicPage(page) });
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
            .filter((item: any) => item.itemType === 'carousel')
            .map((item: any) => String(item.carouselId ?? ''))
            .filter(validateObjectId);
        const collectionIds = orderedItems
            .filter((item: any) => item.itemType === 'grid' || item.itemType === 'list')
            .map((item: any) => String(item.collectionId ?? ''))
            .filter(validateObjectId);

        // Expand carousel references into full carousel payloads for client rendering.
        const viewerUserId = (req as AuthenticatedRequest).auth?.userId;
        const [carousels, contentCollections]: any[][] = await Promise.all([
            Carousel.fetchByIds(carouselIds, viewerUserId),
            ContentCollection.fetchByIds(collectionIds)
        ]);
        const resolvedRefs = [
            ...carousels.flatMap((carousel) =>
                Array.isArray(carousel?.items) ? carousel.items : []
            ),
            ...contentCollections.flatMap((collection) =>
                collection?.mode === 'manual' && Array.isArray(collection?.items)
                    ? collection.items
                    : []
            )
        ];
        const albumIds = [...new Set<string>(resolvedRefs
            .filter((item: any) => item.contentType === 'album')
            .map((item: any) => String(item.contentId))
            .filter(validateObjectId))];
        const audioTrackIds = [...new Set<string>(resolvedRefs
            .filter((item: any) => item.contentType === 'audioTrack')
            .map((item: any) => String(item.contentId))
            .filter(validateObjectId))];
        const postIds = [...new Set<string>(resolvedRefs
            .filter((item: any) => item.contentType === 'post')
            .map((item: any) => String(item.contentId))
            .filter(validateObjectId))];
        const db = getDb()!;
        const [albums, audioTracks, posts] = await Promise.all([
            albumIds.length > 0
                ? db.collection('albums').find({
                    _id: { $in: albumIds.map((id) => ObjectId.createFromHexString(id)) },
                    ...readyAlbumLifecycleFilter
                }).maxTimeMS(3_000).toArray()
                : [],
            audioTrackIds.length > 0
                ? db.collection('audioTracks').find({
                    ...readyPublicAudioFilter,
                    _id: { $in: audioTrackIds.map((id) => ObjectId.createFromHexString(id)) }
                }).maxTimeMS(3_000).toArray()
                : [],
            postIds.length > 0
                ? db.collection('posts').find({
                    _id: { $in: postIds.map((id) => ObjectId.createFromHexString(id)) }
                }).project({
                    _id: 1,
                    title: 1,
                    description: 1,
                    mainImageUrl: 1,
                    imageUrls: 1,
                    userId: 1,
                    createdAt: 1
                }).maxTimeMS(3_000).toArray()
                : []
        ]);
        const linkedAlbumIds = [...new Set<string>(audioTracks
            .map((track: any) => String(track.albumId ?? ''))
            .filter(validateObjectId))];
        const fetchedAlbumIds = new Set(albums.map((album: any) => String(album._id)));
        const missingLinkedAlbumIds = linkedAlbumIds.filter((id) => !fetchedAlbumIds.has(id));
        const linkedAlbums = missingLinkedAlbumIds.length > 0
            ? await db.collection('albums').find({
                _id: { $in: missingLinkedAlbumIds.map((id) => ObjectId.createFromHexString(id)) },
                ...readyAlbumLifecycleFilter
            }).maxTimeMS(3_000).toArray()
            : [];
        const includedAlbums = [...albums, ...linkedAlbums];
        const [publicAlbums, publicAudioTracks] = await Promise.all([
            projectPublicAlbums(includedAlbums),
            projectPublicAudioTracks(audioTracks)
        ]);
        const postsById = new Map(posts.map((post: any) => [String(post._id), post] as const));
        const publicPosts = postIds.flatMap((postId) => {
            const post = postsById.get(postId);
            return post ? [toPublicFeedPost(post)] : [];
        });
        const publicPage = toPublicExpandedPage(page, carousels, contentCollections, {
            albumIds: new Set(albums.map((album: any) => String(album._id))),
            audioTrackIds: new Set(audioTracks.map((track: any) => String(track._id))),
            postIds: new Set(postsById.keys())
        });

        return res.status(200).json({
            page: publicPage,
            included: {
                albums: publicAlbums,
                audioTracks: publicAudioTracks,
                posts: publicPosts
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
            pages: pages.map(toPublicPage)
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
        }

        const name = String(req.body.name ?? '').trim();
        const definition = parseCarouselDefinition(req.body);
        if (!name || !definition) {
            return res.status(400).json({ message: 'Carousel name and configuration are required.' });
        }
        if (definition.artistConfig) {
            const artist = await Artist.findById(definition.artistConfig.artistId);
            if (!artist) {
                return res.status(404).json({ message: 'Configured artist was not found.' });
            }
        }

        const carousel = new Carousel(
            name,
            [],
            authReq.auth.userId,
            authReq.auth.userId,
            definition.mode,
            definition.artistConfig,
            definition.personalizedConfig
        );
        const result: any = await carousel.save();
        const saved = await Carousel.findById(String(result.insertedId));
        const resolved = saved ? await Carousel.resolveCarousel(saved, authReq.auth.userId) : null;

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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
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
        const artist = await Artist.findById(definition.artistConfig.artistId);
        if (!artist) {
            return res.status(404).json({ message: 'Configured artist was not found.' });
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

export const updatePersonalizedCarousel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
        }
        const carouselId = String(req.params.carouselId ?? '').trim();
        const name = String(req.body.name ?? '').trim();
        const definition = parseCarouselDefinition({ ...req.body, mode: 'personalized' });
        if (!validateObjectId(carouselId) || !name || !definition?.personalizedConfig) {
            return res.status(400).json({ message: 'Valid personalized carousel configuration is required.' });
        }
        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel || carousel.mode !== 'personalized') {
            return res.status(404).json({ message: 'Personalized carousel not found.' });
        }
        await Carousel.updateById(carouselId, {
            name,
            mode: 'personalized',
            personalizedConfig: definition.personalizedConfig,
            items: [],
            updatedBy: authReq.auth.userId
        });
        const saved = await Carousel.findById(carouselId);
        return res.status(200).json({
            message: 'Personalized carousel updated successfully.',
            carousel: saved ? await Carousel.resolveCarousel(saved, authReq.auth.userId) : null
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
        }

        const carouselId = String(req.params.carouselId ?? '').trim();
        const name = String(req.body.name ?? '').trim();
        if (!validateObjectId(carouselId) || !name) {
            return res.status(400).json({ message: 'Valid carousel ID and name are required.' });
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel || carousel.mode !== 'manual') {
            return res.status(404).json({ message: 'Manual carousel not found.' });
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

/** Lists the bounded global Carousel inventory for administrators. */
export const listCarousels = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.status(401).json({ message: 'Missing or invalid credentials.' });
        }
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
        }

        const limit = boundedLimit(req.query.limit, 50, 100);
        const offset = boundedOffset(req.query.offset);
        const carousels = await Carousel.fetchAll(limit, offset);
        return res.status(200).json({ carousels, limit, offset });
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
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

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return res.status(404).json({ message: 'Carousel not found.' });
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
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

        if (carousel.mode !== 'manual') {
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
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

        if (carousel.mode !== 'manual') {
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
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

        if (source.mode !== 'manual' || target.mode !== 'manual') {
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
        if (authReq.auth.role !== 'admin') {
            return res.status(403).json({ message: 'Administrator access is required.' });
        }

        const carouselId = String(req.params.carouselId ?? '').trim();
        if (!validateObjectId(carouselId)) {
            return res.status(400).json({ message: 'Invalid carouselId.' });
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return res.status(404).json({ message: 'Carousel not found.' });
        }

        const deleted = await deleteCarouselAndPageReferences(
            carouselId,
            authReq.auth.userId
        );
        if (!deleted) {
            return res.status(404).json({ message: 'Carousel not found.' });
        }

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
        if (rejectNonAdminWebMutation(authReq, res)) return;

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const title = String(req.body.title ?? '').trim();
        if (!slug || !title) {
            return redirectWithMessage(res, 'Invalid page slug or missing title. Allowed slugs: home, library.');
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

        const name = String(req.body.name ?? '').trim();
        const definition = parseCarouselDefinition(req.body);
        if (!name || !definition) {
            return redirectWithMessage(res, 'Carousel name and configuration are required.');
        }
        if (definition.artistConfig) {
            const artist = await Artist.findById(definition.artistConfig.artistId);
            if (!artist) {
                return redirectWithMessage(res, 'Configured artist was not found.');
            }
        }

        const carousel = new Carousel(
            name,
            [],
            authReq.auth.userId,
            authReq.auth.userId,
            definition.mode,
            definition.artistConfig,
            definition.personalizedConfig
        );
        await carousel.save();

        return redirectWithMessage(res, definition.mode === 'artist'
            ? 'Artist carousel created successfully.'
            : definition.mode === 'personalized'
                ? 'Personalized carousel created successfully.'
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

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
        const artist = await Artist.findById(definition.artistConfig.artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Configured artist was not found.');
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

export const updatePersonalizedCarouselWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminWebMutation(authReq, res)) return;
        const carouselId = String(req.body.carouselId ?? '').trim();
        const name = String(req.body.name ?? '').trim();
        const definition = parseCarouselDefinition({ ...req.body, mode: 'personalized' });
        if (!validateObjectId(carouselId) || !name || !definition?.personalizedConfig) {
            return redirectWithMessage(res, 'Valid personalized carousel configuration is required.');
        }
        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel || carousel.mode !== 'personalized') {
            return redirectWithMessage(res, 'Personalized carousel not found.');
        }
        await Carousel.updateById(carouselId, {
            name,
            mode: 'personalized',
            personalizedConfig: definition.personalizedConfig,
            items: [],
            updatedBy: authReq.auth.userId
        });
        return redirectWithMessage(res, 'Personalized carousel updated successfully.');
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

        const carouselId = String(req.body.carouselId ?? '').trim();
        const name = String(req.body.name ?? '').trim();
        if (!validateObjectId(carouselId) || !name) {
            return redirectWithMessage(res, 'Valid manual carousel and name are required.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel || carousel.mode !== 'manual') {
            return redirectWithMessage(res, 'Manual carousel not found.');
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const carouselId = String(req.body.carouselId ?? '').trim();
        if (!slug || !validateObjectId(carouselId)) {
            return redirectWithMessage(res, 'Invalid slug or carousel ID.');
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return redirectWithMessage(res, 'Page not found. Create it first.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return redirectWithMessage(res, 'Carousel not found.');
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

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
        if (rejectNonAdminWebMutation(authReq, res)) return;

        const slug = getPageSlug(String(req.body.slug ?? ''));
        const carouselId = String(req.body.carouselId ?? '').trim();
        if (!slug || !validateObjectId(carouselId)) {
            return redirectWithMessage(res, 'Invalid slug or carousel ID.');
        }

        const page: any = await Page.findBySlug(slug);
        if (!page) {
            return redirectWithMessage(res, 'Page not found.');
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

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

        if (carousel.mode !== 'manual') {
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

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

        if (carousel.mode !== 'manual') {
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

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

        if (source.mode !== 'manual' || target.mode !== 'manual') {
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
        if (rejectNonAdminWebMutation(authReq, res)) return;

        const carouselId = String(req.body.carouselId ?? '').trim();
        if (!validateObjectId(carouselId)) {
            return redirectWithMessage(res, 'Invalid carousel ID.');
        }

        const carousel: any = await Carousel.findById(carouselId);
        if (!carousel) {
            return redirectWithMessage(res, 'Carousel not found.');
        }

        const deleted = await deleteCarouselAndPageReferences(
            carouselId,
            authReq.auth.userId
        );
        if (!deleted) {
            return redirectWithMessage(res, 'Carousel not found.');
        }

        return redirectWithMessage(res, 'Carousel deleted and detached from all pages.');
    } catch (error) {
        return next(error);
    }
};
