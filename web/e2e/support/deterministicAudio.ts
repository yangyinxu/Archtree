import type { Page } from '@playwright/test';

/** Provides media state events without depending on a headless runner's audio device. */
export const installDeterministicAudio = async (page: Page) => {
  await page.addInitScript(() => {
    const nativeAudio = window.Audio;
    const deterministicAudio = new Proxy(nativeAudio, {
      construct(target, argumentsList) {
        const audio = Reflect.construct(target, argumentsList) as HTMLAudioElement;
        let currentTime = 0;
        let paused = true;
        let source = '';

        Object.defineProperties(audio, {
          currentTime: {
            configurable: true,
            get: () => currentTime,
            set: (value: number) => { currentTime = value; }
          },
          duration: { configurable: true, get: () => 15 },
          error: { configurable: true, get: () => null },
          paused: { configurable: true, get: () => paused },
          src: {
            configurable: true,
            get: () => source,
            set: (value: string) => { source = new URL(value, window.location.href).href; }
          }
        });

        audio.load = () => {
          audio.dispatchEvent(new Event('loadstart'));
          queueMicrotask(() => {
            audio.dispatchEvent(new Event('loadedmetadata'));
            audio.dispatchEvent(new Event('durationchange'));
            audio.dispatchEvent(new Event('canplay'));
          });
        };
        audio.play = async () => {
          paused = false;
          audio.dispatchEvent(new Event('play'));
          audio.dispatchEvent(new Event('playing'));
        };
        audio.pause = () => {
          if (paused) return;
          paused = true;
          audio.dispatchEvent(new Event('pause'));
        };

        return audio;
      }
    });

    Object.defineProperty(window, 'Audio', {
      configurable: true,
      value: deterministicAudio,
      writable: true
    });
  });
};
