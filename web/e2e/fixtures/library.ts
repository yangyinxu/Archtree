import type { LibraryPage } from '../../src/api/contentSchemas';

/** Mirrors collection filtering before pagination so browser fixtures catch query regressions. */
export const filterLibraryFixture = (page: LibraryPage, url: URL): LibraryPage => {
  const types = (url.searchParams.get('types') ?? '').split(',').filter(Boolean);
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const sort = url.searchParams.get('sort') ?? 'recentActivity';
  const field = sort === 'recentlyPlayed' ? 'lastPlayedAt' : sort === 'recentlySaved' ? 'savedAt' : 'lastActivityAt';
  const items = page.items.filter((item) => (!types.length || types.includes(item.contentType))
    && (item.contentType === 'album' ? item.album.title : item.audioTrack.title).toLowerCase().includes(query))
    .sort((a, b) => String(b[field] ?? '').localeCompare(String(a[field] ?? '')) || b.contentId.localeCompare(a.contentId));
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 50)));
  const start = Number(url.searchParams.get('cursor') ?? 0);
  return { items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : null };
};
