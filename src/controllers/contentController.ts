import { Request, Response, NextFunction } from 'express';
import { Artist } from '../models/artist';
import { Album } from '../models/album';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';
import { Carousel } from '../models/carousel';
import { Page } from '../models/page';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import { getS3 } from '../app';
import { parseBuffer } from 'music-metadata';

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
        .replace(/[_-]+/g, ' ')
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
        const page: any = await getS3().listObjectsV2({
            Bucket: bucket,
            ContinuationToken: continuationToken
        }).promise();
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
        ? `<p style="padding:10px;background:#eef9ff;border:1px solid #b3e5fc;border-radius:8px;">${escapeHtml(params.message)}</p>`
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
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archtree Content Manager</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 960px; margin: 32px auto; padding: 0 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px; }
    .content-hierarchy { display: grid; gap: 16px; }
    .hierarchy-item { border-bottom: 1px solid #eee; padding-bottom: 12px; }
    .hierarchy-item:last-child { border-bottom: 0; padding-bottom: 0; }
    .hierarchy-item > strong { display: block; }
    .linked-content { margin: 6px 0 0 18px; padding-left: 18px; }
    .empty-linked-content { color: #666; font-size: 14px; margin: 6px 0 0; }
    form { display: grid; gap: 8px; }
    input, select { padding: 8px; font-size: 14px; }
    button { padding: 8px 12px; cursor: pointer; }
    .drag-list { display: grid; gap: 6px; margin: 10px 0; padding: 0; list-style: none; }
    .drag-item { background: #f8f8f8; border: 1px solid #ddd; border-radius: 6px; cursor: grab; padding: 9px; }
    .drag-item.dragging { opacity: .45; }
    .drag-item.drag-over { border-color: #2276d2; }
    .drag-help { color: #666; font-size: 13px; margin: 6px 0; }
    .storage-summary { align-items: baseline; background: #f5f8fc; border: 1px solid #d6e3f5; border-radius: 10px; display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 16px 0; padding: 12px 14px; }
    .storage-summary small { color: #596579; flex-basis: 100%; }
    h2, h3 { margin-bottom: 8px; }
    code { background: #f3f3f3; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Content Manager</h1>
  <p>Signed in as <strong>${escapeHtml(params.userEmail)}</strong></p>
  <p><a href="/">Home</a> | <form style="display:inline;" method="POST" action="/auth/logout-web"><button type="submit">Log out</button></form></p>
  ${messageBlock}
  ${s3StorageBlock}

  <div class="card">
    <h2>Unified Search</h2>
    <form method="GET" action="/content/manage/search">
      <input type="text" name="q" value="${searchQuery}" placeholder="Search artist, album, track" required />
      <button type="submit">Search</button>
    </form>
    ${renderSectionList('Artists', artists, (item) => `${escapeHtml(item.name ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
    ${renderSectionList('Albums', albums, (item) => `${escapeHtml(item.title ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
    ${renderSectionList('Audio Tracks', audioTracks, (item) => `${escapeHtml(item.title ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
  </div>

  <h2>My Content</h2>
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

              return renderReferencedItem(track, String(track.title ?? ''), 'audioTrack');
          });

          return `<div class="hierarchy-item"><strong>${renderReferencedItem(album, String(album.title ?? ''), 'album')}</strong><span>${linkedTrackIds.length} linked track${linkedTrackIds.length === 1 ? '' : 's'}</span>${renderNestedList(linkedTracks)}</div>`;
      }).join('') : '<p class="empty-linked-content">No albums yet.</p>'}
    </div>

    ${renderSectionList('My Audio Tracks', ownedAudioTracks, (item) => {
            const id = escapeHtml(String(item._id ?? ''));
            return `${escapeHtml(item.title ?? '')} (<code>${id}</code>) - <a href="/content/manage?uploadAudioTrackId=${id}">Use for upload</a>`;
        })}
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

    <h2>Composition</h2>
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
                <input name="contentType" placeholder="post | album | audioTrack" required />
                <input name="contentId" placeholder="Content ID" required />
                <input name="position" placeholder="Position (optional, 0-based)" />
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
            <h3>Move Item Between Carousels</h3>
            <form method="POST" action="/content/manage/composition/carousel/move-item">
                <select name="sourceCarouselId" required><option value="" disabled selected>Source carousel</option>${carouselOptions}</select>
                <input name="fromIndex" placeholder="Source index" required />
                <select name="targetCarouselId" required><option value="" disabled selected>Target carousel</option>${carouselOptions}</select>
                <input name="toIndex" placeholder="Target index" required />
                <button type="submit">Move Item</button>
            </form>

            <h3>Delete Carousel</h3>
            <form method="POST" action="/content/manage/composition/carousel/delete">
                <input name="carouselId" placeholder="Carousel ID" required />
                <button type="submit">Delete Carousel</button>
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
    </script>

  <h2>Create</h2>
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
      <h3>Create Audio Track</h3>
      <form method="POST" action="/content/manage/audioTrack/create">
        <input name="title" placeholder="Title" required />
        <input name="artistIds" placeholder="Artist IDs (comma separated)" />
        <input name="genres" placeholder="Genres (comma separated)" />
        <input name="albumId" placeholder="Album ID" />
        <input name="releaseDate" type="date" />
        <input name="duration" placeholder="Duration (e.g. 03:30)" />
        <input name="formatType" placeholder="Format type (e.g. MP3)" />
        <input name="formatBitrate" placeholder="Bitrate (e.g. 320)" />
        <input name="coverArtUrl" placeholder="Cover Art URL" />
        <button type="submit">Create Audio Track</button>
      </form>
    </div>
  </div>

    <h2>Quick Linking</h2>
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

    <h2 id="update-delete">Update / Delete</h2>
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
        <button type="submit">Delete Artist</button>
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
        <button type="submit">Delete Album</button>
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
        <button type="submit">Delete Audio Track</button>
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
</body>
</html>`;
};

const getOwnerId = (doc: any) => {
    return String(doc?.createdBy ?? '');
};

const redirectWithMessage = (res: Response, message: string) => {
    res.redirect(`/content/manage?message=${encodeURIComponent(message)}`);
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

        const formatType = String(req.body.formatType ?? 'MP3');
        const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
        const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;

        const track = new AudioTrack(
            String(req.body.title ?? ''),
            parseCsv(String(req.body.artistIds ?? '')),
            parseCsv(String(req.body.genres ?? '')),
            String(req.body.albumId ?? ''),
            parseDateInput(String(req.body.releaseDate ?? '')),
            String(req.body.duration ?? ''),
            new AudioFormat(formatType, Number.isNaN(bitrate as number) ? undefined : bitrate),
            String(req.body.coverArtUrl ?? ''),
            authReq.auth.userId
        );

        const createResult: any = await track.save();
        const newTrackId = String(createResult?.insertedId ?? '');
        const message = encodeURIComponent('Audio track created successfully. You can upload the file now.');
        const uploadQuery = newTrackId ? `&uploadAudioTrackId=${encodeURIComponent(newTrackId)}` : '';

        return res.redirect(`/content/manage?message=${message}${uploadQuery}`);
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
            await getS3().deleteObject({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: audioTrackId
            }).promise();
            return redirectWithMessage(res, 'Audio track deleted successfully.');
        } catch (s3Error) {
            console.log('S3 cleanup failed for audioTrackId:', audioTrackId, s3Error);
            return redirectWithMessage(res, 'Audio track deleted, but S3 file cleanup failed.');
        }
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

        await getS3().upload({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId,
            Body: uploadFile.buffer,
            ContentType: uploadFile.mimetype || 'audio/mpeg'
        }).promise();

        await AudioTrack.updateById(audioTrackId, {
            originalFileName: uploadFile.originalname,
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
            const isAudioFile = uploadFile.mimetype.startsWith('audio/')
                || uploadFile.mimetype === 'video/mp4'
                || uploadFile.mimetype === 'application/ogg';
            if (!isAudioFile) {
                failures.push(uploadFile.originalname);
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
                console.log(`Unable to read audio metadata for ${uploadFile.originalname}:`, metadataError);
            }

            const embeddedGenres = Array.isArray(metadata?.common?.genre) ? metadata.common.genre.map(String) : [];
            const releaseYear = Number(metadata?.common?.year);
            const bitrate = Number(metadata?.format?.bitrate);
            const track = new AudioTrack(
                String(metadata?.common?.title ?? titleFromFileName(uploadFile.originalname) ?? 'Untitled Track'),
                [] as unknown as [string],
                embeddedGenres as unknown as [string],
                albumId,
                Number.isFinite(releaseYear) && releaseYear > 0 ? new SimpleDate(releaseYear, 1, 1) : new SimpleDate(),
                formatDuration(metadata?.format?.duration),
                new AudioFormat(
                    inferAudioFormat(uploadFile.originalname, uploadFile.mimetype, metadata?.format?.container),
                    Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate / 1000) : undefined
                ),
                '',
                authReq.auth.userId,
                uploadFile.originalname,
                uploadFile.mimetype || 'audio/mpeg'
            );

            let audioTrackId = '';
            try {
                const createResult: any = await track.save();
                audioTrackId = String(createResult.insertedId);
                await getS3().upload({
                    Bucket: process.env.S3_BUCKET_NAME!,
                    Key: audioTrackId,
                    Body: uploadFile.buffer,
                    ContentType: uploadFile.mimetype || 'audio/mpeg'
                }).promise();
                uploadedTrackIds.push(audioTrackId);
            } catch (uploadError) {
                console.log(`Unable to upload ${uploadFile.originalname}:`, uploadError);
                if (audioTrackId) {
                    await AudioTrack.deleteById(audioTrackId);
                }
                failures.push(uploadFile.originalname);
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
