import trace from '../../../contracts/social/prototype-v1/playback-trace.json';
import { createPlayerStore } from '../../src/player/playerStore';
import type { RoomPlaybackIntent, RoomPlaybackObservation, RoomPlaybackState } from '../../src/player/roomPlayback';
import { createRoomPlaybackController } from '../../src/player/roomPlayback';

/** Bundled only in memory by its browser spec; it is absent from the production app graph. */
const createHarness = () => {
  const intents: RoomPlaybackIntent[] = [];
  const observations: RoomPlaybackObservation[] = [];
  let loads = 0;
  let plays = 0;
  let creations = 0;
  const localAnchors = new Map<number, number>();
  const store = createPlayerStore({
    roomPlaybackProbeFactory: createRoomPlaybackController,
    initiallyMuted: true,
    mediaSession: null,
    audioFactory: () => {
      creations += 1;
      const media = document.createElement('video');
      media.playsInline = true;
      media.controls = false;
      const load = media.load.bind(media);
      const play = media.play.bind(media);
      media.load = () => { loads += 1; load(); };
      media.play = () => { plays += 1; return play(); };
      return media;
    }
  });
  const room = store.attachRoomPlayback({
    onIntent: (value) => intents.push(value),
    onObservation: (value) => observations.push(value)
  });
  const queue = ['a', 'b'].map((name, index) => ({
    id: `00000000000000000000000${index + 1}`, title: name,
    artworkUrl: '', artistNames: [], mediaType: 'audio' as const,
    streamUrl: `/__room-tone/${name}.wav`
  }));
  return {
    /** Translate each synthetic playback occurrence once; membership revisions keep its anchor. */
    apply(index: number, override: Partial<RoomPlaybackState> = {}) {
      const value = trace.snapshots[index].snapshot;
      if (!localAnchors.has(value.playbackGeneration)) localAnchors.set(value.playbackGeneration, performance.now());
      return room.apply({
        roomId: value.roomId, epoch: value.epoch, mediaRevision: value.mediaRevision,
        revision: value.revision, playbackEpoch: value.playbackGeneration,
        controlEpoch: value.controlGeneration, queueRevision: value.queueRevision,
        canControl: true,
        queue, entryIds: ['entry-a', 'entry-b'], currentEntryId: value.entryId,
        positionSeconds: value.positionMs / 1000,
        anchorMonotonicMs: localAnchors.get(value.playbackGeneration)!, status: value.state as 'playing' | 'paused',
        ...override
      });
    },
    state() {
      const media = document.querySelector('video');
      return {
        snapshot: store.getSnapshot(), intents: [...intents], observations: [...observations],
        loads, plays, creations, mediaCount: document.querySelectorAll('video').length,
        paused: media?.paused, currentTime: media?.currentTime,
        rate: media?.playbackRate, readyState: media?.readyState, seeking: media?.seeking
      };
    },
    next: () => store.next(),
    pauseLocally: () => room.pauseLocally(),
    resync: () => room.resync(),
    correct: (positionSeconds: number) => room.correct(positionSeconds),
    seekThroughNativeElement(positionSeconds: number) {
      const media = document.querySelector('video');
      if (media) media.currentTime = positionSeconds;
    },
    detach: () => room.detach(),
    destroy: () => store.destroy()
  };
};

declare global {
  interface Window { roomProbe: ReturnType<typeof createHarness> }
}

window.roomProbe = createHarness();
