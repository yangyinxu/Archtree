import { act, renderHook } from '@testing-library/react';
import { useVideosView, type VideosView } from './useVideosView';

beforeEach(() => localStorage.removeItem('finitude:video-browse-view'));
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

test('the configured default can arrive asynchronously without becoming a stored listener preference', () => {
  const { result, rerender } = renderHook(({ view }: { view?: VideosView }) => useVideosView(view), { initialProps: { view: undefined as VideosView | undefined } });
  expect(result.current[0]).toBe('grid');
  rerender({ view: 'immersive' });
  expect(result.current[0]).toBe('immersive');
  expect(localStorage.getItem('finitude:video-browse-view')).toBeNull();
});

test('an explicit saved Grid or Immersive preference takes precedence over a changed default', () => {
  for (const stored of ['grid', 'immersive'] as const) {
    localStorage.setItem('finitude:video-browse-view', stored);
    const { result, rerender, unmount } = renderHook(({ view }) => useVideosView(view), { initialProps: { view: 'grid' as VideosView } });
    rerender({ view: 'immersive' });
    expect(result.current[0]).toBe(stored);
    unmount();
  }
});

test('unknown or unreadable stored values fall back to the configured view and switching survives storage denial', () => {
  localStorage.setItem('finitude:video-browse-view', 'carousel');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied'); });
  const { result, rerender } = renderHook(({ view }) => useVideosView(view), { initialProps: { view: 'immersive' as VideosView } });
  expect(result.current[0]).toBe('immersive');
  act(() => result.current[1]('grid'));
  rerender({ view: 'immersive' });
  expect(result.current[0]).toBe('grid');
});
