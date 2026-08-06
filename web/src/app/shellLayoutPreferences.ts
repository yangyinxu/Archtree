export const shellLayoutStorageKey = 'finitude:shell-layout:v1';
export const shellLayoutStorageVersion = 1;
export const shellPanelMinimumWidth = 280;
export const shellPanelDefaultWidth = 303;
export const shellPanelMaximumWidth = 420;
export const shellMainMinimumWidth = 416;
export const shellChromeWidth = 32;
export const shellResizableViewportMinimum = 1008;

const shellHorizontalPaddingWidth = 16;
const shellPanelGapWidth = 8;

export interface ShellLayoutPreferences {
  sidebarWidth: number;
  nowPlayingWidth: number;
}

export type ShellPanel = 'sidebar' | 'nowPlaying';

export interface ShellPanelVisibility {
  sidebar: boolean;
  nowPlaying: boolean;
}

export interface ShellPanelLimits {
  minimum: number;
  maximum: number;
}

export interface ShellLayoutResolution {
  preferred: ShellLayoutPreferences;
  effective: ShellLayoutPreferences & { mainWidth: number };
  limits: Record<ShellPanel, ShellPanelLimits>;
  chromeWidth: number;
  fitsMinimums: boolean;
  shouldApplyUserWidths: boolean;
  shouldPersistPreferences: boolean;
}

export interface ResolveShellLayoutInput {
  viewportWidth: number;
  preferences: ShellLayoutPreferences;
  visibility: ShellPanelVisibility;
  resizingPanel?: ShellPanel;
}

export interface UpdateShellPanelPreferenceInput {
  panel: ShellPanel;
  panelVisible: boolean;
  preferences: ShellLayoutPreferences;
  requestedWidth: number;
  viewportWidth: number;
}

interface StoredShellLayoutPreferences extends ShellLayoutPreferences {
  version: typeof shellLayoutStorageVersion;
}

interface ShellLayoutStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export const defaultShellLayoutPreferences: Readonly<ShellLayoutPreferences> = Object.freeze({
  sidebarWidth: shellPanelDefaultWidth,
  nowPlayingWidth: shellPanelDefaultWidth
});

const copyDefaultPreferences = (): ShellLayoutPreferences => ({
  sidebarWidth: defaultShellLayoutPreferences.sidebarWidth,
  nowPlayingWidth: defaultShellLayoutPreferences.nowPlayingWidth
});

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const validPreferredWidth = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= shellPanelMinimumWidth
  && value <= shellPanelMaximumWidth
);

const safeViewportWidth = (value: number) => (
  Number.isFinite(value) && value > 0 ? value : 0
);

const normalizePreferences = (preferences: ShellLayoutPreferences): ShellLayoutPreferences => ({
  sidebarWidth: validPreferredWidth(preferences.sidebarWidth)
    ? preferences.sidebarWidth
    : shellPanelDefaultWidth,
  nowPlayingWidth: validPreferredWidth(preferences.nowPlayingWidth)
    ? preferences.nowPlayingWidth
    : shellPanelDefaultWidth
});

const browserStorage = (): ShellLayoutStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const isStoredPreferences = (value: unknown): value is StoredShellLayoutPreferences => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 3
    && keys.every((key) => ['version', 'sidebarWidth', 'nowPlayingWidth'].includes(key))
    && record.version === shellLayoutStorageVersion
    && validPreferredWidth(record.sidebarWidth)
    && validPreferredWidth(record.nowPlayingWidth);
};

const visiblePanelCount = (visibility: ShellPanelVisibility) => (
  Number(visibility.sidebar) + Number(visibility.nowPlaying)
);

const chromeWidthFor = (visibility: ShellPanelVisibility) => (
  shellHorizontalPaddingWidth + shellPanelGapWidth * visiblePanelCount(visibility)
);

const distributePanelBudget = (
  preferred: ShellLayoutPreferences,
  visibility: ShellPanelVisibility,
  panelBudget: number,
  resizingPanel?: ShellPanel
): ShellLayoutPreferences => {
  const sidebarMinimum = visibility.sidebar ? shellPanelMinimumWidth : 0;
  const nowPlayingMinimum = visibility.nowPlaying ? shellPanelMinimumWidth : 0;
  const desired = {
    sidebarWidth: visibility.sidebar ? preferred.sidebarWidth : 0,
    nowPlayingWidth: visibility.nowPlaying ? preferred.nowPlayingWidth : 0
  };
  const desiredTotal = desired.sidebarWidth + desired.nowPlayingWidth;
  const minimumTotal = sidebarMinimum + nowPlayingMinimum;

  if (minimumTotal > panelBudget) {
    return {
      sidebarWidth: sidebarMinimum,
      nowPlayingWidth: nowPlayingMinimum
    };
  }
  if (desiredTotal <= panelBudget) return desired;

  if (resizingPanel === 'sidebar' && visibility.sidebar) {
    const nowPlayingWidth = Math.min(
      desired.nowPlayingWidth,
      panelBudget - sidebarMinimum
    );
    return {
      sidebarWidth: Math.min(desired.sidebarWidth, panelBudget - nowPlayingWidth),
      nowPlayingWidth
    };
  }

  if (resizingPanel === 'nowPlaying' && visibility.nowPlaying) {
    const sidebarWidth = Math.min(
      desired.sidebarWidth,
      panelBudget - nowPlayingMinimum
    );
    return {
      sidebarWidth,
      nowPlayingWidth: Math.min(desired.nowPlayingWidth, panelBudget - sidebarWidth)
    };
  }

  const desiredExtra = desiredTotal - minimumTotal;
  const availableExtra = Math.max(0, panelBudget - minimumTotal);
  const scale = desiredExtra === 0 ? 0 : Math.min(1, availableExtra / desiredExtra);
  return {
    sidebarWidth: sidebarMinimum + (desired.sidebarWidth - sidebarMinimum) * scale,
    nowPlayingWidth: nowPlayingMinimum
      + (desired.nowPlayingWidth - nowPlayingMinimum) * scale
  };
};

/** Reads only the current version's bounded device-local panel preferences. */
export const readShellLayoutPreferences = (
  storage: ShellLayoutStorage | null = browserStorage()
): ShellLayoutPreferences => {
  if (!storage) return copyDefaultPreferences();
  try {
    const serialized = storage.getItem(shellLayoutStorageKey);
    if (serialized === null) return copyDefaultPreferences();
    const parsed: unknown = JSON.parse(serialized);
    if (!isStoredPreferences(parsed)) return copyDefaultPreferences();
    return {
      sidebarWidth: parsed.sidebarWidth,
      nowPlayingWidth: parsed.nowPlayingWidth
    };
  } catch {
    return copyDefaultPreferences();
  }
};

/** Keeps responsive CSS in control until the complete desktop shell is available. */
export const shouldPersistShellLayoutPreferences = (viewportWidth: number) => (
  Number.isFinite(viewportWidth) && viewportWidth >= shellResizableViewportMinimum
);

/** Persists validated preferred widths without replacing them with narrow-screen values. */
export const writeShellLayoutPreferences = (
  preferences: ShellLayoutPreferences,
  viewportWidth: number,
  storage: ShellLayoutStorage | null = browserStorage()
) => {
  if (!storage || !shouldPersistShellLayoutPreferences(viewportWidth)) return false;
  if (!validPreferredWidth(preferences.sidebarWidth)
    || !validPreferredWidth(preferences.nowPlayingWidth)) return false;
  const stored: StoredShellLayoutPreferences = {
    version: shellLayoutStorageVersion,
    sidebarWidth: preferences.sidebarWidth,
    nowPlayingWidth: preferences.nowPlayingWidth
  };
  try {
    storage.setItem(shellLayoutStorageKey, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
};

/** Removes the local override so the responsive defaults apply again. */
export const clearShellLayoutPreferences = (
  storage: ShellLayoutStorage | null = browserStorage()
) => {
  if (!storage) return false;
  try {
    storage.removeItem(shellLayoutStorageKey);
    return true;
  } catch {
    return false;
  }
};

/** Updates only an explicit wide-screen drag, leaving hidden and narrow states untouched. */
export const updateShellPanelPreference = ({
  panel,
  panelVisible,
  preferences,
  requestedWidth,
  viewportWidth
}: UpdateShellPanelPreferenceInput): ShellLayoutPreferences => {
  const normalized = normalizePreferences(preferences);
  if (!panelVisible
    || !shouldPersistShellLayoutPreferences(viewportWidth)
    || !Number.isFinite(requestedWidth)) return normalized;
  const width = Math.round(clamp(
    requestedWidth,
    shellPanelMinimumWidth,
    shellPanelMaximumWidth
  ));
  return panel === 'sidebar'
    ? { ...normalized, sidebarWidth: width }
    : { ...normalized, nowPlayingWidth: width };
};

/** Resolves temporary panel widths while retaining the listener's independent preferences. */
export const resolveShellLayout = ({
  viewportWidth,
  preferences,
  visibility,
  resizingPanel
}: ResolveShellLayoutInput): ShellLayoutResolution => {
  const viewport = safeViewportWidth(viewportWidth);
  const preferred = normalizePreferences(preferences);
  const chromeWidth = chromeWidthFor(visibility);
  const contentWidth = Math.max(0, viewport - chromeWidth);
  const minimumPanelWidth = visiblePanelCount(visibility) * shellPanelMinimumWidth;
  const panelBudget = Math.max(0, contentWidth - shellMainMinimumWidth);
  const fitsMinimums = panelBudget >= minimumPanelWidth;
  const effectivePanels = distributePanelBudget(
    preferred,
    visibility,
    panelBudget,
    resizingPanel
  );
  const mainWidth = Math.max(
    0,
    contentWidth - effectivePanels.sidebarWidth - effectivePanels.nowPlayingWidth
  );
  const limits = {
    sidebar: visibility.sidebar
      ? {
          minimum: shellPanelMinimumWidth,
          maximum: fitsMinimums
            ? Math.min(
                shellPanelMaximumWidth,
                panelBudget - effectivePanels.nowPlayingWidth
              )
            : shellPanelMinimumWidth
        }
      : { minimum: 0, maximum: 0 },
    nowPlaying: visibility.nowPlaying
      ? {
          minimum: shellPanelMinimumWidth,
          maximum: fitsMinimums
            ? Math.min(
                shellPanelMaximumWidth,
                panelBudget - effectivePanels.sidebarWidth
              )
            : shellPanelMinimumWidth
        }
      : { minimum: 0, maximum: 0 }
  } satisfies Record<ShellPanel, ShellPanelLimits>;
  const wideViewport = shouldPersistShellLayoutPreferences(viewport);

  return {
    preferred,
    effective: {
      ...effectivePanels,
      mainWidth
    },
    limits,
    chromeWidth,
    fitsMinimums,
    shouldApplyUserWidths: wideViewport && fitsMinimums,
    shouldPersistPreferences: wideViewport && fitsMinimums
  };
};
