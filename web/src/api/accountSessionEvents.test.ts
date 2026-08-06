import {
  publishAccountSessionChange,
  subscribeToAccountSessionChanges
} from './accountSessionEvents';

test('a local mismatch still reconciles when browser storage is unavailable', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeToAccountSessionChanges(listener);
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage is unavailable.', 'SecurityError');
  });

  publishAccountSessionChange('viewer-mismatch');

  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener.mock.calls[0]?.[0]).toMatchObject({ reason: 'viewer-mismatch' });
  expect(listener.mock.calls[0]?.[0]).not.toHaveProperty('viewerId');
  unsubscribe();
  storage.mockRestore();
});

test('login is delivered only through a cross-tab transport', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeToAccountSessionChanges(listener);
  publishAccountSessionChange('login');
  const event = JSON.parse(window.localStorage.getItem(
    'finitude:browser-session-change'
  ) ?? 'null');

  expect(listener).not.toHaveBeenCalled();
  window.dispatchEvent(new StorageEvent('storage', {
    key: 'finitude:browser-session-change',
    newValue: JSON.stringify(event)
  }));
  expect(listener).toHaveBeenCalledWith(event);
  unsubscribe();
});
