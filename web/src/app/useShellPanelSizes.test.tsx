import { act, renderHook } from '@testing-library/react';

import { shellLayoutStorageKey } from './shellLayoutPreferences';
import { useShellPanelSizes } from './useShellPanelSizes';

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
    writable: true
  });
};

beforeEach(() => {
  setViewportWidth(1_280);
  window.localStorage.setItem(shellLayoutStorageKey, JSON.stringify({
    version: 1,
    sidebarWidth: 420,
    nowPlayingWidth: 420
  }));
});

afterEach(() => window.localStorage.clear());

test('restores constrained preferred widths and layout priority after cancellation', () => {
  const { result } = renderHook(() => useShellPanelSizes(true));

  expect(result.current.layout.preferred).toEqual({
    sidebarWidth: 420,
    nowPlayingWidth: 420
  });
  expect(result.current.layout.effective).toEqual({
    sidebarWidth: 416,
    nowPlayingWidth: 416,
    mainWidth: 416
  });

  act(() => result.current.beginPanelResize('sidebar'));
  act(() => result.current.updatePanel('sidebar', 360));
  expect(result.current.layout.preferred).toEqual({
    sidebarWidth: 360,
    nowPlayingWidth: 420
  });

  act(() => result.current.cancelPanelResize());
  expect(result.current.layout.preferred).toEqual({
    sidebarWidth: 420,
    nowPlayingWidth: 420
  });
  expect(result.current.layout.effective).toEqual({
    sidebarWidth: 416,
    nowPlayingWidth: 416,
    mainWidth: 416
  });
  expect(JSON.parse(window.localStorage.getItem(shellLayoutStorageKey) ?? 'null')).toEqual({
    version: 1,
    sidebarWidth: 420,
    nowPlayingWidth: 420
  });
});
