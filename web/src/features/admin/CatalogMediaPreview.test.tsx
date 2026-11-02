import { cleanup, render, screen } from '@testing-library/react';
import { CatalogMediaPreview } from './CatalogMediaPreview';
import type { CatalogItem } from './catalogApi';

const guard = vi.hoisted(() => ({ active: true, viewerId: 'a'.repeat(24), epoch: 1, generation: 1 }));
vi.mock('./adminPageText', () => ({ useAdminDeliveryText: () => (key: string) => key }));
vi.mock('./AdminAccess', () => ({ useAdminAccess: () => guard, useAdminText: () => (key: string) => key }));
const item: CatalogItem = { kind: 'audioTrack', id: 'b'.repeat(24), revision: `cr_${'a'.repeat(43)}`, mediaType: 'video', visibility: 'public', effectiveVisibility: 'public',
  mediaUrl: `/api/admin/v1/catalog/audioTrack/${'b'.repeat(24)}/media`, coverUrl: null, capabilities: { editing: true, visibility: true },
  fields: { title: 'Synthetic published Video', releaseDate: null, credits: null, attributionStatus: 'unknown', discNumber: null, trackNumber: null } };
beforeEach(() => {
  Object.assign(guard, { active: true, viewerId: 'a'.repeat(24), epoch: 1, generation: 1 });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('shared preview independently fences private sources when its parent remains mounted outside Admin view', () => {
  const { rerender } = render(<CatalogMediaPreview item={item} />), previous = screen.getByLabelText('video.published_preview');
  expect(previous.tagName).toBe('VIDEO'); expect(previous).toHaveAttribute('src', `${item.mediaUrl}?viewer=${guard.viewerId}`);
  guard.active = false; rerender(<CatalogMediaPreview item={item} />);
  expect(document.querySelector('video')).toBeNull(); expect(previous).not.toHaveAttribute('src');
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce(); expect(HTMLMediaElement.prototype.load).toHaveBeenCalledOnce();
});

test('a changed account generation releases the former media before binding the new viewer', () => {
  const { rerender } = render(<CatalogMediaPreview item={item} />), previous = screen.getByLabelText('video.published_preview');
  Object.assign(guard, { viewerId: 'c'.repeat(24), epoch: 2, generation: 2 }); rerender(<CatalogMediaPreview item={item} />);
  const current = screen.getByLabelText('video.published_preview');
  expect(current).not.toBe(previous); expect(current).toHaveAttribute('src', `${item.mediaUrl}?viewer=${guard.viewerId}`);
  expect(previous).not.toHaveAttribute('src'); expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
});
