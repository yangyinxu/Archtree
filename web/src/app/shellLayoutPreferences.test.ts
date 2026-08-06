import {
  clearShellLayoutPreferences,
  defaultShellLayoutPreferences,
  readShellLayoutPreferences,
  resolveShellLayout,
  shellChromeWidth,
  shellLayoutStorageKey,
  shellMainMinimumWidth,
  shellPanelDefaultWidth,
  shellPanelMaximumWidth,
  shellPanelMinimumWidth,
  updateShellPanelPreference,
  writeShellLayoutPreferences
} from './shellLayoutPreferences';

const bothPanels = { sidebar: true, nowPlaying: true };

beforeEach(() => window.localStorage.clear());

test('reproduces the existing wide-shell defaults and responsive clamp', () => {
  expect(defaultShellLayoutPreferences).toEqual({
    sidebarWidth: 303,
    nowPlayingWidth: 303
  });
  expect(shellPanelMinimumWidth).toBe(280);
  expect(shellPanelDefaultWidth).toBe(303);
  expect(shellPanelMaximumWidth).toBe(420);
  expect(shellMainMinimumWidth).toBe(416);
  expect(shellChromeWidth).toBe(32);

  const wide = resolveShellLayout({
    viewportWidth: 1280,
    preferences: { ...defaultShellLayoutPreferences },
    visibility: bothPanels
  });
  expect(wide.effective).toEqual({
    sidebarWidth: 303,
    nowPlayingWidth: 303,
    mainWidth: 642
  });
  expect(wide.chromeWidth).toBe(32);
  expect(wide.shouldApplyUserWidths).toBe(true);

  const boundary = resolveShellLayout({
    viewportWidth: 1008,
    preferences: { ...defaultShellLayoutPreferences },
    visibility: bothPanels
  });
  expect(boundary.preferred).toEqual(defaultShellLayoutPreferences);
  expect(boundary.effective).toEqual({
    sidebarWidth: 280,
    nowPlayingWidth: 280,
    mainWidth: 416
  });
  expect(boundary.limits).toEqual({
    sidebar: { minimum: 280, maximum: 280 },
    nowPlaying: { minimum: 280, maximum: 280 }
  });

  const transitioning = resolveShellLayout({
    viewportWidth: 1030,
    preferences: { ...defaultShellLayoutPreferences },
    visibility: bothPanels
  });
  expect(transitioning.effective).toEqual({
    sidebarWidth: 291,
    nowPlayingWidth: 291,
    mainWidth: 416
  });
});

test('enforces the joint side-panel budget without overwriting preferences', () => {
  const balanced = resolveShellLayout({
    viewportWidth: 1280,
    preferences: { sidebarWidth: 420, nowPlayingWidth: 420 },
    visibility: bothPanels
  });
  expect(balanced.preferred).toEqual({ sidebarWidth: 420, nowPlayingWidth: 420 });
  expect(balanced.effective).toEqual({
    sidebarWidth: 416,
    nowPlayingWidth: 416,
    mainWidth: 416
  });

  const resizingSidebar = resolveShellLayout({
    viewportWidth: 1280,
    preferences: { sidebarWidth: 420, nowPlayingWidth: 420 },
    visibility: bothPanels,
    resizingPanel: 'sidebar'
  });
  expect(resizingSidebar.effective).toEqual({
    sidebarWidth: 412,
    nowPlayingWidth: 420,
    mainWidth: 416
  });
  expect(resizingSidebar.limits.sidebar.maximum).toBe(412);
  expect(resizingSidebar.limits.nowPlaying.maximum).toBe(420);
});

test('returns hidden-panel width to zero while retaining its preferred width', () => {
  const resolved = resolveShellLayout({
    viewportWidth: 1008,
    preferences: { sidebarWidth: 420, nowPlayingWidth: 380 },
    visibility: { sidebar: true, nowPlaying: false }
  });

  expect(resolved.preferred).toEqual({ sidebarWidth: 420, nowPlayingWidth: 380 });
  expect(resolved.effective).toEqual({
    sidebarWidth: 420,
    nowPlayingWidth: 0,
    mainWidth: 564
  });
  expect(resolved.chromeWidth).toBe(24);
  expect(resolved.limits.nowPlaying).toEqual({ minimum: 0, maximum: 0 });
});

test('reads and writes only the exact versioned bounded schema', () => {
  expect(readShellLayoutPreferences()).toEqual(defaultShellLayoutPreferences);
  expect(writeShellLayoutPreferences({
    sidebarWidth: 340,
    nowPlayingWidth: 390
  }, 1440)).toBe(true);
  expect(readShellLayoutPreferences()).toEqual({
    sidebarWidth: 340,
    nowPlayingWidth: 390
  });
  expect(writeShellLayoutPreferences({
    sidebarWidth: 279,
    nowPlayingWidth: 390
  }, 1440)).toBe(false);

  const invalidPayloads = [
    '{not-json',
    JSON.stringify({ version: 2, sidebarWidth: 340, nowPlayingWidth: 390 }),
    JSON.stringify({ version: 1, sidebarWidth: 279, nowPlayingWidth: 390 }),
    JSON.stringify({ version: 1, sidebarWidth: 340, nowPlayingWidth: 421 }),
    '{"version":1,"sidebarWidth":1e999,"nowPlayingWidth":390}',
    JSON.stringify({
      version: 1,
      sidebarWidth: 340,
      nowPlayingWidth: 390,
      unexpected: true
    })
  ];
  for (const payload of invalidPayloads) {
    window.localStorage.setItem(shellLayoutStorageKey, payload);
    expect(readShellLayoutPreferences(), payload).toEqual(defaultShellLayoutPreferences);
  }
});

test('does not write temporary narrow-screen or hidden-panel widths back', () => {
  const preferred = { sidebarWidth: 380, nowPlayingWidth: 360 };
  expect(writeShellLayoutPreferences(preferred, 1440)).toBe(true);

  const narrowUpdate = updateShellPanelPreference({
    panel: 'sidebar',
    panelVisible: true,
    preferences: preferred,
    requestedWidth: 280,
    viewportWidth: 799
  });
  const hiddenUpdate = updateShellPanelPreference({
    panel: 'nowPlaying',
    panelVisible: false,
    preferences: preferred,
    requestedWidth: 280,
    viewportWidth: 1440
  });
  expect(narrowUpdate).toEqual(preferred);
  expect(hiddenUpdate).toEqual(preferred);
  expect(writeShellLayoutPreferences(narrowUpdate, 799)).toBe(false);
  expect(readShellLayoutPreferences()).toEqual(preferred);

  const narrowResolution = resolveShellLayout({
    viewportWidth: 799,
    preferences: preferred,
    visibility: bothPanels
  });
  expect(narrowResolution.preferred).toEqual(preferred);
  expect(narrowResolution.shouldApplyUserWidths).toBe(false);
  expect(narrowResolution.shouldPersistPreferences).toBe(false);
});

test('clamps explicit wide-screen preference updates to global bounds', () => {
  const preferred = { sidebarWidth: 303, nowPlayingWidth: 303 };
  expect(updateShellPanelPreference({
    panel: 'sidebar',
    panelVisible: true,
    preferences: preferred,
    requestedWidth: 999,
    viewportWidth: 1440
  })).toEqual({ sidebarWidth: 420, nowPlayingWidth: 303 });
  expect(updateShellPanelPreference({
    panel: 'nowPlaying',
    panelVisible: true,
    preferences: preferred,
    requestedWidth: 100,
    viewportWidth: 1440
  })).toEqual({ sidebarWidth: 303, nowPlayingWidth: 280 });
  expect(updateShellPanelPreference({
    panel: 'sidebar',
    panelVisible: true,
    preferences: preferred,
    requestedWidth: Number.NaN,
    viewportWidth: 1440
  })).toEqual(preferred);
});

test('tolerates unavailable browser storage and can clear a saved override', () => {
  const throwingStorage = {
    getItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); }
  };
  expect(readShellLayoutPreferences(throwingStorage)).toEqual(defaultShellLayoutPreferences);
  expect(writeShellLayoutPreferences({
    sidebarWidth: 303,
    nowPlayingWidth: 303
  }, 1440, throwingStorage)).toBe(false);
  expect(clearShellLayoutPreferences(throwingStorage)).toBe(false);

  expect(writeShellLayoutPreferences({
    sidebarWidth: 320,
    nowPlayingWidth: 330
  }, 1440)).toBe(true);
  expect(clearShellLayoutPreferences()).toBe(true);
  expect(readShellLayoutPreferences()).toEqual(defaultShellLayoutPreferences);
});
