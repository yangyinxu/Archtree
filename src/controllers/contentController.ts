import { Request, Response, NextFunction } from 'express';
import { Artist } from '../models/artist';
import { Album } from '../models/album';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';
import { Carousel } from '../models/carousel';
import { Page } from '../models/page';
import { ContentCollection } from '../models/contentCollection';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { parseBuffer, parseFile } from 'music-metadata';
import { ObjectId } from 'mongodb';
import { normalizeUtf8Text } from '../utils/textEncoding';
import { escapeHtml } from '../views/html';
import { renderAudioTracksPage } from '../views/contentManager/audioTracksView';
import {
    formatStorageSize,
    loadS3StorageSummary,
    S3StorageSummary
} from '../services/s3StorageService';
import {
    formatDuration,
    inferAudioFormat,
    titleFromFileName
} from '../services/audioMetadataService';
import {
    deleteAudioObjectAndTrack,
    uploadAudioObject
} from '../services/audioStorageService';
import { cleanupDeletedContentReferences, validateContentReferences } from '../services/contentReferenceService';
import { deleteCoverArt, uploadCoverArt, validateCoverArtFile } from '../services/imageStorageService';
import { getUploadedFile } from '../middleware/imageUpload';
import { boundedSearchQuery } from '../utils/search';
import { getRequestAbortSignal } from '../middleware/requestProtectionMiddleware';
import { renderPageItemsHierarchy } from '../views/contentManager/pageItemsView';
import {
    ManagementInventoryPage,
    managementInventoryOffset,
    managementInventoryPageSize,
    normalizeManagementInventoryPage,
    toManagementInventoryPage
} from '../views/contentManager/inventoryPagination';
import { searchPublicCatalog } from '../services/publicCatalogService';
import { boundedLimit } from '../utils/pagination';

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

const inventoryQueryNames = {
    artists: 'artistsPage',
    albums: 'albumsPage',
    audioTracks: 'audioTracksPage',
    pages: 'pagesPage',
    carousels: 'carouselsPage',
    contentCollections: 'contentCollectionsPage'
} as const;

type InventoryKey = keyof typeof inventoryQueryNames;
type InventoryPaginationEntry = Omit<ManagementInventoryPage<unknown>, 'items'>;
type InventoryPagination = Record<InventoryKey, InventoryPaginationEntry>;

const requestedInventoryPages = (query: Request['query']) => Object.fromEntries(
    Object.entries(inventoryQueryNames).map(([key, queryName]) => [
        key,
        normalizeManagementInventoryPage(query[queryName])
    ])
) as Record<InventoryKey, number>;

const inventoryOffsetFor = (pages: Record<InventoryKey, number>, key: InventoryKey) =>
    managementInventoryOffset(pages[key]);

const inventoryLimit = managementInventoryPageSize + 1;

/** Loads one bounded, global page for every shared-content management type. */
const loadGlobalManagementInventory = async (req: Request) => {
    const requestedPages = requestedInventoryPages(req.query);
    const [artistRecords, albumRecords, audioTrackRecords, pageRecords, carouselRecords, collectionRecords] = await Promise.all([
        Artist.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'artists')),
        Album.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'albums')),
        AudioTrack.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'audioTracks')),
        Page.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'pages')),
        Carousel.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'carousels')),
        ContentCollection.fetchAll(inventoryLimit, inventoryOffsetFor(requestedPages, 'contentCollections'))
    ]);
    const artists = toManagementInventoryPage(artistRecords, requestedPages.artists);
    const albums = toManagementInventoryPage(albumRecords, requestedPages.albums);
    const audioTracks = toManagementInventoryPage(audioTrackRecords, requestedPages.audioTracks);
    const pages = toManagementInventoryPage(pageRecords, requestedPages.pages);
    const carousels = toManagementInventoryPage(carouselRecords, requestedPages.carousels);
    const contentCollections = toManagementInventoryPage(collectionRecords, requestedPages.contentCollections);
    const withoutItems = ({ page, hasPrevious, hasNext }: ManagementInventoryPage<unknown>) => ({
        page,
        hasPrevious,
        hasNext
    });

    return {
        catalogArtists: artists.items,
        catalogAlbums: albums.items,
        catalogAudioTracks: audioTracks.items,
        catalogPages: pages.items,
        catalogCarousels: carousels.items,
        catalogContentCollections: contentCollections.items,
        inventoryPagination: {
            artists: withoutItems(artists),
            albums: withoutItems(albums),
            audioTracks: withoutItems(audioTracks),
            pages: withoutItems(pages),
            carousels: withoutItems(carousels),
            contentCollections: withoutItems(contentCollections)
        }
    };
};

const renderInventoryPagination = (
    key: InventoryKey,
    label: string,
    pagination: InventoryPagination
) => {
    const state = pagination[key];
    if (!state.hasPrevious && !state.hasNext) return '';
    const linkFor = (page: number) => {
        const query = new URLSearchParams();
        for (const [inventoryKey, queryName] of Object.entries(inventoryQueryNames)) {
            const selectedPage = inventoryKey === key ? page : pagination[inventoryKey as InventoryKey].page;
            if (selectedPage > 1) query.set(queryName, String(selectedPage));
        }
        const serialized = query.toString();
        return `/content/manage${serialized ? `?${serialized}` : ''}#inventory-${key}`;
    };
    const previous = state.hasPrevious
        ? `<a class="button button--secondary" href="${linkFor(state.page - 1)}">Previous ${escapeHtml(label)}</a>`
        : '';
    const next = state.hasNext
        ? `<a class="button button--secondary" href="${linkFor(state.page + 1)}">Next ${escapeHtml(label)}</a>`
        : '';
    return `<nav class="inventory-pagination" aria-label="${escapeHtml(label)} pages">${previous}<span>Page ${state.page}</span>${next}</nav>`;
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
    return `Not loaded on this inventory page (<code>${escapeHtml(id)}</code>)`;
};

const renderNestedList = (items: string[]) => {
    return items.length > 0
        ? `<ul class="linked-content">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`
        : '<p class="empty-linked-content">None linked</p>';
};

const renderManagePage = (params: {
    userEmail: string;
    isAdmin?: boolean;
    message?: string;
    searchQuery?: string;
    selectedUploadTrackId?: string;
    artists?: any[];
    albums?: any[];
    audioTracks?: any[];
    catalogArtists?: any[];
    catalogAlbums?: any[];
    catalogAudioTracks?: any[];
    catalogPages?: any[];
    catalogCarousels?: any[];
    catalogContentCollections?: any[];
    inventoryPagination?: InventoryPagination;
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

    const catalogArtists = params.catalogArtists ?? [];
    const catalogAlbums = params.catalogAlbums ?? [];
    const catalogAudioTracks = params.catalogAudioTracks ?? [];
    const catalogPages = params.catalogPages ?? [];
    const catalogCarousels = params.catalogCarousels ?? [];
    const catalogContentCollections = params.catalogContentCollections ?? [];
    const inventoryPagination = params.inventoryPagination;
    const paginationFor = (key: InventoryKey, label: string) => inventoryPagination
        ? renderInventoryPagination(key, label, inventoryPagination)
        : '';
    const s3StorageSummary = params.s3StorageSummary ?? null;
    const s3StorageSummaryError = params.s3StorageSummaryError ?? '';
    const s3StorageBlock = s3StorageSummary
        ? `<div class="storage-summary"><strong>S3 storage</strong><span>${formatStorageSize(s3StorageSummary.totalBytes)} across ${s3StorageSummary.objectCount} object${s3StorageSummary.objectCount === 1 ? '' : 's'}</span><span>Estimated storage: $${s3StorageSummary.estimatedMonthlyStorageCost.toFixed(2)}/month</span><small>Storage-only estimate at $${s3StorageSummary.storageCostPerGbMonth.toFixed(3)}/GB-month; excludes requests, transfer, and taxes.</small></div>`
        : `<div class="storage-summary"><strong>S3 storage</strong><span>Usage unavailable${s3StorageSummaryError ? ` (${escapeHtml(s3StorageSummaryError)})` : ''}. Confirm the app has S3 ListBucket permission and that S3_BUCKET_NAME/AWS_REGION match the bucket.</span></div>`;
    const pageOptions = catalogPages.map((page) => {
        const slug = String(page.slug ?? '');
        return `<option value="${escapeHtml(slug)}">${escapeHtml(String(page.title ?? slug))} (${escapeHtml(slug)})</option>`;
    }).join('');
    const carouselOptions = catalogCarousels.map((carousel) => {
        const id = contentId(carousel);
        const dynamicLabel = carousel.mode === 'artist'
            ? ' · Artist'
            : carousel.mode === 'personalized' ? ' · Personalized' : '';
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled carousel'))}${dynamicLabel}</option>`;
    }).join('');
    const manualCarouselOptions = catalogCarousels
        .filter((carousel) => carousel.mode === 'manual' || !carousel.mode)
        .map((carousel) => {
            const id = contentId(carousel);
            return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled carousel'))}</option>`;
        }).join('');
    const artistCarouselOptions = catalogCarousels
        .filter((carousel) => carousel.mode === 'artist')
        .map((carousel) => {
            const id = contentId(carousel);
            return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled artist carousel'))}</option>`;
        }).join('');
    const personalizedCarouselOptions = catalogCarousels
        .filter((carousel) => carousel.mode === 'personalized')
        .map((carousel) => {
            const id = contentId(carousel);
            return `<option value="${escapeHtml(id)}">${escapeHtml(String(carousel.name ?? 'Untitled personalized carousel'))}</option>`;
        }).join('');
    const artistOptions = catalogArtists.map((artist) => {
        const id = contentId(artist);
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(artist.name ?? 'Untitled artist'))}</option>`;
    }).join('');
    const albumOptions = catalogAlbums.map((album) => {
        const id = contentId(album);
        return `<option value="${escapeHtml(id)}">${escapeHtml(String(album.title ?? 'Untitled album'))}</option>`;
    }).join('');
    const compositionData = JSON.stringify({
        pages: catalogPages.map((page) => ({
            slug: String(page.slug ?? ''),
            title: String(page.title ?? page.slug ?? ''),
            items: Array.isArray(page.items) ? page.items.map((item: any) => ({
                itemType: String(item.itemType ?? (item.carouselId ? 'carousel' : 'unknown')),
                carouselId: String(item.carouselId ?? ''),
                collectionId: String(item.collectionId ?? ''),
                order: Number(item.order ?? 0)
            })) : []
        })),
        carousels: catalogCarousels.map((carousel) => ({
            id: contentId(carousel),
            name: String(carousel.name ?? 'Untitled carousel'),
            mode: carousel.mode === 'artist' ? 'artist' : carousel.mode === 'personalized' ? 'personalized' : 'manual',
            artistConfig: carousel.artistConfig ?? null,
            personalizedConfig: carousel.personalizedConfig ?? null,
            items: Array.isArray(carousel.items) ? carousel.items.map((item: any) => ({ contentId: String(item.contentId ?? ''), contentType: String(item.contentType ?? 'Content'), order: Number(item.order ?? 0) })) : []
        })),
        contentCollections: catalogContentCollections.map((collection) => ({
            id: contentId(collection),
            name: String(collection.name ?? 'Untitled collection'),
            presentation: String(collection.presentation ?? ''),
            mode: String(collection.mode ?? 'manual'),
            dynamicSource: collection.dynamicSource ? String(collection.dynamicSource) : null
        })),
        albums: catalogAlbums.map((album) => ({ id: contentId(album), title: String(album.title ?? '') })),
        audioTracks: catalogAudioTracks.map((track) => ({ id: contentId(track), title: String(track.title ?? '') }))
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
    .page-item-list { display: grid; gap: 8px; margin-top: 10px; }
    .page-item-list > li { padding-left: 4px; }
    .page-item-list .item-meta { display: inline-flex; margin-left: 6px; }
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
    .inventory-pagination { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 16px; }
    .inventory-pagination span { color: var(--muted); font-size: 14px; font-weight: 700; }
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
      <a class="button" href="/content/manage/audio-tracks">Audio Tracks</a>
      ${params.isAdmin ? '<a class="button button--secondary" href="/admin/audio-storage/reconciliation">Audit Audio Storage</a><a class="button button--secondary" href="/admin/image-storage/reconciliation">Audit Image Storage</a>' : ''}
      <a class="button button--secondary" href="/">Home</a>
      <form method="POST" action="/auth/logout-web"><button class="button--secondary" type="submit">Log out</button></form>
    </div>
  </header>
  ${messageBlock}
  <section class="card upload-results" id="bulk-upload-results" role="status" aria-live="polite" hidden>
    <h2>Upload results</h2>
    <div class="upload-results__grid"></div>
  </section>
  ${s3StorageBlock}
  <nav class="manager-nav" aria-label="Content Manager sections">
    <a href="#search">Search</a>
    <a href="#catalog-content">Catalog</a>
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
    ${renderSectionList('Artists', artists, (item) => renderReferencedItem(item, String(item.name ?? ''), 'artist'))}
    ${renderSectionList('Albums', albums, (item) => renderReferencedItem(item, String(item.title ?? ''), 'album'))}
    ${renderSectionList('Audio Tracks', audioTracks, (item) => renderReferencedItem(item, String(item.title ?? ''), 'audioTrack'))}
  </div>

  <div class="section-heading" id="catalog-content"><div><p class="eyebrow">Global inventory</p><h2>Catalog Content</h2></div></div>
  <div class="card">
    <section id="inventory-artists">
    <h3>Artists</h3>
    <div class="content-hierarchy">
      ${catalogArtists.length > 0 ? catalogArtists.map((artist) => {
          const linkedAlbumIds = uniqueStrings(Array.isArray(artist.albumIds) ? artist.albumIds.map(String) : []);
          const albumsById = new Map(catalogAlbums.map((album) => [contentId(album), album]));
          const linkedAlbums = linkedAlbumIds.map((albumId) => {
              const album = albumsById.get(albumId);
              if (!album) return renderMissingReference(albumId);

              return renderReferencedItem(album, String(album.title ?? ''), 'album');
          });

          return `<div class="hierarchy-item"><strong>${renderReferencedItem(artist, String(artist.name ?? ''), 'artist')}</strong><span>${linkedAlbumIds.length} linked album${linkedAlbumIds.length === 1 ? '' : 's'}</span>${renderNestedList(linkedAlbums)}</div>`;
      }).join('') : '<p class="empty-linked-content">No artists yet.</p>'}
    </div>
    ${paginationFor('artists', 'Artists')}
    </section>

    <section id="inventory-albums">
    <h3>Albums</h3>
    <div class="content-hierarchy">
      ${catalogAlbums.length > 0 ? catalogAlbums.map((album) => {
          const albumId = contentId(album);
          const linkedTrackIds = uniqueStrings([
              ...(Array.isArray(album.audioTrackIds) ? album.audioTrackIds.map(String) : []),
              ...catalogAudioTracks.filter((track) => String(track.albumId ?? '') === albumId).map(contentId)
          ]);
          const tracksById = new Map(catalogAudioTracks.map((track) => [contentId(track), track]));
          const linkedTracks = linkedTrackIds.map((trackId) => {
              const track = tracksById.get(trackId);
              if (!track) return renderMissingReference(trackId);

              return `<label class="track-selection"><input type="checkbox" name="audioTrackIds" value="${escapeHtml(trackId)}" aria-label="Select ${escapeHtml(String(track.title ?? 'audio track'))}" />${renderReferencedItem(track, String(track.title ?? ''), 'audioTrack')}</label>`;
          });
          const selectableTrackCount = linkedTrackIds.filter((trackId) => tracksById.has(trackId)).length;

          return `<form class="hierarchy-item" data-batch-track-delete method="POST" action="/content/manage/album/delete-audio-tracks"><input type="hidden" name="albumId" value="${escapeHtml(albumId)}" /><strong>${renderReferencedItem(album, String(album.title ?? ''), 'album')}</strong><span>${linkedTrackIds.length} linked track${linkedTrackIds.length === 1 ? '' : 's'}</span>${renderNestedList(linkedTracks)}${selectableTrackCount > 0 ? '<div class="batch-track-actions"><button class="select-all-tracks button--secondary" type="button">Select all</button><button class="batch-delete-button" data-danger type="submit" disabled>Delete selected tracks</button></div>' : ''}</form>`;
      }).join('') : '<p class="empty-linked-content">No albums yet.</p>'}
    </div>
    ${paginationFor('albums', 'Albums')}
    </section>

        <section id="inventory-audioTracks">
          <h3>Audio Tracks</h3>
          <div class="content-hierarchy">
            ${catalogAudioTracks.length > 0 ? catalogAudioTracks.map((track) => `<div class="hierarchy-item"><strong>${renderReferencedItem(track, String(track.title ?? ''), 'audioTrack')}</strong><span>${escapeHtml(String(track.uploadStatus ?? 'legacy'))}</span></div>`).join('') : '<p class="empty-linked-content">No audio tracks yet.</p>'}
          </div>
          ${paginationFor('audioTracks', 'Audio Tracks')}
        </section>

        <section id="inventory-pages">
          ${renderPageItemsHierarchy(catalogPages, catalogCarousels, catalogContentCollections)}
          ${paginationFor('pages', 'Pages')}
        </section>

        <section id="inventory-carousels">
        <h3>Carousels</h3>
        <div class="content-hierarchy">
          ${catalogCarousels.length > 0 ? catalogCarousels.map((carousel) => {
              const items = Array.isArray(carousel.items) ? [...carousel.items].sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0)) : [];
              const isArtistCarousel = carousel.mode === 'artist';
              const isPersonalizedCarousel = carousel.mode === 'personalized';
              const artistName = isArtistCarousel
                  ? String(catalogArtists.find((artist) => contentId(artist) === String(carousel.artistConfig?.artistId ?? ''))?.name ?? 'Artist not loaded on this inventory page')
                  : '';
              const albumsById = new Map(catalogAlbums.map((album) => [contentId(album), album]));
              const tracksById = new Map(catalogAudioTracks.map((track) => [contentId(track), track]));
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

              const dynamicSummary = isArtistCarousel
                  ? `<span class="pill">Dynamic</span> <span>${escapeHtml(artistName)} · ${carousel.artistConfig?.contentType === 'album' ? 'Albums' : 'Audio tracks'}</span>`
                  : isPersonalizedCarousel
                      ? `<span class="pill">Personalized</span> <span>${carousel.personalizedConfig?.source === 'recentlyPlayed' ? 'Recently Played' : 'Recently Saved'} · Mixed content</span>`
                  : '<span class="pill pill--muted">Manual</span>';
              return `<div class="hierarchy-item"><strong>${renderReferencedItem(carousel, String(carousel.name ?? ''))}</strong><div class="item-meta">${dynamicSummary}<span>${items.length} item${items.length === 1 ? '' : 's'}</span></div>${renderNestedList(carouselItems)}</div>`;
          }).join('') : '<p class="empty-linked-content">No carousels yet.</p>'}
        </div>
        ${paginationFor('carousels', 'Carousels')}
        </section>

        <section id="inventory-contentCollections">
          <h3>Content Collections</h3>
          <div class="content-hierarchy">
            ${catalogContentCollections.length > 0 ? catalogContentCollections.map((collection) => {
                const presentation = String(collection.presentation ?? 'collection');
                const mode = collection.mode === 'dynamic' ? 'Dynamic' : 'Manual';
                return `<div class="hierarchy-item"><strong>${renderReferencedItem(collection, String(collection.name ?? 'Untitled collection'))}</strong><span>${escapeHtml(presentation)} · ${mode}</span></div>`;
            }).join('') : '<p class="empty-linked-content">No content collections yet.</p>'}
          </div>
          ${paginationFor('contentCollections', 'Content Collections')}
        </section>
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
                <select class="carousel-mode" name="mode" required><option value="manual">Manual carousel</option><option value="artist">Artist carousel</option><option value="personalized">Personalized carousel</option></select>
                <div class="artist-carousel-config stack" hidden>
                    <select name="artistId"><option value="" disabled selected>Select artist</option>${artistOptions}</select>
                    <select name="artistContentType"><option value="album">Albums</option><option value="audioTrack">Audio tracks</option></select>
                    <select name="artistSort"><option value="releaseDateDesc">Newest releases first</option><option value="titleAsc">Title A–Z</option></select>
                    <input name="artistLimit" type="number" min="1" max="100" value="20" />
                    <p class="drag-help">Items are generated automatically from the selected artist and cannot be manually reordered.</p>
                </div>
                <div class="personalized-carousel-config stack" hidden>
                    <select name="personalizedSource"><option value="recentlySaved">Recently Saved</option><option value="recentlyPlayed">Recently Played</option></select>
                    <input name="personalizedLimit" type="number" min="1" max="20" value="20" />
                    <p class="drag-help">Albums and audio tracks are mixed automatically for the signed-in viewer.</p>
                </div>
                <button type="submit">Create Carousel</button>
            </form>

            <h3>Update Artist Carousel</h3>
            <form class="update-artist-carousel" method="POST" action="/content/manage/composition/carousel/update-artist">
                <select class="artist-carousel-selector" name="carouselId" required><option value="" disabled selected>Select artist carousel</option>${artistCarouselOptions}</select>
                <input name="name" placeholder="Carousel name" required />
                <select name="artistId" required><option value="" disabled selected>Select artist</option>${artistOptions}</select>
                <select name="artistContentType" required><option value="album">Albums</option><option value="audioTrack">Audio tracks</option></select>
                <select name="artistSort" required><option value="releaseDateDesc">Newest releases first</option><option value="titleAsc">Title A–Z</option></select>
                <input name="artistLimit" type="number" min="1" max="100" value="20" required />
                <button type="submit">Update Artist Carousel</button>
            </form>

            <h3>Update Personalized Carousel</h3>
            <form class="update-personalized-carousel" method="POST" action="/content/manage/composition/carousel/update-personalized">
                <select class="personalized-carousel-selector" name="carouselId" required><option value="" disabled selected>Select personalized carousel</option>${personalizedCarouselOptions}</select>
                <input name="name" placeholder="Carousel name" required />
                <select name="personalizedSource" required><option value="recentlySaved">Recently Saved</option><option value="recentlyPlayed">Recently Played</option></select>
                <input name="personalizedLimit" type="number" min="1" max="20" value="20" required />
                <button type="submit">Update Personalized Carousel</button>
            </form>

            <h3>Rename Manual Carousel</h3>
            <form class="rename-manual-carousel" method="POST" action="/content/manage/composition/carousel/rename-manual">
                <select class="manual-carousel-selector" name="carouselId" required><option value="" disabled selected>Select manual carousel</option>${manualCarouselOptions}</select>
                <input name="name" placeholder="New carousel name" required />
                <button type="submit">Rename Carousel</button>
            </form>

            <h3>Add Item to Carousel</h3>
            <form method="POST" action="/content/manage/composition/carousel/add-item">
                <select name="carouselId" required><option value="" disabled selected>Select manual carousel</option>${manualCarouselOptions}</select>
                <select name="contentType" required><option value="" disabled selected>Select content type</option><option value="post">Post</option><option value="album">Album</option><option value="audioTrack">Audio Track</option></select>
                <input name="contentId" placeholder="Content ID" required />
                <button type="submit">Add Carousel Item</button>
            </form>

            <h3>Reorder Carousel Item</h3>
            <form class="drag-reorder" data-kind="carousel" method="POST" action="/content/manage/composition/carousel/reorder-item">
                <select class="reorder-selector" name="carouselId" required><option value="" disabled selected>Select manual carousel</option>${manualCarouselOptions}</select>
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
                <select class="move-source-carousel" name="sourceCarouselId" required><option value="" disabled selected>Select source carousel</option>${manualCarouselOptions}</select>
                <p class="drag-help">Load the source through Carousel pagination, then select the items to move. They keep their order and are added to the destination.</p>
                <ul class="move-item-list" aria-live="polite"><li class="empty-linked-content">Choose a source carousel to see its items.</li></ul>
                <input class="move-target-carousel" name="targetCarouselId" list="move-target-carousel-options" placeholder="Destination carousel ID" required />
                <datalist id="move-target-carousel-options">${manualCarouselOptions}</datalist>
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

    <div id="composition-data" hidden>${escapeHtml(compositionData)}</div>

  <div class="section-heading" id="create"><div><p class="eyebrow">New records</p><h2>Create</h2></div></div>
  <div class="grid">
    <div class="card">
      <h3>Create Artist</h3>
      <form method="POST" action="/content/manage/artist/create" enctype="multipart/form-data">
        <input name="name" placeholder="Name" required />
        <input name="birthDate" type="date" />
        <input name="bio" placeholder="Bio" />
        <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
        <input name="albumIds" placeholder="Album IDs (comma separated)" />
        <button type="submit">Create Artist</button>
      </form>
    </div>

    <div class="card">
      <h3>Create Album</h3>
      <form method="POST" action="/content/manage/album/create" enctype="multipart/form-data">
        <input name="title" placeholder="Title" required />
        <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
        <input name="audioTrackIds" placeholder="Audio Track IDs (comma separated)" />
        <input name="releaseDate" type="date" />
        <button type="submit">Create Album</button>
      </form>
    </div>

    <div class="card">
      <h3>Create and Upload Audio Track</h3>
      <form method="POST" action="/content/manage/audioTrack/create" enctype="multipart/form-data">
        <input name="title" placeholder="Title" required />
        <select name="artistId" required><option value="" disabled selected>Select artist</option>${artistOptions}</select>
        <input name="genres" placeholder="Genres (comma separated)" />
        <select name="albumId"><option value="">No album</option>${albumOptions}</select>
        <input name="releaseDate" type="date" />
        <input name="duration" placeholder="Duration (e.g. 03:30)" />
        <input name="formatType" placeholder="Format type (e.g. MP3)" />
        <input name="formatBitrate" placeholder="Bitrate (e.g. 320)" />
        <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
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
            <p>Adds artistId to track.artistIds. Tracks are the source of truth for artist relationships.</p>
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
      <form method="POST" action="/content/manage/artist/update" enctype="multipart/form-data">
                <input name="artistId" value="${prefillArtistId}" placeholder="Artist ID" required />
                <input name="name" value="${escapeHtml(String(prefillArtist?.name ?? ''))}" placeholder="New Name (optional)" />
                <input name="bio" value="${escapeHtml(String(prefillArtist?.bio ?? ''))}" placeholder="New Bio (optional)" />
                <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
                <input name="albumIds" value="${escapeHtml(toCsvInput(prefillArtist?.albumIds))}" placeholder="Album IDs (comma separated)" />
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
      <form method="POST" action="/content/manage/album/update" enctype="multipart/form-data">
                <input name="albumId" value="${prefillAlbumId}" placeholder="Album ID" required />
                <input name="title" value="${escapeHtml(String(prefillAlbum?.title ?? ''))}" placeholder="New Title (optional)" />
                <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
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
      <form method="POST" action="/content/manage/audioTrack/update" enctype="multipart/form-data">
                <input name="audioTrackId" value="${prefillAudioTrackId}" placeholder="Audio Track ID" required />
                <input name="title" value="${escapeHtml(String(prefillAudioTrack?.title ?? ''))}" placeholder="New Title (optional)" />
                <input type="file" name="coverArtFile" accept="image/jpeg,image/png,image/webp" />
                <label><input type="checkbox" name="removeCoverArt" value="true" /> Remove current cover art</label>
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
                <select name="artistId" required><option value="" disabled selected>Select artist</option>${artistOptions}</select>
                <select name="albumId"><option value="">No album</option>${albumOptions}</select>
                <input type="file" name="audioFiles" accept="audio/*" multiple required />
                <button type="submit">Create and Upload Audio Files</button>
                <div id="bulk-upload-status" role="status" aria-live="polite" hidden>
                    <progress id="bulk-upload-progress" max="100" value="0">0%</progress>
                    <span id="bulk-upload-progress-label">0%</span>
                </div>
            </form>
            <hr />
            <h3>Upload Audio File</h3>
            <form method="POST" action="/content/manage/audioTrack/upload" enctype="multipart/form-data">
                <input name="audioTrackId" value="${selectedUploadTrackId}" placeholder="Audio Track ID" required />
                <input type="file" name="audioFile" accept="audio/*" required />
                <button type="submit">Upload File to S3</button>
            </form>
    </div>
  </div>
  </main>
  <script src="/assets/content-manager.js"></script>
</body>
</html>`;
};

const getContentProvenanceId = (doc: any) => {
    return String(doc?.createdBy ?? '');
};

const redirectWithMessage = (res: Response, message: string) => {
    res.redirect(`/content/manage?message=${encodeURIComponent(message)}`);
};

/** Keeps controller-level Content Manager access admin-only if route guards are bypassed. */
const rejectNonAdminManagerRequest = (req: AuthenticatedRequest, res: Response) => {
    if (req.auth?.role === 'admin') return false;
    res.status(403).type('text/plain').send('Administrator access is required.');
    return true;
};

const respondToUploadError = (req: Request, res: Response, message: string, status: number = 400) => {
    if (req.get('X-Requested-With') === 'XMLHttpRequest') {
        return res.status(status).json({ message });
    }
    return redirectWithMessage(res, message);
};

export const renderAudioTracksPageForWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage%2Faudio-tracks');
        }
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const page = normalizeManagementInventoryPage(req.query.page);
        const records = await AudioTrack.fetchAll(
            inventoryLimit,
            managementInventoryOffset(page)
        );
        const tracks = toManagementInventoryPage(records, page);
        return res.status(200).send(renderAudioTracksPage(authReq.auth.email, tracks.items, {
            page: tracks.page,
            hasPrevious: tracks.hasPrevious,
            hasNext: tracks.hasNext
        }));
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const [inventory, s3StorageSummaryResult] = await Promise.all([
            loadGlobalManagementInventory(req),
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
                    if (artist) {
                        prefillArtist = artist;
                        prefillArtistId = prefillId;
                    } else if (!message) {
                        message = 'Unable to load artist for this ID.';
                    }
                }

                if (prefillType === 'album') {
                    const album = await Album.findById(prefillId);
                    if (album) {
                        prefillAlbum = album;
                        prefillAlbumId = prefillId;
                    } else if (!message) {
                        message = 'Unable to load album for this ID.';
                    }
                }

                if (prefillType === 'audioTrack') {
                    const track = await AudioTrack.findById(prefillId);
                    if (track) {
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
            isAdmin: authReq.auth.role === 'admin',
            message,
            selectedUploadTrackId,
            ...inventory,
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const rawQuery = boundedSearchQuery(req.query.q);
        const selectedUploadTrackId = String(req.query.uploadAudioTrackId ?? '');
        const limit = boundedLimit(req.query.limit, 10, 50);

        const [artists, albums, audioTracks, inventory, s3StorageSummaryResult] = await Promise.all([
            rawQuery ? Artist.searchByName(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? Album.searchByTitle(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? AudioTrack.searchByTitle(rawQuery, limit) : Promise.resolve([]),
            loadGlobalManagementInventory(req),
            loadS3StorageSummary()
        ]);

        return res.status(200).send(renderManagePage({
            userEmail: authReq.auth.email,
            isAdmin: authReq.auth.role === 'admin',
            searchQuery: rawQuery,
            selectedUploadTrackId,
            artists,
            albums,
            audioTracks,
            ...inventory,
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumIds = parseCsv(String(req.body.albumIds ?? ''));
        const albumValidation = await validateContentReferences('album', albumIds);
        if (!albumValidation.valid) {
            return redirectWithMessage(res, albumValidation.message!);
        }

        const artist = new Artist(
            String(req.body.name ?? ''),
            parseDateInput(String(req.body.birthDate ?? '')),
            String(req.body.bio ?? ''),
            String(req.body.coverArtUrl ?? ''),
            albumValidation.ids as [string],
            authReq.auth.userId
        );

        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const result = await artist.save();
        const artistId = result.insertedId.toHexString();
        try {
            if (coverArtFile) {
                const coverArt = await uploadCoverArt(
                    'artist',
                    artistId,
                    coverArtFile,
                    authReq.auth.userId
                );
                await Artist.updateById(artistId, {
                    coverArtId: coverArt.imageId,
                    coverArtUrl: coverArt.coverArtUrl
                });
            }
        } catch (error) {
            await Artist.deleteById(artistId).catch(() => undefined);
            throw error;
        }
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        const artistValidation = await validateContentReferences('artist', [artistId]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        if (req.body.name) updatePayload.name = String(req.body.name);
        if (req.body.bio) updatePayload.bio = String(req.body.bio);
        if (req.body.albumIds) {
            const validation = await validateContentReferences(
                'album',
                parseCsv(String(req.body.albumIds))
            );
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
            updatePayload.albumIds = validation.ids;
        }
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'artist',
                artistId,
                coverArtFile,
                authReq.auth.userId
            );
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else if (req.body.removeCoverArt === 'true') {
            await deleteCoverArt(artist.coverArtId);
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }
        await Artist.updateById(artistId, updatePayload);
        let cleanupPending = false;
        if (replacementCoverArtId && artist.coverArtId && artist.coverArtId !== replacementCoverArtId) {
            await deleteCoverArt(artist.coverArtId).catch((error) => {
                cleanupPending = true;
                console.log(`Unable to delete replaced artist cover art ${artist.coverArtId}:`, error);
            });
        }
        return redirectWithMessage(
            res,
            cleanupPending
                ? 'Artist updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'Artist updated successfully.'
        );
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const artistId = String(req.body.artistId ?? '').trim();
        const artistValidation = await validateContentReferences('artist', [artistId]);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        await deleteCoverArt(artist.coverArtId);
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackIds = parseCsv(String(req.body.audioTrackIds ?? ''));
        const trackValidation = await validateContentReferences('audioTrack', audioTrackIds);
        if (!trackValidation.valid) {
            return redirectWithMessage(res, trackValidation.message!);
        }

        const album = new Album(
            String(req.body.title ?? ''),
            String(req.body.coverArtUrl ?? ''),
            trackValidation.ids as [string],
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId
        );

        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) await validateCoverArtFile(coverArtFile);
        const result = await album.save();
        const albumId = result.insertedId.toHexString();
        try {
            if (coverArtFile) {
                const coverArt = await uploadCoverArt(
                    'album',
                    albumId,
                    coverArtFile,
                    authReq.auth.userId
                );
                await Album.updateById(albumId, {
                    coverArtId: coverArt.imageId,
                    coverArtUrl: coverArt.coverArtUrl
                });
            }
        } catch (error) {
            await Album.deleteById(albumId).catch(() => undefined);
            throw error;
        }
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const albumValidation = await validateContentReferences('album', [albumId]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.audioTrackIds) {
            const validation = await validateContentReferences(
                'audioTrack',
                parseCsv(String(req.body.audioTrackIds))
            );
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
            updatePayload.audioTrackIds = validation.ids;
        }
        if (req.body.releaseDate) updatePayload.releaseDate = parseDateInput(String(req.body.releaseDate));
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'album',
                albumId,
                coverArtFile,
                authReq.auth.userId
            );
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else if (req.body.removeCoverArt === 'true') {
            await deleteCoverArt(album.coverArtId);
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }

        await Album.updateById(albumId, updatePayload);
        let cleanupPending = false;
        if (replacementCoverArtId && album.coverArtId && album.coverArtId !== replacementCoverArtId) {
            await deleteCoverArt(album.coverArtId).catch((error) => {
                cleanupPending = true;
                console.log(`Unable to delete replaced album cover art ${album.coverArtId}:`, error);
            });
        }
        return redirectWithMessage(
            res,
            cleanupPending
                ? 'Album updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'Album updated successfully.'
        );
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const albumValidation = await validateContentReferences('album', [albumId]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        await deleteCoverArt(album.coverArtId);
        await cleanupDeletedContentReferences('album', albumId);
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const uploadFile = getUploadedFile(req, 'audioFile');
        if (!uploadFile) {
            return redirectWithMessage(res, 'An audio file is required to create an audio track.');
        }

        const artistId = String(req.body.artistId ?? '').trim();
        const artistValidation = await validateContentReferences('artist', [artistId]);
        if (!artistId || !artistValidation.valid) {
            return redirectWithMessage(
                res,
                artistValidation.message ?? 'Select an existing artist.'
            );
        }

        const albumId = String(req.body.albumId ?? '').trim();
        let album: any | null = null;
        if (albumId) {
            const albumValidation = await validateContentReferences('album', [albumId]);
            if (!albumValidation.valid) {
                return redirectWithMessage(res, albumValidation.message!);
            }
            album = await Album.findById(albumId);
        }

        const formatType = String(req.body.formatType ?? 'MP3');
        const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
        const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;
        const audioTrackObjectId = new ObjectId();
        const audioTrackId = audioTrackObjectId.toHexString();
        const originalFileName = normalizeUtf8Text(uploadFile.originalname);

        const track = new AudioTrack(
            normalizeUtf8Text(String(req.body.title ?? '')),
            [artistId],
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

        await track.save();
        await uploadAudioObject(audioTrackId, uploadFile, getContentProvenanceId(track) || authReq.auth.userId, getRequestAbortSignal(req));
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'audioTrack',
                audioTrackId,
                coverArtFile,
                authReq.auth.userId
            );
            await AudioTrack.updateById(audioTrackId, {
                coverArtId: coverArt.imageId,
                coverArtUrl: coverArt.coverArtUrl
            });
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const trackValidation = await validateContentReferences('audioTrack', [audioTrackId]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        const updatePayload: Record<string, unknown> = {};
        const coverArtFile = getUploadedFile(req, 'coverArtFile');
        let replacementCoverArtId: string | undefined;
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.artistIds) {
            const validation = await validateContentReferences(
                'artist',
                parseCsv(String(req.body.artistIds))
            );
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
            updatePayload.artistIds = validation.ids;
        }
        if (req.body.genres) updatePayload.genres = parseCsv(String(req.body.genres));
        if (req.body.albumId) {
            const validation = await validateContentReferences(
                'album',
                [String(req.body.albumId)]
            );
            if (!validation.valid) return redirectWithMessage(res, validation.message!);
            updatePayload.albumId = validation.ids[0];
        }
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
        if (coverArtFile) {
            const coverArt = await uploadCoverArt(
                'audioTrack',
                audioTrackId,
                coverArtFile,
                authReq.auth.userId
            );
            replacementCoverArtId = coverArt.imageId;
            updatePayload.coverArtId = coverArt.imageId;
            updatePayload.coverArtUrl = coverArt.coverArtUrl;
        } else if (req.body.removeCoverArt === 'true') {
            await deleteCoverArt(track.coverArtId);
            updatePayload.coverArtId = null;
            updatePayload.coverArtUrl = '';
        }

        await AudioTrack.updateById(audioTrackId, updatePayload);
        let cleanupPending = false;
        if (replacementCoverArtId && track.coverArtId && track.coverArtId !== replacementCoverArtId) {
            await deleteCoverArt(track.coverArtId).catch((error) => {
                cleanupPending = true;
                console.log(`Unable to delete replaced audio-track cover art ${track.coverArtId}:`, error);
            });
        }
        return redirectWithMessage(
            res,
            cleanupPending
                ? 'Audio track updated successfully. Previous cover-art cleanup will need to be retried.'
                : 'Audio track updated successfully.'
        );
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const trackValidation = await validateContentReferences('audioTrack', [audioTrackId]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        try {
            await deleteAudioObjectAndTrack(audioTrackId);
            return redirectWithMessage(res, 'Audio track deleted successfully.');
        } catch (s3Error) {
            console.log('Audio track deletion failed for audioTrackId:', audioTrackId, s3Error);
            return redirectWithMessage(res, 'The uploaded file could not be deleted. Track metadata was retained for reconciliation.');
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const selectedTrackIds = uniqueStrings(
            Array.isArray(req.body.audioTrackIds)
                ? req.body.audioTrackIds.map(String)
                : req.body.audioTrackIds ? [String(req.body.audioTrackIds)] : []
        );
        if (!albumId || selectedTrackIds.length === 0) {
            return redirectWithMessage(res, 'Select at least one audio track to delete.');
        }
        const maximumBatchDeletes = 100;
        if (selectedTrackIds.length > maximumBatchDeletes) {
            return redirectWithMessage(res, `Delete no more than ${maximumBatchDeletes} audio tracks at once.`);
        }

        const [albumValidation, trackValidation] = await Promise.all([
            validateContentReferences('album', [albumId]),
            validateContentReferences('audioTrack', selectedTrackIds)
        ]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);

        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        const tracks = await Promise.all(selectedTrackIds.map((trackId) => AudioTrack.findById(trackId)));
        const associatedTrackIds = new Set(uniqueStrings([
            ...(Array.isArray((album as any).audioTrackIds) ? (album as any).audioTrackIds.map(String) : []),
            ...tracks.filter(Boolean).filter((track: any) => String(track.albumId ?? '') === albumId).map(contentId)
        ]));
        if (tracks.some((track) => !track) || selectedTrackIds.some((trackId) => !associatedTrackIds.has(trackId))) {
            return redirectWithMessage(res, 'One or more selected tracks do not belong to this album.');
        }
        const deletedTrackIds: string[] = [];
        const failedTrackIds: string[] = [];
        for (const trackId of selectedTrackIds) {
            try {
                await deleteAudioObjectAndTrack(trackId);
                deletedTrackIds.push(trackId);
            } catch (deleteError) {
                console.log(`Unable to delete audio track ${trackId}:`, deleteError);
                failedTrackIds.push(trackId);
            }
        }

        const remainingTrackIds = uniqueStrings(
            (Array.isArray((album as any).audioTrackIds) ? (album as any).audioTrackIds : []).map(String)
        ).filter((trackId) => !deletedTrackIds.includes(trackId));
        await Album.updateById(albumId, { audioTrackIds: remainingTrackIds as [string] });

        if (failedTrackIds.length > 0) {
            return redirectWithMessage(res, `${deletedTrackIds.length} audio track(s) deleted. ${failedTrackIds.length} could not be deleted and remain recorded for reconciliation.`);
        }

        return redirectWithMessage(res, `${deletedTrackIds.length} audio track(s) deleted successfully.`);
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const trackValidation = await validateContentReferences('audioTrack', [audioTrackId]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
        if (!uploadFile) {
            return redirectWithMessage(res, 'Missing audio file.');
        }

        await uploadAudioObject(audioTrackId, uploadFile, getContentProvenanceId(track) || authReq.auth.userId, getRequestAbortSignal(req));

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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const uploadFiles = (req as Request & { files?: Express.Multer.File[] }).files ?? [];
        if (uploadFiles.length === 0) {
            return respondToUploadError(req, res, 'Select at least one audio file to upload.');
        }

        const artistId = String(req.body.artistId ?? '').trim();
        const artistValidation = await validateContentReferences('artist', [artistId]);
        if (!artistId || !artistValidation.valid) {
            return respondToUploadError(
                req,
                res,
                artistValidation.message ?? 'Select an existing artist.'
            );
        }

        const albumId = String(req.body.albumId ?? '').trim();
        let album: any | null = null;
        if (albumId) {
            const albumValidation = await validateContentReferences('album', [albumId]);
            if (!albumValidation.valid) {
                return respondToUploadError(req, res, albumValidation.message!);
            }
            album = await Album.findById(albumId);
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
                metadata = uploadFile.path
                    ? await parseFile(uploadFile.path, {
                        duration: true,
                        skipCovers: true
                    })
                    : await parseBuffer(Uint8Array.from(uploadFile.buffer), {
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
                [artistId],
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
                await track.save();
                await uploadAudioObject(audioTrackId, uploadFile, authReq.auth.userId, getRequestAbortSignal(req));
                uploadedTrackIds.push(audioTrackId);
            } catch (uploadError) {
                console.log(`Unable to upload ${originalFileName}:`, uploadError);
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
        if (req.get('X-Requested-With') === 'XMLHttpRequest') {
            return res.status(uploadedTrackIds.length > 0 ? 200 : 422).json({
                message,
                uploadedCount: uploadedTrackIds.length,
                failureCount: failures.length
            });
        }
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const albumId = String(req.body.albumId ?? '').trim();
        const [trackValidation, albumValidation] = await Promise.all([
            validateContentReferences('audioTrack', [audioTrackId]),
            validateContentReferences('album', [albumId])
        ]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);

        const track = await AudioTrack.findById(audioTrackId);
        const album = await Album.findById(albumId);

        if (!track || !album) {
            return redirectWithMessage(res, 'Track or album not found.');
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const albumId = String(req.body.albumId ?? '').trim();
        const artistId = String(req.body.artistId ?? '').trim();
        const [albumValidation, artistValidation] = await Promise.all([
            validateContentReferences('album', [albumId]),
            validateContentReferences('artist', [artistId])
        ]);
        if (!albumValidation.valid) return redirectWithMessage(res, albumValidation.message!);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);

        const album = await Album.findById(albumId);
        const artist = await Artist.findById(artistId);

        if (!album || !artist) {
            return redirectWithMessage(res, 'Album or artist not found.');
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
        if (rejectNonAdminManagerRequest(authReq, res)) return;

        const audioTrackId = String(req.body.audioTrackId ?? '').trim();
        const artistId = String(req.body.artistId ?? '').trim();
        const [trackValidation, artistValidation] = await Promise.all([
            validateContentReferences('audioTrack', [audioTrackId]),
            validateContentReferences('artist', [artistId])
        ]);
        if (!trackValidation.valid) return redirectWithMessage(res, trackValidation.message!);
        if (!artistValidation.valid) return redirectWithMessage(res, artistValidation.message!);

        const track = await AudioTrack.findById(audioTrackId);
        const artist = await Artist.findById(artistId);

        if (!track || !artist) {
            return redirectWithMessage(res, 'Track or artist not found.');
        }

        const trackArtistIds = uniqueStrings([...(Array.isArray((track as any).artistIds) ? (track as any).artistIds : []), artistId]);
        await AudioTrack.updateById(audioTrackId, { artistIds: trackArtistIds as [string] });

        return redirectWithMessage(res, 'Track linked to artist successfully.');
    } catch (error) {
        return next(error);
    }
};

export const searchContent = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rawQuery = boundedSearchQuery(req.query.q);
        if (!rawQuery) {
            return res.status(400).json({ message: 'Missing required query parameter: q' });
        }

        const limit = boundedLimit(req.query.limit, 10, 50);

        return res.status(200).json(await searchPublicCatalog(rawQuery, limit));
    } catch (error) {
        return next(error);
    }
};
