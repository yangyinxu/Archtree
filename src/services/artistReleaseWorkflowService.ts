import { createHash, randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';

import { getDb } from '../infrastructure/database';
import { Album } from '../models/album';
import { Artist } from '../models/artist';
import { Carousel, ArtistCarouselSort } from '../models/carousel';
import { Page, PageSlug } from '../models/page';
import { SimpleDate } from '../models/simpleDate';
import { publishNewAlbum } from '../application/catalog/publishNewAlbum';
import { publishNewArtist } from '../application/catalog/publishNewArtist';
import {
    uploadCoverArt,
    validateCoverArtFile
} from './imageStorageService';
import { ensureAlbumPrimaryArtistCredit } from './catalogCreditService';

type StepStatus = 'notStarted' | 'inProgress' | 'complete' | 'skipped' | 'failed';
type WorkflowStatus = 'inProgress' | 'needsAttention' | 'complete';

export interface ArtistReleaseWorkflowInput {
    idempotencyToken: string;
    artistMode: 'existing' | 'new';
    existingArtistId?: string;
    artistName?: string;
    artistBio?: string;
    artistBirthDate: SimpleDate;
    artistCoverArtRequested?: boolean;
    albumTitle: string;
    albumReleaseDate: SimpleDate;
    albumCoverArtRequested?: boolean;
    createCarousel: boolean;
    carouselName?: string;
    carouselSort: ArtistCarouselSort;
    carouselLimit: number;
    pageSlug?: PageSlug;
    pagePosition?: number;
}

export interface ArtistReleaseWorkflowFiles {
    artistCoverArtFile?: Express.Multer.File;
    albumCoverArtFile?: Express.Multer.File;
}

export interface ArtistReleaseWorkflowResult {
    operationId: string;
    status: WorkflowStatus;
    artistId?: string;
    albumId?: string;
    carouselId?: string;
    pageSlug?: PageSlug;
    lastError?: string;
    steps: Record<string, { status: StepStatus; error?: string }>;
}

const collectionName = 'contentWorkflowOperations';
const leaseMs = 2 * 60_000;
const completedRetentionMs = 90 * 24 * 60 * 60_000;

const operationId = (adminUserId: string, token: string) => createHash('sha256')
    .update(`${adminUserId}\0${token}`, 'utf8')
    .digest('hex');

const comparableIntent = (input: ArtistReleaseWorkflowInput) => ({
    artistMode: input.artistMode,
    existingArtistId: input.existingArtistId ?? '',
    artistName: input.artistName ?? '',
    artistBio: input.artistBio ?? '',
    artistBirthDate: input.artistBirthDate,
    artistCoverArtRequested: Boolean(input.artistCoverArtRequested),
    albumTitle: input.albumTitle,
    albumReleaseDate: input.albumReleaseDate,
    albumCoverArtRequested: Boolean(input.albumCoverArtRequested),
    createCarousel: input.createCarousel,
    carouselName: input.carouselName ?? '',
    carouselSort: input.carouselSort,
    carouselLimit: input.carouselLimit,
    pageSlug: input.pageSlug ?? '',
    pagePosition: input.pagePosition ?? null
});

const intentHash = (input: ArtistReleaseWorkflowInput) => createHash('sha256')
    .update(JSON.stringify(comparableIntent(input)), 'utf8')
    .digest('hex');

const boundedError = (error: unknown) => String(
    (error as any)?.code ?? (error as Error)?.message ?? 'workflow_step_failed'
).slice(0, 300);

const publicResult = (operation: any): ArtistReleaseWorkflowResult => ({
    operationId: String(operation._id),
    status: operation.status,
    artistId: operation.artistId,
    albumId: operation.albumId,
    carouselId: operation.carouselId,
    pageSlug: operation.pageSlug,
    lastError: operation.lastError,
    steps: Object.fromEntries(Object.entries(operation.steps ?? {}).map(([name, step]: [string, any]) => [
        name,
        { status: step.status, ...(step.error ? { error: step.error } : {}) }
    ]))
});

const setOperation = async (id: string, update: Record<string, unknown>) => {
    await getDb()!.collection(collectionName).updateOne(
        { _id: id },
        { $set: { ...update, updatedAt: new Date() } }
    );
};

const setStep = async (
    id: string,
    name: string,
    status: StepStatus,
    extra: Record<string, unknown> = {}
) => setOperation(id, {
    [`steps.${name}`]: { status, updatedAt: new Date(), ...extra }
});

const loadOperation = (id: string) => getDb()!.collection(collectionName).findOne({ _id: id });

const existingPageContains = (page: any, carouselId: string) =>
    Array.isArray(page?.items) && page.items.some((item: any) =>
        item?.itemType === 'carousel' && String(item.carouselId) === carouselId
    );

/** Runs one idempotent, resumable Artist + Album + optional presentation setup. */
export const runArtistReleaseWorkflow = async (
    adminUserId: string,
    input: ArtistReleaseWorkflowInput,
    files: ArtistReleaseWorkflowFiles = {},
    operationIdOverride?: string
): Promise<ArtistReleaseWorkflowResult> => {
    if (!operationIdOverride && !/^[A-Za-z0-9_-]{16,200}$/.test(input.idempotencyToken)) {
        throw Object.assign(new Error('A valid setup token is required.'), { statusCode: 400 });
    }
    const id = operationIdOverride ?? operationId(adminUserId, input.idempotencyToken);
    const expectedIntentHash = intentHash(input);
    const now = new Date();
    await getDb()!.collection(collectionName).updateOne(
        { _id: id },
        {
            $setOnInsert: {
                _id: id,
                adminUserId,
                intentHash: expectedIntentHash,
                intent: comparableIntent(input),
                status: 'inProgress',
                steps: {
                    artist: { status: 'notStarted' },
                    album: { status: 'notStarted' },
                    relationship: { status: 'notStarted' },
                    carousel: { status: 'notStarted' },
                    page: { status: 'notStarted' }
                },
                createdAt: now,
                updatedAt: now
            }
        },
        { upsert: true }
    );
    let operation: any = await loadOperation(id);
    if (operation.adminUserId !== adminUserId) {
        throw Object.assign(new Error('Artist release setup was not found.'), { statusCode: 404 });
    }
    if (operation.intentHash !== expectedIntentHash) {
        throw Object.assign(new Error('This setup token was already used for different values.'), {
            statusCode: 409,
            code: 'artist_release_token_reused'
        });
    }
    if (operation.status === 'complete') return publicResult(operation);

    const leaseOwner = randomUUID();
    const claimResult: any = await getDb()!.collection(collectionName).findOneAndUpdate(
        {
            _id: id,
            $or: [
                { leaseUntil: { $lte: now } },
                { leaseUntil: { $exists: false } }
            ]
        },
        {
            $set: {
                leaseOwner,
                leaseUntil: new Date(now.getTime() + leaseMs),
                status: 'inProgress',
                updatedAt: now
            },
            $inc: { attemptCount: 1 }
        },
        { returnDocument: 'after' }
    );
    const claimed = claimResult?.value ?? claimResult;
    if (!claimed) {
        throw Object.assign(new Error('This setup is already running. Wait for it to finish before retrying.'), {
            statusCode: 409,
            code: 'artist_release_in_progress'
        });
    }
    operation = claimed;

    try {
        let artistId = String(operation.artistId ?? input.existingArtistId ?? '');
        if (operation.steps?.artist?.status !== 'complete') {
            await setStep(id, 'artist', 'inProgress');
            if (input.artistMode === 'existing') {
                const artist = artistId ? await Artist.findReadyById(artistId) : null;
                if (!artist) throw Object.assign(new Error('Selected Artist is unavailable.'), { statusCode: 409 });
                await setOperation(id, { resolvedArtistName: String((artist as any).name ?? 'Artist') });
            } else {
                if (!artistId) {
                    artistId = new ObjectId().toHexString();
                    await setOperation(id, { artistId });
                }
                let artist = await Artist.findById(artistId);
                if (!artist) {
                    const newArtist = new Artist(
                        String(input.artistName ?? ''),
                        input.artistBirthDate,
                        String(input.artistBio ?? ''),
                        '',
                        [] as unknown as [string],
                        adminUserId,
                        ObjectId.createFromHexString(artistId)
                    );
                    let coverArt = operation.artistCoverArt;
                    if (!coverArt && input.artistCoverArtRequested && !files.artistCoverArtFile) {
                        throw Object.assign(new Error('Re-select the Artist cover-art file before retrying this step.'), {
                            statusCode: 409,
                            code: 'artist_cover_art_required_for_retry'
                        });
                    }
                    if (!coverArt && files.artistCoverArtFile) {
                        await validateCoverArtFile(files.artistCoverArtFile);
                        coverArt = await uploadCoverArt(
                            'artist',
                            artistId,
                            files.artistCoverArtFile,
                            adminUserId,
                            { allowMissingOwner: true }
                        );
                        await setOperation(id, { artistCoverArt: coverArt });
                    }
                    await publishNewArtist(newArtist, coverArt);
                    artist = newArtist;
                }
                await setOperation(id, { resolvedArtistName: String((artist as any).name ?? input.artistName ?? 'Artist') });
            }
            await setOperation(id, { artistId });
            await setStep(id, 'artist', 'complete');
        }

        operation = await loadOperation(id);
        artistId = String(operation!.artistId);
        let albumId = String(operation!.albumId ?? '');
        if (operation!.steps?.album?.status !== 'complete') {
            await setStep(id, 'album', 'inProgress');
            if (!albumId) {
                albumId = new ObjectId().toHexString();
                await setOperation(id, { albumId });
            }
            let album: any = await Album.findById(albumId);
            if (!album) {
                const newAlbum = new Album(
                    input.albumTitle,
                    '',
                    [] as unknown as [string],
                    input.albumReleaseDate,
                    adminUserId,
                    ObjectId.createFromHexString(albumId)
                );
                let coverArt = operation!.albumCoverArt;
                if (!coverArt && input.albumCoverArtRequested && !files.albumCoverArtFile) {
                    throw Object.assign(new Error('Re-select the Album cover-art file before retrying this step.'), {
                        statusCode: 409,
                        code: 'album_cover_art_required_for_retry'
                    });
                }
                if (!coverArt && files.albumCoverArtFile) {
                    await validateCoverArtFile(files.albumCoverArtFile);
                    coverArt = await uploadCoverArt(
                        'album',
                        albumId,
                        files.albumCoverArtFile,
                        adminUserId,
                        { allowMissingOwner: true }
                    );
                    await setOperation(id, { albumCoverArt: coverArt });
                }
                await publishNewAlbum(newAlbum, coverArt);
                album = newAlbum;
            }
            await setStep(id, 'album', 'complete');
        }

        operation = await loadOperation(id);
        albumId = String(operation!.albumId);
        if (operation!.steps?.relationship?.status !== 'complete') {
            await setStep(id, 'relationship', 'inProgress');
            await ensureAlbumPrimaryArtistCredit(albumId, artistId);
            await setStep(id, 'relationship', 'complete');
        }

        operation = await loadOperation(id);
        let carouselId = String(operation!.carouselId ?? '');
        if (!input.createCarousel) {
            if (operation!.steps?.carousel?.status !== 'skipped') await setStep(id, 'carousel', 'skipped');
        } else if (operation!.steps?.carousel?.status !== 'complete') {
            await setStep(id, 'carousel', 'inProgress');
            if (!carouselId) {
                carouselId = new ObjectId().toHexString();
                await setOperation(id, { carouselId });
            }
            const existingCarousel = await Carousel.findById(carouselId);
            if (!existingCarousel) {
                const carousel = new Carousel(
                    String(input.carouselName ?? `${operation!.resolvedArtistName ?? input.artistName ?? 'Artist'} Albums`),
                    [],
                    adminUserId,
                    adminUserId,
                    'artist',
                    {
                        artistId,
                        contentType: 'album',
                        sort: input.carouselSort,
                        limit: input.carouselLimit
                    }
                );
                (carousel as any)._id = ObjectId.createFromHexString(carouselId);
                await carousel.save();
            }
            await setStep(id, 'carousel', 'complete');
        }

        operation = await loadOperation(id);
        carouselId = String(operation!.carouselId ?? '');
        if (!input.pageSlug || !input.createCarousel) {
            if (operation!.steps?.page?.status !== 'skipped') await setStep(id, 'page', 'skipped');
        } else if (operation!.steps?.page?.status !== 'complete') {
            await setStep(id, 'page', 'inProgress');
            const page = await Page.findBySlug(input.pageSlug);
            if (!page) throw Object.assign(new Error(`Page ${input.pageSlug} does not exist.`), { statusCode: 409 });
            if (!existingPageContains(page, carouselId)) {
                const attached = await Page.addCarouselItem(
                    input.pageSlug,
                    carouselId,
                    adminUserId,
                    input.pagePosition
                );
                if (!attached) throw new Error('Page placement could not be applied.');
            }
            await setOperation(id, { pageSlug: input.pageSlug });
            await setStep(id, 'page', 'complete');
        }

        await setOperation(id, {
            status: 'complete',
            completedAt: new Date(),
            expiresAt: new Date(Date.now() + completedRetentionMs)
        });
        return publicResult(await loadOperation(id));
    } catch (error) {
        const failedOperation: any = await loadOperation(id);
        const currentStep = Object.entries(failedOperation?.steps ?? {})
            .find(([, step]: [string, any]) => step.status === 'inProgress')?.[0];
        if (currentStep) await setStep(id, currentStep, 'failed', { error: boundedError(error) });
        await setOperation(id, {
            status: 'needsAttention',
            lastError: boundedError(error)
        });
        throw Object.assign(error instanceof Error ? error : new Error('Artist release setup failed.'), {
            operationId: id,
            workflowNeedsAttention: true
        });
    } finally {
        await getDb()!.collection(collectionName).updateOne(
            { _id: id, leaseOwner },
            { $unset: { leaseOwner: '', leaseUntil: '' }, $set: { updatedAt: new Date() } }
        );
    }
};

/** Lists bounded recent setup operations for the administrator Operations surface. */
export const listArtistReleaseOperations = async (adminUserId: string, limit: number = 20) => {
    const db = getDb();
    if (!db) return [];
    const operations = await db.collection(collectionName)
        .find({ adminUserId })
        .sort({ updatedAt: -1, _id: 1 })
        .limit(Math.max(1, Math.min(limit, 50)))
        .toArray();
    return operations.map(publicResult);
};

const dateFromIntent = (value: any) => new SimpleDate(
    Number(value?.year) || undefined,
    Number(value?.month) || undefined,
    Number(value?.day) || undefined
);

/** Resumes a retained operation from its first incomplete step without accepting new intent. */
export const resumeArtistReleaseWorkflow = async (
    adminUserId: string,
    retainedOperationId: string
) => {
    if (!/^[0-9a-f]{64}$/.test(retainedOperationId)) {
        throw Object.assign(new Error('Artist release setup was not found.'), { statusCode: 404 });
    }
    const operation: any = await loadOperation(retainedOperationId);
    if (!operation || operation.adminUserId !== adminUserId || !operation.intent) {
        throw Object.assign(new Error('Artist release setup was not found.'), { statusCode: 404 });
    }
    const intent = operation.intent;
    return runArtistReleaseWorkflow(
        adminUserId,
        {
            idempotencyToken: 'retained_operation_resume',
            artistMode: intent.artistMode === 'new' ? 'new' : 'existing',
            existingArtistId: intent.existingArtistId || undefined,
            artistName: intent.artistName || undefined,
            artistBio: intent.artistBio || undefined,
            artistBirthDate: dateFromIntent(intent.artistBirthDate),
            artistCoverArtRequested: Boolean(intent.artistCoverArtRequested),
            albumTitle: String(intent.albumTitle ?? ''),
            albumReleaseDate: dateFromIntent(intent.albumReleaseDate),
            albumCoverArtRequested: Boolean(intent.albumCoverArtRequested),
            createCarousel: Boolean(intent.createCarousel),
            carouselName: intent.carouselName || undefined,
            carouselSort: intent.carouselSort === 'titleAsc' ? 'titleAsc' : 'releaseDateDesc',
            carouselLimit: Math.max(1, Math.min(Number(intent.carouselLimit ?? 20), 100)),
            pageSlug: intent.pageSlug === 'home' || intent.pageSlug === 'library'
                ? intent.pageSlug
                : undefined,
            pagePosition: Number.isFinite(intent.pagePosition) ? intent.pagePosition : undefined
        },
        {},
        retainedOperationId
    );
};
