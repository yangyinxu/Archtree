import trace from '../../../contracts/social/prototype-v1/playback-trace.json';
import { createPlayerStore } from '../../src/player/playerStore';
import type { RoomPlaybackIntent, RoomPlaybackObservation, RoomPlaybackState } from '../../src/player/roomPlayback';
import { createRoomPlaybackController } from '../../src/player/roomPlayback';

/** Bundled only in memory by its browser spec; it is absent from the production app graph. */
const createHarness = () => {
  const intents: RoomPlaybackIntent[] = [];
  const observations: RoomPlaybackObservation[] = [];
  // Preserve bounded native decoder evidence even if a browser stalls before a Playwright assertion completes.
  const mediaEvents: { event: string; trusted: boolean; monotonicMs: number; currentTime: number;
    duration: number; paused: boolean; seeking: boolean; readyState: number; networkState: number;
    ended: boolean; rate: number; error: number | null; buffered: number[][]; seekable: number[][] }[] = [];
  const ranges = (value: TimeRanges) => Array.from({ length: Math.min(value.length, 4) }, (_, index) => [value.start(index), value.end(index)]);
  /** Early native range queries can change WebKit's unknown-duration cache; diagnostics wait for real metadata. */
  const readNativeMedia = (media: HTMLVideoElement) => {
    const readyState = media.readyState;
    const duration = readyState >= 1 ? media.duration : Number.NaN;
    const readableRanges = readyState >= 1 && Number.isFinite(duration) && duration > 0;
    return { currentTime: media.currentTime, duration, paused: media.paused, seeking: media.seeking, readyState,
      networkState: media.networkState, ended: media.ended, rate: media.playbackRate, error: media.error?.code ?? null,
      buffered: readableRanges ? ranges(media.buffered) : [], seekable: readableRanges ? ranges(media.seekable) : [] };
  };
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
      for (const event of ['loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'play', 'playing', 'pause',
        'timeupdate', 'seeking', 'seeked', 'waiting', 'stalled', 'ratechange', 'ended', 'error']) {
        media.addEventListener(event, (value) => {
          mediaEvents.push({ event, trusted: value.isTrusted, monotonicMs: performance.now(), ...readNativeMedia(media) });
          if (mediaEvents.length > 200) mediaEvents.shift();
        });
      }
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
      const playbackEpoch = override.playbackEpoch ?? value.playbackGeneration;
      if (!localAnchors.has(playbackEpoch)) localAnchors.set(playbackEpoch, override.anchorMonotonicMs ?? performance.now());
      return room.apply({
        roomId: value.roomId, epoch: value.epoch, mediaRevision: value.mediaRevision,
        revision: value.revision, playbackEpoch,
        controlEpoch: value.controlGeneration, queueRevision: value.queueRevision,
        canControl: true,
        queue, entryIds: ['entry-a', 'entry-b'], currentEntryId: value.entryId,
        positionSeconds: value.positionMs / 1000,
        anchorMonotonicMs: localAnchors.get(playbackEpoch)!, status: value.state as 'playing' | 'paused',
        ...override
      });
    },
    state() {
      const media = document.querySelector('video');
      const native = media ? readNativeMedia(media) : undefined;
      return {
        snapshot: store.getSnapshot(), intents: [...intents], observations: [...observations],
        loads, plays, creations, mediaCount: document.querySelectorAll('video').length,
        paused: native?.paused, currentTime: native?.currentTime, duration: native?.duration,
        rate: native?.rate, readyState: native?.readyState, seeking: native?.seeking,
        networkState: native?.networkState, ended: native?.ended, error: native?.error ?? null,
        buffered: native?.buffered ?? [], seekable: native?.seekable ?? [],
        mediaEvents: [...mediaEvents]
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
