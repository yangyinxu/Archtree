import type { Page, Route } from '@playwright/test';

import { createTestTone } from '../fixtures/audio';
import {
  catalogIds,
  expandedAlbumFixture,
  homeFixture,
  searchFixture
} from '../fixtures/catalog';

export interface BrowserApiCall {
  method: string;
  pathname: string;
  search: string;
}

export interface BrowserApiFixture {
  calls: BrowserApiCall[];
  unhandled: BrowserApiCall[];
}

const browserCapabilities = {
  password: true,
  emailRegistration: true,
  apple: false,
  google: false,
  passkey: false
};

const jsonResponse = (
  route: Route,
  status: number,
  payload: unknown
) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
  body: JSON.stringify(payload)
});

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

const fulfillAudio = async (route: Route, tone: Buffer) => {
  const request = route.request();
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store, no-transform',
    'Content-Type': 'audio/wav'
  };

  if (request.method() === 'HEAD') {
    headers['Content-Length'] = String(tone.length);
    await route.fulfill({ status: 200, headers });
    return;
  }

  const rangeHeader = request.headers().range;
  if (!rangeHeader) {
    headers['Content-Length'] = String(tone.length);
    await route.fulfill({ status: 200, headers, body: tone });
    return;
  }

  const range = parseRange(rangeHeader, tone.length);
  if (!range) {
    await route.fulfill({
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${tone.length}` },
      body: ''
    });
    return;
  }

  const body = tone.subarray(range.start, range.end + 1);
  await route.fulfill({
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(body.length),
      'Content-Range': `bytes ${range.start}-${range.end}/${tone.length}`
    },
    body
  });
};

const isApplicationRequest = (pathname: string) => [
  '/api/',
  '/auth/',
  '/content/'
].some((prefix) => pathname.startsWith(prefix));

/** Installs one strict signed-out API boundary for an otherwise real production bundle. */
export const installSignedOutApi = async (page: Page): Promise<BrowserApiFixture> => {
  const fixture: BrowserApiFixture = { calls: [], unhandled: [] };
  const tone = createTestTone();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!isApplicationRequest(url.pathname)) {
      await route.continue();
      return;
    }

    const call = {
      method: request.method(),
      pathname: url.pathname,
      search: url.search
    };
    fixture.calls.push(call);

    if (call.method === 'GET' && call.pathname === '/auth/browser/session') {
      await jsonResponse(route, 401, { message: 'Unauthorized' });
      return;
    }
    if (call.method === 'POST' && call.pathname === '/auth/browser/refresh') {
      await jsonResponse(route, 401, { message: 'Unauthorized' });
      return;
    }
    if (call.method === 'GET' && call.pathname === '/auth/browser/capabilities') {
      await jsonResponse(route, 200, browserCapabilities);
      return;
    }
    if (call.method === 'GET' && call.pathname === '/api/listener/v1/home') {
      await jsonResponse(route, 200, homeFixture);
      return;
    }
    if (call.method === 'GET'
      && call.pathname === `/api/listener/v1/albums/${catalogIds.album}`) {
      await jsonResponse(route, 200, expandedAlbumFixture);
      return;
    }
    if (call.method === 'GET' && call.pathname === '/api/listener/v1/search') {
      await jsonResponse(
        route,
        200,
        searchFixture(new URLSearchParams(call.search).get('q') ?? '')
      );
      return;
    }
    if (call.method === 'POST' && call.pathname === '/api/listener/v1/telemetry') {
      await route.fulfill({ status: 204, headers: { 'Cache-Control': 'no-store' } });
      return;
    }
    if ((call.method === 'GET' || call.method === 'HEAD')
      && call.pathname.startsWith('/content/audioTrack/stream/')) {
      await fulfillAudio(route, tone);
      return;
    }

    fixture.unhandled.push(call);
    await jsonResponse(route, 501, { message: 'Unhandled browser-test request.' });
  });

  return fixture;
};
