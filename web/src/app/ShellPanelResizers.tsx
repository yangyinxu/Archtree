import { useLayoutEffect, type RefObject } from 'react';

import { PanelResizeHandle } from './PanelResizeHandle';
import styles from './ShellPanelResizers.module.css';
import { useShellPanelSizes } from './useShellPanelSizes';

interface ShellPanelResizersProps {
  nowPlayingOpen: boolean;
  shellRef: RefObject<HTMLDivElement | null>;
}

/** Loads wide-screen resize behavior after the stable responsive shell is visible. */
export const ShellPanelResizers = ({
  nowPlayingOpen,
  shellRef
}: ShellPanelResizersProps) => {
  const panelSizes = useShellPanelSizes(nowPlayingOpen);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const sidebarWidth = panelSizes.style?.['--user-sidebar-width'];
    const nowPlayingWidth = panelSizes.style?.['--user-now-playing-width'];

    if (sidebarWidth && nowPlayingWidth) {
      shell.style.setProperty('--user-sidebar-width', sidebarWidth);
      shell.style.setProperty('--user-now-playing-width', nowPlayingWidth);
      shell.dataset.userPanelWidths = 'true';
    } else {
      shell.style.removeProperty('--user-sidebar-width');
      shell.style.removeProperty('--user-now-playing-width');
      delete shell.dataset.userPanelWidths;
    }
  }, [panelSizes.style, shellRef]);

  useLayoutEffect(() => () => {
    const shell = shellRef.current;
    shell?.style.removeProperty('--user-sidebar-width');
    shell?.style.removeProperty('--user-now-playing-width');
    if (shell) delete shell.dataset.userPanelWidths;
  }, [shellRef]);

  return (
    <aside aria-label="Panel layout controls" className={styles.landmark}>
      {panelSizes.canResizeSidebar && (
        <PanelResizeHandle
          controls="library-sidebar"
          label="Resize Library panel"
          max={panelSizes.layout.limits.sidebar.maximum}
          min={panelSizes.layout.limits.sidebar.minimum}
          onCancel={panelSizes.cancelPanelResize}
          onChange={(value) => panelSizes.updatePanel('sidebar', value)}
          onCommit={(value) => panelSizes.commitPanel('sidebar', value)}
          onDragStart={() => panelSizes.beginPanelResize('sidebar')}
          side="left"
          value={panelSizes.layout.effective.sidebarWidth}
        />
      )}
      {panelSizes.canResizeNowPlaying && (
        <PanelResizeHandle
          controls="now-playing-aside"
          label="Resize Now Playing panel"
          max={panelSizes.layout.limits.nowPlaying.maximum}
          min={panelSizes.layout.limits.nowPlaying.minimum}
          onCancel={panelSizes.cancelPanelResize}
          onChange={(value) => panelSizes.updatePanel('nowPlaying', value)}
          onCommit={(value) => panelSizes.commitPanel('nowPlaying', value)}
          onDragStart={() => panelSizes.beginPanelResize('nowPlaying')}
          side="right"
          value={panelSizes.layout.effective.nowPlayingWidth}
        />
      )}
    </aside>
  );
};
