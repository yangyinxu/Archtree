import type { Page } from '@playwright/test';

/** Native event snapshots contain only media state and an allowlisted source identity. */
type MediaEventDiagnostic = {
  event: 'canplay' | 'seeked' | 'seeking' | 'ratechange' | 'waiting' | 'playing' | 'pause' | 'error' | 'timeupdate';
  trusted: boolean;
  observedAtMs: number;
  capturedAtMs: number;
  time: number | null;
  duration: number | null;
  playbackRate: number | null;
  ready: number;
  network: number;
  paused: boolean;
  seeking: boolean;
  error: number | null;
  sourcePath: string | null;
  revision: string | null;
};
type DiagnosticWindow = Window & { __archtreeMediaEventDiagnostics?: MediaEventDiagnostic[] };

/** Observe capture-phase native events; never replace a media method, property, event, or clock. */
export const installMediaEventDiagnostics = (page: Page) => page.addInitScript(() => {
  const records: MediaEventDiagnostic[] = [];
  (window as DiagnosticWindow).__archtreeMediaEventDiagnostics = records;
  const finite = (value: number) => Number.isFinite(value) ? value : null;
  for (const name of ['canplay', 'seeked', 'seeking', 'ratechange', 'waiting', 'playing', 'pause', 'error', 'timeupdate'] as const) {
    document.addEventListener(name, event => {
      const target = event.target;
      if (!(target instanceof HTMLMediaElement)) return;
      let sourcePath: string | null = null, revision: string | null = null;
      try {
        const source = new URL(target.currentSrc || target.src);
        if (/^\/content\/mediaTrack\/stream\/[a-f0-9]{24}$/.test(source.pathname)) {
          sourcePath = source.pathname;
          const candidate = source.searchParams.get('revision');
          if (candidate && /^mr_[a-f0-9]{32}$/.test(candidate)) revision = candidate;
        }
      } catch { /* An empty or unrecognized source has no diagnostic identity. */ }
      const observedAtMs = performance.now();
      records.push({ event: name, trusted: event.isTrusted, observedAtMs, capturedAtMs: performance.timeOrigin + observedAtMs,
        time: finite(target.currentTime), duration: finite(target.duration), playbackRate: finite(target.playbackRate),
        ready: target.readyState, network: target.networkState, paused: target.paused, seeking: target.seeking,
        error: target.error?.code ?? null, sourcePath, revision });
      if (records.length > 300) records.shift();
    }, true);
  }
});

/** Read the bounded observer buffer without touching playback. */
export const readMediaEventDiagnostics = (page: Page) => page.evaluate(() =>
  (window as DiagnosticWindow).__archtreeMediaEventDiagnostics ?? []);
