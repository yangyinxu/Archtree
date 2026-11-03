import { readVideoPreviewMuted, setVideoPreviewMuted, subscribeVideoPreviewPreferences } from './videoPreviewPreferences';

beforeEach(() => {
  setVideoPreviewMuted(false);
  localStorage.clear();
});

test('new devices request sound and only the explicit true preference mutes by default', () => {
  expect(readVideoPreviewMuted()).toBe(false);
  for (const invalid of ['', 'invalid', '1', 'null']) {
    localStorage.setItem('finitude:video-preview-muted', invalid);
    expect(readVideoPreviewMuted()).toBe(false);
  }
  localStorage.setItem('finitude:video-preview-muted', 'true');
  expect(readVideoPreviewMuted()).toBe(true);
});

test('the setting persists and notifies mounted previews in the same document', () => {
  const listener = vi.fn();
  const stop = subscribeVideoPreviewPreferences(listener);
  setVideoPreviewMuted(true);
  expect(localStorage.getItem('finitude:video-preview-muted')).toBe('true');
  expect(readVideoPreviewMuted()).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  setVideoPreviewMuted(false);
  expect(listener).toHaveBeenCalledTimes(1);
});

test('cross-tab changes and clearing preferences update subscribers without observing unrelated keys', () => {
  const listener = vi.fn();
  const stop = subscribeVideoPreviewPreferences(listener);
  localStorage.setItem('finitude:video-preview-muted', 'true');
  window.dispatchEvent(new StorageEvent('storage', { key: 'finitude:video-preview-muted', newValue: 'true' }));
  expect(listener).toHaveBeenCalledTimes(1);
  expect(readVideoPreviewMuted()).toBe(true);
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
  expect(listener).toHaveBeenCalledTimes(1);
  localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  expect(readVideoPreviewMuted()).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
});

test('denied persistence keeps the current choice usable and later storage recovery works', () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied'); });
  setVideoPreviewMuted(true);
  expect(readVideoPreviewMuted()).toBe(true);
  setVideoPreviewMuted(false);
  expect(readVideoPreviewMuted()).toBe(false);
  write.mockRestore();
  setVideoPreviewMuted(true);
  expect(readVideoPreviewMuted()).toBe(true);
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied'); });
  expect(readVideoPreviewMuted()).toBe(true);
  read.mockRestore();
});
