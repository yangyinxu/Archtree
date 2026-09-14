import { useEffect } from 'react';
import { roomClientId } from '../../api/roomClientId';
import { playerStore } from '../../player/playerStore';
import { createActualPlaybackObserver } from '../../player/actualPlayback';
import { listeningSession } from './listeningSession';
import type { listeningRoomOccurrence } from './listeningRoomOccurrence';

/** Mounted once inside the authenticated active-profile boundary; actual events alone publish Audio. */
export const GlobalListeningPublisher = ({ viewerId }: { viewerId: string }) => {
  useEffect(() => {
    let enrich: typeof listeningRoomOccurrence | undefined, alive = true;
    void import('./listeningRoomOccurrence').then(module => { if (alive) enrich = module.listeningRoomOccurrence; });
    listeningSession.ensure(viewerId, roomClientId(), () => playerStore.notePlaybackIntent(), sample => sample.room ? enrich?.(viewerId, sample) : null);
    const refreshClock = () => { if (document.visibilityState !== 'hidden') void listeningSession.refresh(); };
    document.addEventListener('visibilitychange', refreshClock);
    document.addEventListener('resume', refreshClock);
    window.addEventListener('pageshow', refreshClock);
    const stop = createActualPlaybackObserver(playerStore, event => listeningSession.observe(event));
    return () => {
      alive = false; stop(); listeningSession.pause();
      document.removeEventListener('visibilitychange', refreshClock);
      document.removeEventListener('resume', refreshClock);
      window.removeEventListener('pageshow', refreshClock);
    };
  }, [viewerId]);
  return null;
};
