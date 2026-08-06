import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react';

import {
  readShellLayoutPreferences,
  resolveShellLayout,
  shellResizableViewportMinimum,
  updateShellPanelPreference,
  writeShellLayoutPreferences,
  type ShellLayoutPreferences,
  type ShellPanel
} from './shellLayoutPreferences';

type ShellPanelStyle = CSSProperties & {
  '--user-now-playing-width': string;
  '--user-sidebar-width': string;
};

interface ShellResizeSnapshot {
  panel: ShellPanel;
  preferences: ShellLayoutPreferences;
  resizingPanel: ShellPanel | undefined;
}

const initialViewportWidth = () => (
  typeof window === 'undefined' ? shellResizableViewportMinimum : window.innerWidth
);

/** Owns device-local wide-panel intent while responsive CSS controls compact layouts. */
export const useShellPanelSizes = (nowPlayingOpen: boolean) => {
  const [preferences, setPreferences] = useState(readShellLayoutPreferences);
  const preferencesRef = useRef(preferences);
  const [viewportWidth, setViewportWidth] = useState(initialViewportWidth);
  const [resizingPanel, setResizingPanel] = useState<ShellPanel>();
  const resizingPanelRef = useRef<ShellPanel | undefined>(undefined);
  const resizeSnapshot = useRef<ShellResizeSnapshot | null>(null);

  useEffect(() => {
    const measureViewport = () => setViewportWidth(window.innerWidth);
    measureViewport();
    window.addEventListener('resize', measureViewport, { passive: true });
    return () => window.removeEventListener('resize', measureViewport);
  }, []);

  const visibility = useMemo(() => ({
    sidebar: viewportWidth >= 768,
    nowPlaying: nowPlayingOpen && viewportWidth >= 800
  }), [nowPlayingOpen, viewportWidth]);

  const layout = useMemo(() => resolveShellLayout({
    viewportWidth,
    preferences,
    visibility,
    resizingPanel
  }), [preferences, resizingPanel, viewportWidth, visibility]);

  const beginPanelResize = useCallback((panel: ShellPanel) => {
    resizeSnapshot.current = {
      panel,
      preferences: { ...preferencesRef.current },
      resizingPanel: resizingPanelRef.current
    };
  }, []);

  const cancelPanelResize = useCallback(() => {
    const snapshot = resizeSnapshot.current;
    if (!snapshot) return;
    resizeSnapshot.current = null;
    preferencesRef.current = snapshot.preferences;
    resizingPanelRef.current = snapshot.resizingPanel;
    setPreferences(snapshot.preferences);
    setResizingPanel(snapshot.resizingPanel);
  }, []);

  const updatePanel = useCallback((panel: ShellPanel, requestedWidth: number) => {
    const limits = layout.limits[panel];
    const width = Math.min(Math.max(requestedWidth, limits.minimum), limits.maximum);
    const next = updateShellPanelPreference({
      panel,
      panelVisible: visibility[panel],
      preferences: preferencesRef.current,
      requestedWidth: width,
      viewportWidth
    });
    preferencesRef.current = next;
    resizingPanelRef.current = panel;
    setResizingPanel(panel);
    setPreferences(next);
    return next;
  }, [layout.limits, viewportWidth, visibility]);

  const commitPanel = useCallback((panel: ShellPanel, requestedWidth: number) => {
    const next = updatePanel(panel, requestedWidth);
    resizeSnapshot.current = null;
    writeShellLayoutPreferences(next, viewportWidth);
  }, [updatePanel, viewportWidth]);

  useEffect(() => {
    const snapshot = resizeSnapshot.current;
    if (snapshot && !visibility[snapshot.panel]) cancelPanelResize();
  }, [cancelPanelResize, visibility]);

  const style = useMemo<ShellPanelStyle | undefined>(() => (
    layout.shouldApplyUserWidths
      ? {
          '--user-now-playing-width': `${visibility.nowPlaying
            ? layout.effective.nowPlayingWidth
            : layout.preferred.nowPlayingWidth}px`,
          '--user-sidebar-width': `${layout.effective.sidebarWidth}px`
        }
      : undefined
  ), [layout, visibility.nowPlaying]);

  return {
    beginPanelResize,
    canResizeNowPlaying: layout.shouldApplyUserWidths
      && visibility.nowPlaying
      && layout.limits.nowPlaying.maximum > layout.limits.nowPlaying.minimum,
    canResizeSidebar: layout.shouldApplyUserWidths
      && visibility.sidebar
      && layout.limits.sidebar.maximum > layout.limits.sidebar.minimum,
    cancelPanelResize,
    commitPanel,
    layout,
    style,
    updatePanel,
    viewportWidth
  };
};
