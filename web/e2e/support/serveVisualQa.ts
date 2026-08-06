import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTestTone } from '../fixtures/audio';
import {
  catalogIds,
  expandedAlbumFixture,
  searchFixture
} from '../fixtures/catalog';
import {
  privateArtistPage,
  privateLibraryPage,
  privatePlaylistDetail,
  privatePlaylistSummary,
  privateViewerSession
} from '../fixtures/privateListener';
import {
  visualAlbumFixture,
  visualArtworkSlots,
  visualHomeFixture
} from '../fixtures/visualCatalog';

const host = '127.0.0.1';
const port = Number(process.env.FINITUDE_VISUAL_QA_PORT ?? 4174);
const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const distRoot = path.join(webRoot, 'dist');
const artworkRoot = fileURLToPath(new URL('../fixtures/assets', import.meta.url));
const testTone = createTestTone();
const visualPlaylistSummary = {
  ...privatePlaylistSummary,
  artworkUrl: visualArtworkSlots.blueHour
};
const visualPlaylistDetail = {
  ...privatePlaylistDetail,
  artworkUrl: visualArtworkSlots.blueHour,
  items: privatePlaylistDetail.items.map((item, index) => ({
    ...item,
    audioTrack: item.audioTrack ? {
      ...item.audioTrack,
      artworkUrl: index === 0 ? visualArtworkSlots.blueHour : visualArtworkSlots.paperMoon
    } : null
  }))
};
const visualLibraryPage = {
  ...privateLibraryPage,
  items: privateLibraryPage.items.map((item) => item.contentType === 'album' ? {
    ...item,
    album: item.album ? { ...item.album, coverArtUrl: visualArtworkSlots.quietGarden } : null
  } : {
    ...item,
    audioTrack: item.audioTrack ? {
      ...item.audioTrack,
      coverArtUrl: visualArtworkSlots.blueHour,
      displayCoverArtUrl: visualArtworkSlots.blueHour
    } : null
  })
};

const artworkFiles = new Map<string, string>([
  [visualArtworkSlots.blueHour, path.join(artworkRoot, 'first-light.jpg')],
  [visualArtworkSlots.paperMoon, path.join(artworkRoot, 'night-window.jpg')],
  [visualArtworkSlots.quietGarden, path.join(artworkRoot, 'quiet-hours.jpg')]
]);

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

const sendJson = (
  response: ServerResponse,
  status: number,
  payload: unknown,
  accountViewer?: string
) => {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...(accountViewer ? { 'X-Finitude-Account-Viewer': accountViewer } : {})
  });
  response.end(JSON.stringify(payload));
};

const sendNoContent = (response: ServerResponse) => {
  response.writeHead(204, { 'Cache-Control': 'no-store' });
  response.end();
};

const sendFile = (
  request: IncomingMessage,
  response: ServerResponse,
  filename: string,
  cacheControl = 'no-store'
) => {
  if (!existsSync(filename) || !statSync(filename).isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }

  const size = statSync(filename).size;
  response.writeHead(200, {
    'Cache-Control': cacheControl,
    'Content-Length': String(size),
    'Content-Type': contentTypes[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filename).pipe(response);
};

const parseRange = (header: string, size: number) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
};

const sendAudio = (request: IncomingMessage, response: ServerResponse) => {
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store, no-transform',
    'Content-Type': 'audio/wav'
  };

  if (request.method === 'HEAD') {
    response.writeHead(200, { ...commonHeaders, 'Content-Length': String(testTone.length) });
    response.end();
    return;
  }

  const rangeHeader = request.headers.range;
  if (!rangeHeader) {
    response.writeHead(200, { ...commonHeaders, 'Content-Length': String(testTone.length) });
    response.end(testTone);
    return;
  }

  const range = parseRange(rangeHeader, testTone.length);
  if (!range) {
    response.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${testTone.length}` });
    response.end();
    return;
  }

  const body = testTone.subarray(range.start, range.end + 1);
  response.writeHead(206, {
    ...commonHeaders,
    'Content-Length': String(body.length),
    'Content-Range': `bytes ${range.start}-${range.end}/${testTone.length}`
  });
  response.end(body);
};

const safeStaticPath = (pathname: string) => {
  const relative = pathname.replace(/^\/finitude\/?/, '');
  const resolved = path.resolve(distRoot, relative);
  return resolved === distRoot || resolved.startsWith(`${distRoot}${path.sep}`)
    ? resolved
    : null;
};

const routeApplicationRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => {
  const { pathname } = url;
  const sendPrivateJson = (status: number, payload: unknown) =>
    sendJson(response, status, payload, privateViewerSession.user.id);

  if (request.method === 'GET' && pathname === '/auth/browser/session') {
    sendJson(response, 200, privateViewerSession);
    return true;
  }
  if (request.method === 'GET' && pathname === '/auth/browser/capabilities') {
    sendJson(response, 200, {
      password: true,
      emailRegistration: true,
      apple: false,
      google: false,
      passkey: false
    });
    return true;
  }
  if (request.method === 'GET' && pathname === '/auth/sessions') {
    sendPrivateJson(200, {
      sessions: [{
        id: 'visual-qa-current-session',
        createdAt: '2026-08-05T09:00:00.000Z',
        lastUsedAt: '2026-08-05T09:30:00.000Z',
        expiresAt: '2026-09-04T09:00:00.000Z',
        userAgent: 'Finitude visual QA fixture',
        deviceName: 'Visual QA browser',
        deviceType: 'Desktop',
        isCurrent: true
      }]
    });
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/listener/v1/capabilities') {
    sendJson(response, 200, { playlists: true });
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/listener/v1/home') {
    sendPrivateJson(200, visualHomeFixture);
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/listener/v1/search') {
    sendJson(response, 200, searchFixture(url.searchParams.get('q') ?? ''));
    return true;
  }
  if (request.method === 'GET'
    && pathname === `/api/listener/v1/albums/${catalogIds.album}`) {
    sendJson(response, 200, expandedAlbumFixture);
    return true;
  }
  if (request.method === 'GET'
    && pathname === `/api/listener/v1/albums/${visualAlbumFixture.album.id}`) {
    sendJson(response, 200, visualAlbumFixture);
    return true;
  }
  if (request.method === 'GET' && pathname.startsWith('/api/listener/v1/artists/')) {
    sendJson(response, 200, privateArtistPage);
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/listener/v1/library') {
    sendPrivateJson(200, visualLibraryPage);
    return true;
  }
  if (request.method === 'POST' && pathname === '/content/me/saves/status') {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const parsed = body ? JSON.parse(body) as {
      items?: Array<{ contentType: string; contentId: string }>;
    } : {};
    sendPrivateJson(200, {
      items: (parsed.items ?? []).map((item) => ({ ...item, saved: true }))
    });
    return true;
  }
  if (request.method === 'GET' && pathname === '/content/me/playlists/memberships') {
    const audioTrackIds = (url.searchParams.get('audioTrackIds') ?? '')
      .split(',')
      .filter(Boolean);
    sendPrivateJson(200, {
      items: audioTrackIds.map((audioTrackId) => ({ audioTrackId, playlistIds: [] }))
    });
    return true;
  }
  if (request.method === 'GET' && pathname === '/content/me/playlists') {
    sendPrivateJson(200, { items: [visualPlaylistSummary], nextCursor: null });
    return true;
  }
  if (request.method === 'GET'
    && pathname === `/content/me/playlists/${privatePlaylistDetail.id}`) {
    sendPrivateJson(200, visualPlaylistDetail);
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/listener/v1/telemetry') {
    sendNoContent(response);
    return true;
  }
  if ((request.method === 'GET' || request.method === 'HEAD')
    && pathname.startsWith('/content/audioTrack/stream/')) {
    sendAudio(request, response);
    return true;
  }
  if (pathname === '/auth/avatar') {
    sendJson(response, 404, { message: 'No private avatar in the visual fixture.' });
    return true;
  }
  return false;
};

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('FINITUDE_VISUAL_QA_PORT must be a valid TCP port.');
}
if (!existsSync(path.join(distRoot, 'index.html'))) {
  throw new Error('web/dist is missing. Build the listener before visual QA.');
}

/** Serves a deterministic signed-in build for manual Browser design review. */
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    const artwork = artworkFiles.get(url.pathname);
    if (artwork) {
      sendFile(request, response, artwork);
      return;
    }

    if (url.pathname.startsWith('/api/')
      || url.pathname.startsWith('/auth/')
      || url.pathname.startsWith('/content/')) {
      if (await routeApplicationRequest(request, response, url)) return;
      sendJson(response, 501, { message: 'Unhandled visual-QA fixture request.' });
      return;
    }

    const staticPath = safeStaticPath(url.pathname);
    if (staticPath && existsSync(staticPath) && statSync(staticPath).isFile()) {
      sendFile(request, response, staticPath, 'public, max-age=31536000, immutable');
      return;
    }

    sendFile(request, response, path.join(distRoot, 'index.html'));
  } catch (error) {
    console.error('Visual-QA fixture request failed.', error);
    if (!response.headersSent) sendJson(response, 500, { message: 'Visual-QA fixture failed.' });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`Finitude visual-QA fixture listening at http://${host}:${port}/finitude`);
});

const shutdown = () => server.close((error) => {
  if (error) {
    console.error('Unable to close the visual-QA fixture server.', error);
    process.exitCode = 1;
  }
});

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
