import { Request, Response, NextFunction } from 'express';
import { Artist } from '../models/artist';
import { Album } from '../models/album';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';
import { Carousel } from '../models/carousel';
import { Page } from '../models/page';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import { getS3 } from '../app';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { parseBuffer } from 'music-metadata';
import { ObjectId } from 'mongodb';
import { normalizeUtf8Text } from '../utils/textEncoding';

const escapeHtml = (value: string) => {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

const parseCsv = (value: string) => {
    return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean) as [string];
};

const parseDateInput = (value: string) => {
    if (!value) {
        return new SimpleDate();
    }

    const [yearRaw, monthRaw, dayRaw] = value.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
        return new SimpleDate();
    }

    return new SimpleDate(year, month, day);
};

const toCsvInput = (value: unknown) => {
    if (!Array.isArray(value)) {
        return '';
    }

    return value.map((item) => String(item)).join(', ');
};

const toDateInputValue = (value: any) => {
    const year = Number(value?.year);
    const month = Number(value?.month);
    const day = Number(value?.day);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) || year <= 0 || month <= 0 || day <= 0) {
        return '';
    }

    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const uniqueStrings = (values: string[]) => {
    return [...new Set(values.filter(Boolean))];
};

const titleFromFileName = (fileName: string) => {
    return fileName
        .replace(/\.[^.]+$/, '')
        .trim();
};

const formatDuration = (durationInSeconds: unknown) => {
    const totalSeconds = Math.round(Number(durationInSeconds));
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
        return '';
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const minutePart = String(minutes).padStart(2, '0');
    const secondPart = String(seconds).padStart(2, '0');

    return hours > 0 ? `${hours}:${minutePart}:${secondPart}` : `${minutePart}:${secondPart}`;
};

const inferAudioFormat = (fileName: string, mimeType: string, container?: string) => {
    const normalizedContainer = String(container ?? '').trim().toUpperCase();
    const knownContainers: Record<string, string> = {
        MPEG: 'MP3',
        'MPEG-4': 'M4A',
        WAVE: 'WAV',
        OGG: 'OGG'
    };
    if (normalizedContainer) {
        return knownContainers[normalizedContainer] ?? normalizedContainer;
    }

    const extension = fileName.split('.').pop()?.trim().toUpperCase();
    if (extension) {
        return extension === 'MPEG' ? 'MP3' : extension;
    }

    return mimeType.replace(/^audio\//i, '').toUpperCase() || 'AUDIO';
};

type S3StorageSummary = {
    objectCount: number;
    totalBytes: number;
    estimatedMonthlyStorageCost: number;
    storageCostPerGbMonth: number;
};

type S3StorageSummaryResult = {
    summary: S3StorageSummary | null;
    errorCode?: string;
};

let cachedS3StorageSummary: { value: S3StorageSummary; expiresAt: number } | null = null;
const s3StorageSummaryCacheMs = 5 * 60 * 1000;

const getS3StorageSummary = async (): Promise<S3StorageSummary> => {
    if (cachedS3StorageSummary && cachedS3StorageSummary.expiresAt > Date.now()) {
        return cachedS3StorageSummary.value;
    }

    const bucket = String(process.env.S3_BUCKET_NAME ?? '').trim();
    if (!bucket) {
        throw new Error('S3_BUCKET_NAME is not configured.');
    }

    let continuationToken: string | undefined;
    let objectCount = 0;
    let totalBytes = 0;
    do {
        const page = await getS3().send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken
        }));
        const objects = Array.isArray(page.Contents) ? page.Contents : [];
        objectCount += objects.length;
        totalBytes += objects.reduce((sum: number, object: any) => sum + Number(object.Size ?? 0), 0);
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    const configuredRate = Number(process.env.S3_STORAGE_COST_PER_GB_MONTH ?? 0.023);
    const storageCostPerGbMonth = Number.isFinite(configuredRate) && configuredRate >= 0
        ? configuredRate
        : 0.023;
    const summary = {
        objectCount,
        totalBytes,
        estimatedMonthlyStorageCost: (totalBytes / (1024 ** 3)) * storageCostPerGbMonth,
        storageCostPerGbMonth
    };
    cachedS3StorageSummary = {
        value: summary,
        expiresAt: Date.now() + s3StorageSummaryCacheMs
    };

    return summary;
};

const loadS3StorageSummary = async (): Promise<S3StorageSummaryResult> => {
    try {
        return { summary: await getS3StorageSummary() };
    } catch (error: any) {
        const errorCode = String(error?.code ?? error?.name ?? 'UnknownError');
        console.log('Unable to load S3 storage summary:', {
            errorCode,
            message: error?.message,
            statusCode: error?.statusCode
        });
        return { summary: null, errorCode };
    }
};

const formatStorageSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
    return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
};

const renderSectionList = (title: string, items: any[], formatter: (item: any) => string) => {
    const content = items.length > 0
        ? items.map((item) => `<li>${formatter(item)}</li>`).join('')
        : '<li>None</li>';

    return `<h3>${title}</h3><ul>${content}</ul>`;
};

const contentId = (item: any) => String(item?._id ?? '');

const renderReferencedItem = (item: any, label: string, prefillType?: string) => {
    const id = escapeHtml(contentId(item));
    const editLink = prefillType && id
        ? ` <a href="/content/manage?prefillType=${encodeURIComponent(prefillType)}&prefillId=${encodeURIComponent(contentId(item))}">Edit</a>`
        : '';

    return `${escapeHtml(label)} (<code>${id}</code>)${editLink}`;
};

const renderMissingReference = (id: string) => {
    return `Unavailable content (<code>${escapeHtml(id)}</code>)`;
};

const renderNestedList = (items: string[]) => {
    return items.length > 0
        ? `<ul class="linked-content">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`
        : '<p class="empty-linked-content">None linked</p>';
};

const renderManagePage = (params: {
    userEmail: string;
    message?: string;
    searchQuery?: string;
    selectedUploadTrackId?: string;
    artists?: any[];
    albums?: any[];
    audioTracks?: any[];
    ownedArtists?: any[];
    ownedAlbums?: any[];
    ownedAudioTracks?: any[];
    ownedPages?: any[];
    ownedCarousels?: any[];
    s3StorageSummary?: S3StorageSummary | null;
    s3StorageSummaryError?: string;
    prefillArtistId?: string;
    prefillAlbumId?: string;
    prefillAudioTrackId?: string;
    prefillArtist?: any | null;
    prefillAlbum?: any | null;
    prefillAudioTrack?: any | null;
}) => {
    const messageBlock = params.message
        ? `<div class="alert" role="status">${escapeHtml(params.message)}</div>`
        : '';

    const searchQuery = escapeHtml(params.searchQuery ?? '');
    const artists = params.artists ?? [];
    const albums = params.albums ?? [];
    const audioTracks = params.audioTracks ?? [];
    const selectedUploadTrackId = escapeHtml(params.selectedUploadTrackId ?? '');

    const ownedArtists = params.ownedArtists ?? [];
    const ownedAlbums = params.ownedAlbums ?? [];
    const ownedAudioTracks = params.ownedAudioTracks ?? [];
    const ownedPages = params.ownedPages ?? [];
    const ownedCarousels = params.ownedCarousels ?? [];
    const s3StorageSummary = params.s3StorageSummary ?? null;
    const s3StorageSummaryError = params.s3StorageSummaryError ?? '';
    const s3StorageBlock = s3StorageSummary
        ? `<div class="storage-summary"><strong>S3 storage</strong><span>${formatStorageSize(s3StorageSummary.totalBytes)} across ${s3StorageSummary.objectCount} object${s3StorageSummary.objectCount === 1 ? '' : 's'}</span><span>Estimated storage: $${s3StorageSummary.estimatedMonthlyStorageCost.toFixed(2)}/month</span><small>Storage-only estimate at $${s3StorageSummary.storageCostPerGbMonth.toFixed(3)}/GB-month; excludes requests, transfer, and taxes.</small></div>`
        : `<div class="storage-summary"><strong>S3 storage</strong><span>Usage unavailable${s3StorageSummaryError ? ` (${escapeHtml(s3StorageSummaryError)})` : ''}. Confirm the app has S3 ListBucket permission and that S3_BUCKET_NAME/AWS_REGION match the bucket.</span></div>`;
    const pageOptions = ownedPages.map((page) => {
        const slug = String(page.slug ?? '');
        return `<option value="${escapeHtml(slug)}">${escapeHtml(String(page.title ?? slug))} (${escapeHtml(slug)})</option>`;
    }).join('');
    const carouselOptions = ownedCarousels.map((carousel) => {
        const id = contentId(carousel);
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled carousel'))}</option>`;
    }).join('');
    const albumOptions = ownedAlbums.map((album) => {
        const id = contentId(album);
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(album.title ?? 'Untitled album'))}</option>`;
    }).join('');
    const compositionData = JSON.stringify({
        pages: ownedPages.map((page) => ({
            slug: String(page.slug ?? ''),
            title: String(page.title ?? page.slug ?? ''),
            items: Array.isArray(page.items) ? page.items.map((item: any) => ({ carouselId: String(item.carouselId ?? ''), order: Number(item.order ?? 0) })) : []
        })),
        carousels: ownedCarousels.map((carousel) => ({
            id: contentId(carousel),
            name: String(carousel.name ?? 'Untitled carousel'),
            items: Array.isArray(carousel.items) ? carousel.items.map((item: any) => ({ contentId: String(item.contentId ?? ''), contentType: String(item.contentType ?? 'Content'), order: Number(item.order ?? 0) })) : []
        })),
        albums: ownedAlbums.map((album) => ({ id: contentId(album), title: String(album.title ?? '') })),
        audioTracks: ownedAudioTracks.map((track) => ({ id: contentId(track), title: String(track.title ?? '') }))
    }).replace(/</g, '\\u003c');
    const prefillArtistId = escapeHtml(params.prefillArtistId ?? '');
    const prefillAlbumId = escapeHtml(params.prefillAlbumId ?? '');
    const prefillAudioTrackId = escapeHtml(params.prefillAudioTrackId ?? '');
    const prefillArtist = params.prefillArtist ?? null;
    const prefillAlbum = params.prefillAlbum ?? null;
    const prefillAudioTrack = params.prefillAudioTrack ?? null;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archtree Content Manager</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <style>
    .content-hierarchy { display: grid; gap: 16px; }
    .hierarchy-item { border-bottom: 1px solid var(--line); padding-bottom: 14px; }
    .hierarchy-item:last-child { border-bottom: 0; padding-bottom: 0; }
    .hierarchy-item > strong { display: block; }
    .linked-content { margin: 6px 0 0 18px; padding-left: 18px; }
    .track-selection { align-items: center; display: flex; gap: 8px; margin: 6px 0 0 18px; padding-left: 18px; }
    .track-selection input { margin: 0; }
    .batch-track-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .empty-linked-content { color: var(--muted); font-size: 14px; margin: 6px 0 0; }
    .drag-list { display: grid; gap: 6px; margin: 10px 0; padding: 0; list-style: none; }
    .drag-item { background: var(--surface-strong); border: 1px solid var(--line); border-radius: 8px; cursor: grab; padding: 10px; }
    .drag-item.dragging { opacity: .45; }
    .drag-item.drag-over { border-color: var(--brand); }
    .drag-help { color: var(--muted); font-size: 13px; margin: 6px 0; }
    .move-item-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .move-item-choice { align-items: center; display: flex; gap: 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-strong); padding: 9px 10px; }
    .move-item-choice input { flex: 0 0 auto; margin: 0; }
    .manager-nav { display: flex; gap: 8px; margin: 18px 0 24px; overflow-x: auto; padding-bottom: 4px; }
    .manager-nav a { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); padding: 7px 12px; font-size: 13px; font-weight: 700; text-decoration: none; }
    .card h3:not(:first-child) { margin-top: 24px; }
    hr { border: 0; border-top: 1px solid var(--line); margin: 22px 0; }
  </style>
</head>
<body>
  <main class="page-shell">
  <header class="site-header">
    <div>
      <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">A</span><span>Archtree</span></a>
      <p class="eyebrow" style="margin-top:18px;">Catalog workspace</p>
      <h1 style="margin-bottom:8px;">Content Manager</h1>
      <p class="muted">Signed in as <strong>${escapeHtml(params.userEmail)}</strong></p>
    </div>
    <div class="header-actions">
      <a class="button" href="/content/manage/audio-tracks">My Audio Tracks</a>
      <a class="button button--secondary" href="/">Home</a>
      <form method="POST" action="/auth/logout-web"><button class="button--secondary" type="submit">Log out</button></form>
    </div>
  </header>
  ${messageBlock}
  ${s3StorageBlock}
  <nav class="manager-nav" aria-label="Content Manager sections">
    <a href="#search">Search</a>
    <a href="#my-content">My Content</a>
    <a href="#composition">Composition</a>
    <a href="#create">Create</a>
    <a href="#quick-linking">Quick Linking</a>
    <a href="#update-delete">Update / Delete</a>
  </nav>

  <div class="card" id="search">
    <h2>Unified Search</h2>
    <form method="GET" action="/content/manage/search">
      <input type="text" name="q" value="${searchQuery}" placeholder="Search artist, album, track" required />
      <button type="submit">Search</button>
    </form>
    ${renderSectionList('Artists', artists, (item) => `${escapeHtml(item.name ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
    ${renderSectionList('Albums', albums, (item) => `${escapeHtml(item.title ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
    ${renderSectionList('Audio Tracks', audioTracks, (item) => `${escapeHtml(item.title ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
  </div>

  <div class="section-heading" id="my-content"><div><p class="eyebrow">Library</p><h2>My Content</h2></div></div>
  <div class="card">
    <h3>My Artists</h3>
    <div class="content-hierarchy">
      ${ownedArtists.length > 0 ? ownedArtists.map((artist) => {
          const linkedAlbumIds = uniqueStrings(Array.isArray(artist.albumIds) ? artist.albumIds.map(String) : []);
          const albumsById = new Map(ownedAlbums.map((album) => [contentId(album), album]));
          const linkedAlbums = linkedAlbumIds.map((albumId) => {
              const album = albumsById.get(albumId);
              if (!album) return renderMissingReference(albumId);

              return renderReferencedItem(album, String(album.title ?? ''), 'album');
          });

          return `<div class="hierarchy-item"><strong>${renderReferencedItem(artist, String(artist.name ?? ''), 'artist')}</strong><span>${linkedAlbumIds.length} linked album${linkedAlbumIds.length === 1 ? '' : 's'}</span>${renderNestedList(linkedAlbums)}</div>`;
      }).join('') : '<p class="empty-linked-content">No artists yet.</p>'}
    </div>

    <h3>My Albums</h3>
    <div class="content-hierarchy">
      ${ownedAlbums.length > 0 ? ownedAlbums.map((album) => {
          const albumId = contentId(album);
          const linkedTrackIds = uniqueStrings([
              ...(Array.isArray(album.audioTrackIds) ? album.audioTrackIds.map(String) : []),
              ...ownedAudioTracks.filter((track) => String(track.albumId ?? '') === albumId).map(contentId)
          ]);
          const tracksById = new Map(ownedAudioTracks.map((track) => [contentId(track), track]));
          const linkedTracks = linkedTrackIds.map((trackId) => {
              const track = tracksById.get(trackId);
              if (!track) return renderMissingReference(trackId);

              return `<label class="track-selection"><input type="checkbox" name="audioTrackIds" value="${escapeHtml(trackId)}" aria-label="Select ${escapeHtml(String(track.title ?? 'audio track'))}" />${renderReferencedItem(track, String(track.title ?? ''), 'audioTrack')}</label>`;
          });
          const selectableTrackCount = linkedTrackIds.filter((trackId) => tracksById.has(trackId)).length;

          return `<form class="hierarchy-item" data-batch-track-delete method="POST" action="/content/manage/album/delete-audio-tracks"><input type="hidden" name="albumId" value="${escapeHtml(albumId)}" /><strong>${renderReferencedItem(album, String(album.title ?? ''), 'album')}</strong><span>${linkedTrackIds.length} linked track${linkedTrackIds.length === 1 ? '' : 's'}</span>${renderNestedList(linkedTracks)}${selectableTrackCount > 0 ? '<div class="batch-track-actions"><button class="select-all-tracks button--secondary" type="button">Select all</button><button class="batch-delete-button" data-danger type="submit" disabled>Delete selected tracks</button></div>' : ''}</form>`;
      }).join('') : '<p class="empty-linked-content">No albums yet.</p>'}
    </div>

        ${renderSectionList('My Pages', ownedPages, (item) => {
                const slug = escapeHtml(String(item.slug ?? ''));
                const title = escapeHtml(String(item.title ?? ''));
                const itemCount = Number(Array.isArray(item.items) ? item.items.length : 0);
                return `${title} [${slug}] - ${itemCount} page items`;
        })}
        <h3>My Carousels</h3>
        <div class="content-hierarchy">
          ${ownedCarousels.length > 0 ? ownedCarousels.map((carousel) => {
              const items = Array.isArray(carousel.items) ? [...carousel.items].sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0)) : [];
              const albumsById = new Map(ownedAlbums.map((album) => [contentId(album), album]));
              const tracksById = new Map(ownedAudioTracks.map((track) => [contentId(track), track]));
              const carouselItems = items.map((item: any) => {
                  const itemId = String(item.contentId ?? '');
                  if (item.contentType === 'album' && albumsById.has(itemId)) {
                      return `Album: ${renderReferencedItem(albumsById.get(itemId), String(albumsById.get(itemId).title ?? ''), 'album')}`;
                  }
                  if (item.contentType === 'audioTrack' && tracksById.has(itemId)) {
                      return `Track: ${renderReferencedItem(tracksById.get(itemId), String(tracksById.get(itemId).title ?? ''), 'audioTrack')}`;
                  }
                  return `${escapeHtml(String(item.contentType ?? 'Content'))}: ${renderMissingReference(itemId)}`;
              });

              return `<div class="hierarchy-item"><strong>${renderReferencedItem(carousel, String(carousel.name ?? ''))}</strong><span>${items.length} item${items.length === 1 ? '' : 's'}</span>${renderNestedList(carouselItems)}</div>`;
          }).join('') : '<p class="empty-linked-content">No carousels yet.</p>'}
        </div>
  </div>

    <div class="section-heading" id="composition"><div><p class="eyebrow">Presentation</p><h2>Composition</h2></div></div>
    <div class="grid">
        <div class="card">
            <h3>Save Page (Home/Library)</h3>
            <form method="POST" action="/content/manage/composition/page/save">
                <input name="slug" placeholder="Slug: home or library" required />
                <input name="title" placeholder="Page title" required />
                <button type="submit">Save Page</button>
            </form>

            <h3>Attach Carousel to Page</h3>
            <form method="POST" action="/content/manage/composition/page/attach-carousel">
                <select name="slug" required><option value="" disabled selected>Select page</option>${pageOptions}</select>
                <select name="carouselId" required><option value="" disabled selected>Select carousel</option>${carouselOptions}</select>
                <input name="position" placeholder="Position (optional, 0-based)" />
                <button type="submit">Attach Carousel</button>
            </form>

            <h3>Reorder Page Item</h3>
            <form class="drag-reorder" data-kind="page" method="POST" action="/content/manage/composition/page/reorder-item">
                <select class="reorder-selector" name="slug" required><option value="" disabled selected>Select page</option>${pageOptions}</select>
                <p class="drag-help">Drag a carousel to its new position, then save.</p>
                <ul class="drag-list" aria-label="Page item order"></ul>
                <input class="from-index" type="hidden" name="fromIndex" />
                <input class="to-index" type="hidden" name="toIndex" />
                <button class="save-reorder" type="submit" disabled>Save New Order</button>
            </form>

            <h3>Detach Carousel from Page</h3>
            <form method="POST" action="/content/manage/composition/page/detach-carousel">
                <select name="slug" required><option value="" disabled selected>Select page</option>${pageOptions}</select>
                <select name="carouselId" required><option value="" disabled selected>Select carousel</option>${carouselOptions}</select>
                <button type="submit">Detach Carousel</button>
            </form>
        </div>

        <div class="card">
            <h3>Create Carousel</h3>
            <form method="POST" action="/content/manage/composition/carousel/create">
                <input name="name" placeholder="Carousel name" required />
                <button type="submit">Create Carousel</button>
            </form>

            <h3>Add Item to Carousel</h3>
            <form method="POST" action="/content/manage/composition/carousel/add-item">
                <select name="carouselId" required><option value="" disabled selected>Select carousel</option>${carouselOptions}</select>
                <select name="contentType" required><option value="" disabled selected>Select content type</option><option value="post">Post</option><option value="album">Album</option><option value="audioTrack">Audio Track</option></select>
                <input name="contentId" placeholder="Content ID" required />
                <button type="submit">Add Carousel Item</button>
            </form>

            <h3>Reorder Carousel Item</h3>
            <form class="drag-reorder" data-kind="carousel" method="POST" action="/content/manage/composition/carousel/reorder-item">
                <select class="reorder-selector" name="carouselId" required><option value="" disabled selected>Select carousel</option>${carouselOptions}</select>
                <p class="drag-help">Drag an item to its new position, then save.</p>
                <ul class="drag-list" aria-label="Carousel item order"></ul>
                <input class="from-index" type="hidden" name="fromIndex" />
                <input class="to-index" type="hidden" name="toIndex" />
                <button class="save-reorder" type="submit" disabled>Save New Order</button>
            </form>
        </div>

        <div class="card">
            <h3>Move Items Between Carousels</h3>
            <form class="move-carousel-items" method="POST" action="/content/manage/composition/carousel/move-item">
                <select class="move-source-carousel" name="sourceCarouselId" required><option value="" disabled selected>Select source carousel</option>${carouselOptions}</select>
                <p class="drag-help">Select the items to move. They will keep their order and be added to the end of the destination carousel.</p>
                <ul class="move-item-list" aria-live="polite"><li class="empty-linked-content">Choose a source carousel to see its items.</li></ul>
                <select class="move-target-carousel" name="targetCarouselId" required><option value="" disabled selected>Select destination carousel</option>${carouselOptions}</select>
                <button class="move-selected-items" type="submit" disabled>Move Selected Items</button>
            </form>

            <h3>Delete Carousel</h3>
            <form method="POST" action="/content/manage/composition/carousel/delete">
                <input name="carouselId" placeholder="Carousel ID" required />
                <button data-danger type="submit">Delete Carousel</button>
            </form>
            <p>Deleting a carousel will automatically detach it from all pages.</p>
        </div>
    </div>

    <script>
      const compositionData = ${compositionData};
      const carouselNames = new Map(compositionData.carousels.map((carousel) => [carousel.id, carousel.name]));
      const albumTitles = new Map(compositionData.albums.map((album) => [album.id, album.title]));
      const trackTitles = new Map(compositionData.audioTracks.map((track) => [track.id, track.title]));

      const labelForCarouselItem = (item) => {
        if (item.contentType === 'album') return 'Album: ' + (albumTitles.get(item.contentId) || item.contentId);
        if (item.contentType === 'audioTrack') return 'Track: ' + (trackTitles.get(item.contentId) || item.contentId);
        return item.contentType + ': ' + item.contentId;
      };

      document.querySelectorAll('.drag-reorder').forEach((form) => {
        const kind = form.dataset.kind;
        const selector = form.querySelector('.reorder-selector');
        const list = form.querySelector('.drag-list');
        const fromInput = form.querySelector('.from-index');
        const toInput = form.querySelector('.to-index');
        const saveButton = form.querySelector('.save-reorder');
        let draggedItem = null;

        const renderItems = () => {
          list.replaceChildren();
          fromInput.value = '';
          toInput.value = '';
          saveButton.disabled = true;
          if (!selector.value) return;

          const source = kind === 'page'
            ? compositionData.pages.find((page) => page.slug === selector.value)
            : compositionData.carousels.find((carousel) => carousel.id === selector.value);
          const items = source ? [...source.items].sort((a, b) => a.order - b.order) : [];
          items.forEach((item, index) => {
            const element = document.createElement('li');
            element.className = 'drag-item';
            element.draggable = true;
            element.dataset.originalIndex = String(index);
            element.textContent = kind === 'page'
              ? (carouselNames.get(item.carouselId) || item.carouselId)
              : labelForCarouselItem(item);
            list.append(element);
          });
        };

        selector.addEventListener('change', renderItems);
        list.addEventListener('dragstart', (event) => {
          draggedItem = event.target.closest('.drag-item');
          if (draggedItem) draggedItem.classList.add('dragging');
        });
        list.addEventListener('dragend', () => {
          if (draggedItem) draggedItem.classList.remove('dragging');
          draggedItem = null;
          list.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
        });
        list.addEventListener('dragover', (event) => {
          event.preventDefault();
          const target = event.target.closest('.drag-item');
          if (target && target !== draggedItem) target.classList.add('drag-over');
        });
        list.addEventListener('dragleave', (event) => {
          const target = event.target.closest('.drag-item');
          if (target) target.classList.remove('drag-over');
        });
        list.addEventListener('drop', (event) => {
          event.preventDefault();
          const target = event.target.closest('.drag-item');
          if (!draggedItem || !target || target === draggedItem) return;
          const targetBounds = target.getBoundingClientRect();
          list.insertBefore(draggedItem, event.clientY > targetBounds.top + targetBounds.height / 2 ? target.nextSibling : target);
          fromInput.value = draggedItem.dataset.originalIndex || '';
          toInput.value = String([...list.children].indexOf(draggedItem));
          saveButton.disabled = fromInput.value === toInput.value;
          target.classList.remove('drag-over');
        });
      });

      document.querySelectorAll('.move-carousel-items').forEach((form) => {
        const sourceSelector = form.querySelector('.move-source-carousel');
        const targetSelector = form.querySelector('.move-target-carousel');
        const itemList = form.querySelector('.move-item-list');
        const submitButton = form.querySelector('.move-selected-items');

        const updateButton = () => {
          submitButton.disabled = !sourceSelector.value
            || !targetSelector.value
            || sourceSelector.value === targetSelector.value
            || itemList.querySelectorAll('input[name="fromIndexes"]:checked').length === 0;
        };

        const renderMoveChoices = () => {
          itemList.replaceChildren();
          [...targetSelector.options].forEach((option) => {
            option.disabled = Boolean(option.value) && option.value === sourceSelector.value;
          });
          if (targetSelector.value === sourceSelector.value) targetSelector.value = '';

          const source = compositionData.carousels.find((carousel) => carousel.id === sourceSelector.value);
          const items = source ? [...source.items].sort((a, b) => a.order - b.order) : [];
          if (items.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'empty-linked-content';
            empty.textContent = source ? 'This carousel has no items.' : 'Choose a source carousel to see its items.';
            itemList.append(empty);
            updateButton();
            return;
          }

          items.forEach((item, index) => {
            const listItem = document.createElement('li');
            const label = document.createElement('label');
            label.className = 'move-item-choice';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = 'fromIndexes';
            checkbox.value = String(index);
            const text = document.createElement('span');
            text.textContent = labelForCarouselItem(item);
            label.append(checkbox, text);
            listItem.append(label);
            itemList.append(listItem);
          });
          updateButton();
        };

        sourceSelector.addEventListener('change', renderMoveChoices);
        targetSelector.addEventListener('change', updateButton);
        itemList.addEventListener('change', updateButton);
      });
    </script>

  <div class="section-heading" id="create"><div><p class="eyebrow">New records</p><h2>Create</h2></div></div>
  <div class="grid">
    <div class="card">
      <h3>Create Artist</h3>
      <form method="POST" action="/content/manage/artist/create">
        <input name="name" placeholder="Name" required />
        <input name="birthDate" type="date" />
        <input name="bio" placeholder="Bio" />
        <input name="coverArtUrl" placeholder="Cover Art URL" />
        <input name="albumIds" placeholder="Album IDs (comma separated)" />
        <input name="audioTrackIds" placeholder="Audio Track IDs (comma separated)" />
        <button type="submit">Create Artist</button>
      </form>
    </div>

    <div class="card">
      <h3>Create Album</h3>
      <form method="POST" action="/content/manage/album/create">
        <input name="title" placeholder="Title" required />
        <input name="coverArtUrl" placeholder="Cover Art URL" />
        <input name="audioTrackIds" placeholder="Audio Track IDs (comma separated)" />
        <input name="releaseDate" type="date" />
        <button type="submit">Create Album</button>
      </form>
    </div>

    <div class="card">
      <h3>Create and Upload Audio Track</h3>
      <form method="POST" action="/content/manage/audioTrack/create" enctype="multipart/form-data">
        <input name="title" placeholder="Title" required />
        <input name="artistIds" placeholder="Artist IDs (comma separated)" />
        <input name="genres" placeholder="Genres (comma separated)" />
        <input name="albumId" placeholder="Album ID" />
        <input name="releaseDate" type="date" />
        <input name="duration" placeholder="Duration (e.g. 03:30)" />
        <input name="formatType" placeholder="Format type (e.g. MP3)" />
        <input name="formatBitrate" placeholder="Bitrate (e.g. 320)" />
        <input name="coverArtUrl" placeholder="Cover Art URL" />
        <input type="file" name="audioFile" accept="audio/*" required />
        <button type="submit">Create and Upload Audio Track</button>
      </form>
    </div>
  </div>

    <div class="section-heading" id="quick-linking"><div><p class="eyebrow">Relationships</p><h2>Quick Linking</h2></div></div>
    <div class="grid">
        <div class="card">
            <h3>Link Track to Album</h3>
            <form method="POST" action="/content/manage/link/track-album">
                <input name="audioTrackId" placeholder="Audio Track ID" required />
                <input name="albumId" placeholder="Album ID" required />
                <button type="submit">Link Track and Album</button>
            </form>
            <p>Sets track.albumId and ensures album.audioTrackIds contains the track.</p>
        </div>

        <div class="card">
            <h3>Link Album to Artist</h3>
            <form method="POST" action="/content/manage/link/album-artist">
                <input name="albumId" placeholder="Album ID" required />
                <input name="artistId" placeholder="Artist ID" required />
                <button type="submit">Link Album and Artist</button>
            </form>
            <p>Adds albumId into artist.albumIds if missing.</p>
        </div>

        <div class="card">
            <h3>Link Track to Artist</h3>
            <form method="POST" action="/content/manage/link/track-artist">
                <input name="audioTrackId" placeholder="Audio Track ID" required />
                <input name="artistId" placeholder="Artist ID" required />
                <button type="submit">Link Track and Artist</button>
            </form>
            <p>Adds artistId into track.artistIds and trackId into artist.audioTrackIds if missing.</p>
        </div>
    </div>

    <div class="section-heading" id="update-delete"><div><p class="eyebrow">Maintenance</p><h2>Update / Delete</h2></div></div>
  <div class="grid">
        <div class="card" id="artist-update-card">
      <h3>Artist</h3>
            <form method="GET" action="/content/manage#artist-update-card">
                <input type="hidden" name="prefillType" value="artist" />
                <input name="prefillId" value="${prefillArtistId}" placeholder="Artist ID" required />
                <button type="submit">Load Current</button>
            </form>
      <form method="POST" action="/content/manage/artist/update">
                <input name="artistId" value="${prefillArtistId}" placeholder="Artist ID" required />
                <input name="name" value="${escapeHtml(String(prefillArtist?.name ?? ''))}" placeholder="New Name (optional)" />
                <input name="bio" value="${escapeHtml(String(prefillArtist?.bio ?? ''))}" placeholder="New Bio (optional)" />
                <input name="coverArtUrl" value="${escapeHtml(String(prefillArtist?.coverArtUrl ?? ''))}" placeholder="New Cover URL (optional)" />
                <input name="albumIds" value="${escapeHtml(toCsvInput(prefillArtist?.albumIds))}" placeholder="Album IDs (comma separated)" />
                <input name="audioTrackIds" value="${escapeHtml(toCsvInput(prefillArtist?.audioTrackIds))}" placeholder="Audio Track IDs (comma separated)" />
        <button type="submit">Update Artist</button>
      </form>
      <form method="POST" action="/content/manage/artist/delete">
                <input name="artistId" value="${prefillArtistId}" placeholder="Artist ID" required />
        <button data-danger type="submit">Delete Artist</button>
      </form>
    </div>

        <div class="card" id="album-update-card">
      <h3>Album</h3>
            <form method="GET" action="/content/manage#album-update-card">
                <input type="hidden" name="prefillType" value="album" />
                <input name="prefillId" value="${prefillAlbumId}" placeholder="Album ID" required />
                <button type="submit">Load Current</button>
            </form>
      <form method="POST" action="/content/manage/album/update">
                <input name="albumId" value="${prefillAlbumId}" placeholder="Album ID" required />
                <input name="title" value="${escapeHtml(String(prefillAlbum?.title ?? ''))}" placeholder="New Title (optional)" />
                <input name="coverArtUrl" value="${escapeHtml(String(prefillAlbum?.coverArtUrl ?? ''))}" placeholder="New Cover URL (optional)" />
                <input name="audioTrackIds" value="${escapeHtml(toCsvInput(prefillAlbum?.audioTrackIds))}" placeholder="Audio Track IDs (comma separated)" />
                <input name="releaseDate" value="${escapeHtml(toDateInputValue(prefillAlbum?.releaseDate))}" type="date" />
        <button type="submit">Update Album</button>
      </form>
      <form method="POST" action="/content/manage/album/delete">
                <input name="albumId" value="${prefillAlbumId}" placeholder="Album ID" required />
        <button data-danger type="submit">Delete Album</button>
      </form>
    </div>

        <div class="card" id="audio-track-update-card">
      <h3>Audio Track</h3>
            <form method="GET" action="/content/manage#audio-track-update-card">
                <input type="hidden" name="prefillType" value="audioTrack" />
                <input name="prefillId" value="${prefillAudioTrackId}" placeholder="Audio Track ID" required />
                <button type="submit">Load Current</button>
            </form>
      <form method="POST" action="/content/manage/audioTrack/update">
                <input name="audioTrackId" value="${prefillAudioTrackId}" placeholder="Audio Track ID" required />
                <input name="title" value="${escapeHtml(String(prefillAudioTrack?.title ?? ''))}" placeholder="New Title (optional)" />
                <input name="coverArtUrl" value="${escapeHtml(String(prefillAudioTrack?.coverArtUrl ?? ''))}" placeholder="New Cover URL (optional)" />
                <input name="artistIds" value="${escapeHtml(toCsvInput(prefillAudioTrack?.artistIds))}" placeholder="Artist IDs (comma separated)" />
                <input name="genres" value="${escapeHtml(toCsvInput(prefillAudioTrack?.genres))}" placeholder="Genres (comma separated)" />
                <input name="albumId" value="${escapeHtml(String(prefillAudioTrack?.albumId ?? ''))}" placeholder="Album ID" />
                <input name="releaseDate" value="${escapeHtml(toDateInputValue(prefillAudioTrack?.releaseDate))}" type="date" />
                <input name="duration" value="${escapeHtml(String(prefillAudioTrack?.duration ?? ''))}" placeholder="Duration (e.g. 03:30)" />
                <input name="formatType" value="${escapeHtml(String(prefillAudioTrack?.format?.type ?? ''))}" placeholder="Format type (e.g. MP3)" />
                <input name="formatBitrate" value="${escapeHtml(String(prefillAudioTrack?.format?.bitrate ?? ''))}" placeholder="Bitrate (e.g. 320)" />
        <button type="submit">Update Audio Track</button>
      </form>
      <form method="POST" action="/content/manage/audioTrack/delete">
                <input name="audioTrackId" value="${prefillAudioTrackId}" placeholder="Audio Track ID" required />
        <button data-danger type="submit">Delete Audio Track</button>
      </form>
            <hr />
            <h3>Bulk Upload Audio Files</h3>
            <p>Select up to 20 files. A track is created for each file using its embedded metadata when available.</p>
            <form id="bulk-audio-upload-form" method="POST" action="/content/manage/audioTrack/bulk-upload" enctype="multipart/form-data">
                <select name="albumId"><option value="">No album</option>${albumOptions}</select>
                <input type="file" name="audioFiles" accept="audio/*" multiple required />
                <button type="submit">Create and Upload Audio Files</button>
                <div id="bulk-upload-status" role="status" aria-live="polite" hidden>
                    <progress id="bulk-upload-progress" max="100" value="0">0%</progress>
                    <span id="bulk-upload-progress-label">0%</span>
                </div>
            </form>
            <script>
              (() => {
                const form = document.getElementById('bulk-audio-upload-form');
                if (!form) return;

                const status = document.getElementById('bulk-upload-status');
                const progress = document.getElementById('bulk-upload-progress');
                const label = document.getElementById('bulk-upload-progress-label');
                const button = form.querySelector('button[type="submit"]');

                const showStatus = (message, percentage) => {
                  status.hidden = false;
                  if (typeof percentage === 'number') progress.value = percentage;
                  label.textContent = message;
                };

                form.addEventListener('submit', (event) => {
                  event.preventDefault();
                  const files = form.querySelector('input[name="audioFiles"]').files;
                  if (!files || files.length === 0) return;

                  button.disabled = true;
                  showStatus('Starting upload…', 0);
                  const request = new XMLHttpRequest();
                  request.open('POST', form.action);
                  request.upload.addEventListener('progress', (progressEvent) => {
                    if (!progressEvent.lengthComputable) {
                      showStatus('Uploading…', 0);
                      return;
                    }
                    const percentage = Math.round((progressEvent.loaded / progressEvent.total) * 100);
                    showStatus('Uploading… ' + percentage + '%', percentage);
                  });
                  request.addEventListener('load', () => {
                    if (request.status >= 200 && request.status < 400) {
                      showStatus('Upload complete. Saving track details…', 100);
                      window.location.assign(request.responseURL || '/content/manage');
                      return;
                    }

                    let errorMessage = 'Upload failed. Please try again.';
                    try {
                      errorMessage = JSON.parse(request.responseText).message || errorMessage;
                    } catch (error) {
                      // Non-JSON responses, including proxy errors, use the default message.
                    }
                    showStatus(errorMessage, 0);
                    button.disabled = false;
                  });
                  request.addEventListener('error', () => {
                    showStatus('Upload failed before reaching the server. Please try again.', 0);
                    button.disabled = false;
                  });
                  request.send(new FormData(form));
                });
              })();
            </script>
            <hr />
            <h3>Upload Audio File</h3>
            <form method="POST" action="/content/manage/audioTrack/upload" enctype="multipart/form-data">
                <input name="audioTrackId" value="${selectedUploadTrackId}" placeholder="Audio Track ID" required />
                <input type="file" name="audioFile" accept="audio/*" required />
                <button type="submit">Upload File to S3</button>
            </form>
    </div>
  </div>
  <script>
    (() => {
      const labels = {
        slug: 'Page',
        carouselId: 'Carousel',
        sourceCarouselId: 'Source carousel',
        targetCarouselId: 'Target carousel',
        contentType: 'Content type',
        albumId: 'Album',
        birthDate: 'Birth date',
        releaseDate: 'Release date',
        audioFiles: 'Audio files',
        audioFile: 'Audio file'
      };

      document.querySelectorAll('form input, form select, form textarea').forEach((field, index) => {
        if (field.type === 'hidden' || field.type === 'submit' || field.type === 'button') return;

        const labelText = field.dataset.label || field.getAttribute('placeholder') || labels[field.name];
        if (!labelText) return;

        const id = field.id || 'content-field-' + index;
        field.id = id;
        const label = document.createElement('label');
        label.className = 'field-label';
        label.htmlFor = id;
        label.textContent = labelText;
        field.before(label);
      });

      document.querySelectorAll('[data-batch-track-delete]').forEach((form) => {
        const button = form.querySelector('.batch-delete-button');
        const selectAllButton = form.querySelector('.select-all-tracks');
        const trackCheckboxes = [...form.querySelectorAll('input[name="audioTrackIds"]')];
        const selectedTracks = () => form.querySelectorAll('input[name="audioTrackIds"]:checked');
        const updateBatchControls = () => {
          button.disabled = selectedTracks().length === 0;
          selectAllButton.textContent = selectedTracks().length === trackCheckboxes.length ? 'Clear selection' : 'Select all';
        };
        form.addEventListener('change', updateBatchControls);
        selectAllButton.addEventListener('click', () => {
          const selectAll = selectedTracks().length !== trackCheckboxes.length;
          trackCheckboxes.forEach((checkbox) => {
            checkbox.checked = selectAll;
          });
          updateBatchControls();
        });
        form.addEventListener('submit', (event) => {
          const count = selectedTracks().length;
          if (count === 0 || !window.confirm('Delete ' + count + ' selected audio track' + (count === 1 ? '' : 's') + '? This also removes their uploaded files.')) {
            event.preventDefault();
          }
        });
      });

      document.querySelectorAll('button[data-danger]').forEach((button) => {
        const form = button.closest('form');
        if (!form || form.matches('[data-batch-track-delete]')) return;
        form.addEventListener('submit', (event) => {
          if (!window.confirm('Delete this item? This action cannot be undone.')) {
            event.preventDefault();
          }
        });
      });
    })();
  </script>
  </main>
</body>
</html>`;
};

const getOwnerId = (doc: any) => {
    return String(doc?.createdBy ?? '');
};

const redirectWithMessage = (res: Response, message: string) => {
    res.redirect(`/content/manage?message=${encodeURIComponent(message)}`);
};

const renderAudioTracksPage = (userEmail: string, tracks: any[]) => {
    const trackItems = tracks.length > 0
        ? tracks.map((track) => {
            const id = String(track._id ?? '');
            const editUrl = `/content/manage?prefillType=audioTrack&prefillId=${encodeURIComponent(id)}#audio-track-update-card`;
            const albumId = String(track.albumId ?? '').trim();
            const originalFileName = String(track.originalFileName ?? '').trim();
            const title = String(track.title ?? 'Untitled Track');
            return `<li data-track-item data-search="${escapeHtml(`${title} ${id} ${albumId} ${originalFileName}`.toLowerCase())}">
              <div class="track-title-row"><strong>${escapeHtml(title)}</strong>${albumId ? '<span class="pill">In album</span>' : '<span class="pill pill--muted">Unassigned</span>'}</div>
              <div class="item-meta">
                <span>Track ID: <code>${escapeHtml(id)}</code></span>
                <span>${albumId ? `Album ID: <code>${escapeHtml(albumId)}</code>` : 'No album assigned'}</span>
                ${originalFileName ? `<span>File: ${escapeHtml(originalFileName)}</span>` : ''}
              </div>
              <div><a class="button button--secondary" href="${editUrl}">Edit track</a></div>
            </li>`;
        }).join('')
        : '<li class="empty-state">No audio tracks yet. Create one from the Content Manager.</li>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Audio Tracks - Archtree</title>
  <link rel="stylesheet" href="/assets/archtree.css" />
  <style>
    .track-toolbar { align-items: end; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto; margin-bottom: 18px; }
    .track-title-row { align-items: center; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; }
    .pill--muted { color: #58635e; background: #e8ebe7; }
    [data-track-item] { display: grid; gap: 10px; }
    @media (max-width: 600px) { .track-toolbar { align-items: stretch; grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="page-shell">
    <header class="site-header">
      <div>
        <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">A</span><span>Archtree</span></a>
        <p class="eyebrow" style="margin-top:18px;">Audio library</p>
        <h1 style="margin-bottom:8px;">My Audio Tracks</h1>
        <p class="muted">Signed in as <strong>${escapeHtml(userEmail)}</strong> · ${tracks.length} track${tracks.length === 1 ? '' : 's'}</p>
      </div>
      <div class="header-actions">
        <a class="button" href="/content/manage#create">Create and upload</a>
        <a class="button button--secondary" href="/content/manage">Content Manager</a>
        <form method="POST" action="/auth/logout-web"><button class="button--secondary" type="submit">Log out</button></form>
      </div>
    </header>
    <section class="card card--raised">
      <div class="track-toolbar">
        <div>
          <label for="track-filter">Filter tracks</label>
          <input id="track-filter" type="search" placeholder="Search title, ID, album, or filename" />
        </div>
        <span class="muted" id="track-filter-count">${tracks.length} shown</span>
      </div>
      <ul class="item-list" id="track-list">${trackItems}</ul>
      <div class="empty-state" id="track-filter-empty" hidden>No tracks match this search.</div>
    </section>
  </main>
  <script>
    (() => {
      const filter = document.getElementById('track-filter');
      const items = [...document.querySelectorAll('[data-track-item]')];
      const count = document.getElementById('track-filter-count');
      const empty = document.getElementById('track-filter-empty');
      filter.addEventListener('input', () => {
        const query = filter.value.trim().toLowerCase();
        let visible = 0;
        items.forEach((item) => {
          const matches = !query || item.dataset.search.includes(query);
          item.hidden = !matches;
          if (matches) visible += 1;
        });
        count.textContent = visible + ' shown';
        empty.hidden = visible !== 0 || items.length === 0;
      });
    })();
  </script>
</body>
</html>`;
};

export const renderAudioTracksPageForWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage%2Faudio-tracks');
        }

        const tracks = await AudioTrack.fetchByCreator(authReq.auth.userId);
        return res.status(200).send(renderAudioTracksPage(authReq.auth.email, tracks));
    } catch (error) {
        return next(error);
    }
};

export const renderManagePageForWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const ownedByUser = authReq.auth.userId;
        const [ownedArtists, ownedAlbums, ownedAudioTracks, ownedPages, ownedCarousels, s3StorageSummaryResult] = await Promise.all([
            Artist.fetchByCreator(ownedByUser),
            Album.fetchByCreator(ownedByUser),
            AudioTrack.fetchByCreator(ownedByUser),
            Page.fetchByCreator(ownedByUser),
            Carousel.fetchByCreator(ownedByUser),
            loadS3StorageSummary()
        ]);

        const queryMessage = String(req.query.message ?? '');
        let message = queryMessage;
        const selectedUploadTrackId = String(req.query.uploadAudioTrackId ?? '');
        const prefillType = String(req.query.prefillType ?? '').trim();
        const prefillId = String(req.query.prefillId ?? '').trim();

        let prefillArtist: any | null = null;
        let prefillAlbum: any | null = null;
        let prefillAudioTrack: any | null = null;
        let prefillArtistId = '';
        let prefillAlbumId = '';
        let prefillAudioTrackId = selectedUploadTrackId;

        if (prefillType && prefillId) {
            try {
                if (prefillType === 'artist') {
                    const artist = await Artist.findById(prefillId);
                    if (artist && ensureOwnerOrAdmin(authReq, getOwnerId(artist))) {
                        prefillArtist = artist;
                        prefillArtistId = prefillId;
                    } else if (!message) {
                        message = 'Unable to load artist for this ID.';
                    }
                }

                if (prefillType === 'album') {
                    const album = await Album.findById(prefillId);
                    if (album && ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
                        prefillAlbum = album;
                        prefillAlbumId = prefillId;
                    } else if (!message) {
                        message = 'Unable to load album for this ID.';
                    }
                }

                if (prefillType === 'audioTrack') {
                    const track = await AudioTrack.findById(prefillId);
                    if (track && ensureOwnerOrAdmin(authReq, getOwnerId(track))) {
                        prefillAudioTrack = track;
                        prefillAudioTrackId = prefillId;
                    } else if (!message) {
                        message = 'Unable to load audio track for this ID.';
                    }
                }
            } catch (error) {
                if (!message) {
                    message = 'Unable to load current values: invalid or inaccessible ID.';
                }
            }
        }

        return res.status(200).send(renderManagePage({
            userEmail: authReq.auth.email,
            message,
            selectedUploadTrackId,
            ownedArtists,
            ownedAlbums,
            ownedAudioTracks,
            ownedPages,
            ownedCarousels,
            s3StorageSummary: s3StorageSummaryResult.summary,
            s3StorageSummaryError: s3StorageSummaryResult.errorCode,
            prefillArtistId,
            prefillAlbumId,
            prefillAudioTrackId,
            prefillArtist,
            prefillAlbum,
            prefillAudioTrack
        }));
    } catch (error) {
        return next(error);
    }
};

export const searchContentWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const rawQuery = String(req.query.q ?? '').trim();
        const selectedUploadTrackId = String(req.query.uploadAudioTrackId ?? '');
        const parsedLimit = Number(req.query.limit ?? 10);
        const limit = Number.isNaN(parsedLimit) ? 10 : Math.max(1, Math.min(parsedLimit, 50));

        const [artists, albums, audioTracks, ownedArtists, ownedAlbums, ownedAudioTracks, ownedPages, ownedCarousels, s3StorageSummaryResult] = await Promise.all([
            rawQuery ? Artist.searchByName(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? Album.searchByTitle(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? AudioTrack.searchByTitle(rawQuery, limit) : Promise.resolve([]),
            Artist.fetchByCreator(authReq.auth.userId),
            Album.fetchByCreator(authReq.auth.userId),
            AudioTrack.fetchByCreator(authReq.auth.userId),
            Page.fetchByCreator(authReq.auth.userId),
            Carousel.fetchByCreator(authReq.auth.userId),
            loadS3StorageSummary()
        ]);

        return res.status(200).send(renderManagePage({
            userEmail: authReq.auth.email,
            searchQuery: rawQuery,
            selectedUploadTrackId,
            artists,
            albums,
            audioTracks,
            ownedArtists,
            ownedAlbums,
            ownedAudioTracks,
            ownedPages,
            ownedCarousels,
            s3StorageSummary: s3StorageSummaryResult.summary,
            s3StorageSummaryError: s3StorageSummaryResult.errorCode
        }));
    } catch (error) {
        return next(error);
    }
};

export const createArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const artist = new Artist(
            String(req.body.name ?? ''),
            parseDateInput(String(req.body.birthDate ?? '')),
            String(req.body.bio ?? ''),
            String(req.body.coverArtUrl ?? ''),
            parseCsv(String(req.body.albumIds ?? '')),
            parseCsv(String(req.body.audioTrackIds ?? '')),
            authReq.auth.userId
        );

        await artist.save();
        return redirectWithMessage(res, 'Artist created successfully.');
    } catch (error) {
        return next(error);
    }
};

export const updateArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const artistId = String(req.body.artistId ?? '');
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(artist))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this artist.');
        }

        const updatePayload: Record<string, unknown> = {};
        if (req.body.name) updatePayload.name = String(req.body.name);
        if (req.body.bio) updatePayload.bio = String(req.body.bio);
        if (req.body.coverArtUrl) updatePayload.coverArtUrl = String(req.body.coverArtUrl);
        if (req.body.albumIds) updatePayload.albumIds = parseCsv(String(req.body.albumIds));
        if (req.body.audioTrackIds) updatePayload.audioTrackIds = parseCsv(String(req.body.audioTrackIds));

        await Artist.updateById(artistId, updatePayload);
        return redirectWithMessage(res, 'Artist updated successfully.');
    } catch (error) {
        return next(error);
    }
};

export const deleteArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const artistId = String(req.body.artistId ?? '');
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(artist))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can delete this artist.');
        }

        await Artist.deleteById(artistId);
        return redirectWithMessage(res, 'Artist deleted successfully.');
    } catch (error) {
        return next(error);
    }
};

export const createAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const album = new Album(
            String(req.body.title ?? ''),
            String(req.body.coverArtUrl ?? ''),
            parseCsv(String(req.body.audioTrackIds ?? '')),
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId
        );

        await album.save();
        return redirectWithMessage(res, 'Album created successfully.');
    } catch (error) {
        return next(error);
    }
};

export const updateAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const albumId = String(req.body.albumId ?? '');
        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this album.');
        }

        const updatePayload: Record<string, unknown> = {};
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.coverArtUrl) updatePayload.coverArtUrl = String(req.body.coverArtUrl);
        if (req.body.audioTrackIds) updatePayload.audioTrackIds = parseCsv(String(req.body.audioTrackIds));
        if (req.body.releaseDate) updatePayload.releaseDate = parseDateInput(String(req.body.releaseDate));

        await Album.updateById(albumId, updatePayload);
        return redirectWithMessage(res, 'Album updated successfully.');
    } catch (error) {
        return next(error);
    }
};

export const deleteAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const albumId = String(req.body.albumId ?? '');
        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can delete this album.');
        }

        await Album.deleteById(albumId);
        return redirectWithMessage(res, 'Album deleted successfully.');
    } catch (error) {
        return next(error);
    }
};

export const createAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
        if (!uploadFile) {
            return redirectWithMessage(res, 'An audio file is required to create an audio track.');
        }

        const albumId = String(req.body.albumId ?? '').trim();
        let album: any | null = null;
        if (albumId) {
            album = await Album.findById(albumId);
            if (!album || !ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
                return redirectWithMessage(res, 'Selected album was not found or cannot be modified.');
            }
        }

        const formatType = String(req.body.formatType ?? 'MP3');
        const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
        const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;
        const audioTrackObjectId = new ObjectId();
        const audioTrackId = audioTrackObjectId.toHexString();
        const originalFileName = normalizeUtf8Text(uploadFile.originalname);

        const track = new AudioTrack(
            normalizeUtf8Text(String(req.body.title ?? '')),
            parseCsv(String(req.body.artistIds ?? '')),
            parseCsv(String(req.body.genres ?? '')),
            albumId,
            parseDateInput(String(req.body.releaseDate ?? '')),
            String(req.body.duration ?? ''),
            new AudioFormat(formatType, Number.isNaN(bitrate as number) ? undefined : bitrate),
            String(req.body.coverArtUrl ?? ''),
            authReq.auth.userId,
            originalFileName,
            uploadFile.mimetype || 'audio/mpeg',
            audioTrackObjectId
        );

        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId,
            Body: uploadFile.buffer,
            ContentType: uploadFile.mimetype || 'audio/mpeg'
        }));

        try {
            await track.save();
        } catch (databaseError) {
            await getS3().send(new DeleteObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: audioTrackId
            })).catch((cleanupError) => {
                console.log('Unable to clean up S3 file after track creation failed:', cleanupError);
            });
            throw databaseError;
        }

        if (album) {
            const albumTrackIds = uniqueStrings([
                ...(Array.isArray(album.audioTrackIds) ? album.audioTrackIds.map(String) : []),
                audioTrackId
            ]);
            await Album.updateById(albumId, { audioTrackIds: albumTrackIds as [string] });
        }

        return redirectWithMessage(res, 'Audio track and file created successfully.');
    } catch (error) {
        return next(error);
    }
};

export const updateAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const audioTrackId = String(req.body.audioTrackId ?? '');
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(track))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this audio track.');
        }

        const updatePayload: Record<string, unknown> = {};
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.coverArtUrl) updatePayload.coverArtUrl = String(req.body.coverArtUrl);
        if (req.body.artistIds) updatePayload.artistIds = parseCsv(String(req.body.artistIds));
        if (req.body.genres) updatePayload.genres = parseCsv(String(req.body.genres));
        if (req.body.albumId) updatePayload.albumId = String(req.body.albumId);
        if (req.body.releaseDate) updatePayload.releaseDate = parseDateInput(String(req.body.releaseDate));
        if (req.body.duration) updatePayload.duration = String(req.body.duration);
        if (req.body.formatType) {
            const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
            const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;
            updatePayload.format = new AudioFormat(
                String(req.body.formatType),
                Number.isNaN(bitrate as number) ? undefined : bitrate
            );
        }

        await AudioTrack.updateById(audioTrackId, updatePayload);
        return redirectWithMessage(res, 'Audio track updated successfully.');
    } catch (error) {
        return next(error);
    }
};

export const deleteAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const audioTrackId = String(req.body.audioTrackId ?? '');
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(track))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can delete this audio track.');
        }

        await AudioTrack.deleteById(audioTrackId);

        try {
            await getS3().send(new DeleteObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: audioTrackId
            }));
            return redirectWithMessage(res, 'Audio track deleted successfully.');
        } catch (s3Error) {
            console.log('S3 cleanup failed for audioTrackId:', audioTrackId, s3Error);
            return redirectWithMessage(res, 'Audio track deleted, but S3 file cleanup failed.');
        }
    } catch (error) {
        return next(error);
    }
};

export const deleteAlbumAudioTracksWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const albumId = String(req.body.albumId ?? '').trim();
        const selectedTrackIds = uniqueStrings(
            Array.isArray(req.body.audioTrackIds)
                ? req.body.audioTrackIds.map(String)
                : req.body.audioTrackIds ? [String(req.body.audioTrackIds)] : []
        );
        if (!albumId || selectedTrackIds.length === 0) {
            return redirectWithMessage(res, 'Select at least one audio track to delete.');
        }

        const album = await Album.findById(albumId);
        if (!album || !ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
            return redirectWithMessage(res, 'Album not found or cannot be modified.');
        }

        const tracks = await Promise.all(selectedTrackIds.map((trackId) => AudioTrack.findById(trackId)));
        const associatedTrackIds = new Set(uniqueStrings([
            ...(Array.isArray((album as any).audioTrackIds) ? (album as any).audioTrackIds.map(String) : []),
            ...tracks.filter(Boolean).filter((track: any) => String(track.albumId ?? '') === albumId).map(contentId)
        ]));
        if (tracks.some((track) => !track) || selectedTrackIds.some((trackId) => !associatedTrackIds.has(trackId))) {
            return redirectWithMessage(res, 'One or more selected tracks do not belong to this album.');
        }
        if (tracks.some((track) => !ensureOwnerOrAdmin(authReq, getOwnerId(track)))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can delete every selected track.');
        }

        await Promise.all(selectedTrackIds.map((trackId) => AudioTrack.deleteById(trackId)));
        const remainingTrackIds = uniqueStrings(
            (Array.isArray((album as any).audioTrackIds) ? (album as any).audioTrackIds : []).map(String)
        ).filter((trackId) => !selectedTrackIds.includes(trackId));
        await Album.updateById(albumId, { audioTrackIds: remainingTrackIds as [string] });

        const s3Results = await Promise.allSettled(selectedTrackIds.map((trackId) => getS3().send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: trackId
        }))));
        const failedS3Deletes = s3Results.filter((result) => result.status === 'rejected').length;
        if (failedS3Deletes > 0) {
            console.log(`S3 cleanup failed for ${failedS3Deletes} deleted audio track(s).`, s3Results);
            return redirectWithMessage(res, `${selectedTrackIds.length} audio track(s) deleted, but ${failedS3Deletes} uploaded file(s) could not be removed.`);
        }

        return redirectWithMessage(res, `${selectedTrackIds.length} audio track(s) deleted successfully.`);
    } catch (error) {
        return next(error);
    }
};

export const uploadAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const audioTrackId = String(req.body.audioTrackId ?? '');
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(track))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can upload for this audio track.');
        }

        const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
        if (!uploadFile) {
            return redirectWithMessage(res, 'Missing audio file.');
        }

        await getS3().send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId,
            Body: uploadFile.buffer,
            ContentType: uploadFile.mimetype || 'audio/mpeg'
        }));

        await AudioTrack.updateById(audioTrackId, {
            originalFileName: normalizeUtf8Text(uploadFile.originalname),
            contentType: uploadFile.mimetype || 'audio/mpeg'
        });

        return redirectWithMessage(res, 'Audio file uploaded successfully.');
    } catch (error) {
        return next(error);
    }
};

export const bulkUploadAudioTracksWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const uploadFiles = (req as Request & { files?: Express.Multer.File[] }).files ?? [];
        if (uploadFiles.length === 0) {
            return redirectWithMessage(res, 'Select at least one audio file to upload.');
        }

        const albumId = String(req.body.albumId ?? '').trim();
        let album: any | null = null;
        if (albumId) {
            album = await Album.findById(albumId);
            if (!album || !ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
                return redirectWithMessage(res, 'Selected album was not found or cannot be modified.');
            }
        }

        const uploadedTrackIds: string[] = [];
        const failures: string[] = [];

        for (const uploadFile of uploadFiles) {
            const originalFileName = normalizeUtf8Text(uploadFile.originalname);
            const isAudioFile = uploadFile.mimetype.startsWith('audio/')
                || uploadFile.mimetype === 'video/mp4'
                || uploadFile.mimetype === 'application/ogg';
            if (!isAudioFile) {
                failures.push(originalFileName);
                continue;
            }

            let metadata: any = null;
            try {
                metadata = await parseBuffer(Uint8Array.from(uploadFile.buffer), {
                    mimeType: uploadFile.mimetype || undefined,
                    size: uploadFile.size
                }, {
                    duration: true,
                    skipCovers: true
                });
            } catch (metadataError) {
                console.log(`Unable to read audio metadata for ${originalFileName}:`, metadataError);
            }

            const embeddedGenres = Array.isArray(metadata?.common?.genre) ? metadata.common.genre.map(String) : [];
            const releaseYear = Number(metadata?.common?.year);
            const bitrate = Number(metadata?.format?.bitrate);
            const audioTrackObjectId = new ObjectId();
            const audioTrackId = audioTrackObjectId.toHexString();
            const metadataTitle = normalizeUtf8Text(String(metadata?.common?.title ?? ''));
            const track = new AudioTrack(
                metadataTitle || titleFromFileName(originalFileName) || 'Untitled Track',
                [] as unknown as [string],
                embeddedGenres as unknown as [string],
                albumId,
                Number.isFinite(releaseYear) && releaseYear > 0 ? new SimpleDate(releaseYear, 1, 1) : new SimpleDate(),
                formatDuration(metadata?.format?.duration),
                new AudioFormat(
                    inferAudioFormat(originalFileName, uploadFile.mimetype, metadata?.format?.container),
                    Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate / 1000) : undefined
                ),
                '',
                authReq.auth.userId,
                originalFileName,
                uploadFile.mimetype || 'audio/mpeg',
                audioTrackObjectId
            );

            try {
                await getS3().send(new PutObjectCommand({
                    Bucket: process.env.S3_BUCKET_NAME!,
                    Key: audioTrackId,
                    Body: uploadFile.buffer,
                    ContentType: uploadFile.mimetype || 'audio/mpeg'
                }));
                await track.save();
                uploadedTrackIds.push(audioTrackId);
            } catch (uploadError) {
                console.log(`Unable to upload ${originalFileName}:`, uploadError);
                await Promise.allSettled([
                    AudioTrack.deleteById(audioTrackId),
                    getS3().send(new DeleteObjectCommand({
                        Bucket: process.env.S3_BUCKET_NAME!,
                        Key: audioTrackId
                    }))
                ]);
                failures.push(originalFileName);
            }
        }

        if (album && uploadedTrackIds.length > 0) {
            const albumTrackIds = uniqueStrings([
                ...(Array.isArray(album.audioTrackIds) ? album.audioTrackIds.map(String) : []),
                ...uploadedTrackIds
            ]);
            await Album.updateById(albumId, { audioTrackIds: albumTrackIds as [string] });
        }

        const message = `${uploadedTrackIds.length} audio track${uploadedTrackIds.length === 1 ? '' : 's'} created and uploaded.${failures.length > 0 ? ` ${failures.length} file${failures.length === 1 ? '' : 's'} failed.` : ''}`;
        return redirectWithMessage(res, message);
    } catch (error) {
        return next(error);
    }
};

export const linkTrackToAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const albumId = String(req.body.albumId ?? '').trim();
        const track = await AudioTrack.findById(audioTrackId);
        const album = await Album.findById(albumId);

        if (!track || !album) {
            return redirectWithMessage(res, 'Track or album not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(track)) || !ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can link these records.');
        }

        const albumTrackIds = uniqueStrings([...(Array.isArray((album as any).audioTrackIds) ? (album as any).audioTrackIds : []), audioTrackId]);

        await Promise.all([
            AudioTrack.updateById(audioTrackId, { albumId }),
            Album.updateById(albumId, { audioTrackIds: albumTrackIds as [string] })
        ]);

        return redirectWithMessage(res, 'Track linked to album successfully.');
    } catch (error) {
        return next(error);
    }
};

export const linkAlbumToArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const albumId = String(req.body.albumId ?? '').trim();
        const artistId = String(req.body.artistId ?? '').trim();
        const album = await Album.findById(albumId);
        const artist = await Artist.findById(artistId);

        if (!album || !artist) {
            return redirectWithMessage(res, 'Album or artist not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(album)) || !ensureOwnerOrAdmin(authReq, getOwnerId(artist))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can link these records.');
        }

        const artistAlbumIds = uniqueStrings([...(Array.isArray((artist as any).albumIds) ? (artist as any).albumIds : []), albumId]);
        await Artist.updateById(artistId, { albumIds: artistAlbumIds as [string] });

        return redirectWithMessage(res, 'Album linked to artist successfully.');
    } catch (error) {
        return next(error);
    }
};

export const linkTrackToArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const artistId = String(req.body.artistId ?? '').trim();
        const track = await AudioTrack.findById(audioTrackId);
        const artist = await Artist.findById(artistId);

        if (!track || !artist) {
            return redirectWithMessage(res, 'Track or artist not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(track)) || !ensureOwnerOrAdmin(authReq, getOwnerId(artist))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can link these records.');
        }

        const trackArtistIds = uniqueStrings([...(Array.isArray((track as any).artistIds) ? (track as any).artistIds : []), artistId]);
        const artistTrackIds = uniqueStrings([...(Array.isArray((artist as any).audioTrackIds) ? (artist as any).audioTrackIds : []), audioTrackId]);

        await Promise.all([
            AudioTrack.updateById(audioTrackId, { artistIds: trackArtistIds as [string] }),
            Artist.updateById(artistId, { audioTrackIds: artistTrackIds as [string] })
        ]);

        return redirectWithMessage(res, 'Track linked to artist successfully.');
    } catch (error) {
        return next(error);
    }
};

export const searchContent = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rawQuery = String(req.query.q ?? '').trim();
        if (!rawQuery) {
            return res.status(400).json({ message: 'Missing required query parameter: q' });
        }

        const parsedLimit = Number(req.query.limit ?? 10);
        const limit = Number.isNaN(parsedLimit) ? 10 : Math.max(1, Math.min(parsedLimit, 50));

        const [artists, albums, audioTracks] = await Promise.all([
            Artist.searchByName(rawQuery, limit),
            Album.searchByTitle(rawQuery, limit),
            AudioTrack.searchByTitle(rawQuery, limit)
        ]);

        return res.status(200).json({
            query: rawQuery,
            artists,
            albums,
            audioTracks
        });
    } catch (error) {
        return next(error);
    }
};
