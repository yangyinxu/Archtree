import { act } from '@testing-library/react';

/**
 * Captures the detail hero's IntersectionObserver so tests can scroll the hero out from under the
 * compact header (CompactCatalogHeader) and back.
 */
export const observeHero = () => {
  const observers: Array<{
    callback: IntersectionObserverCallback;
    options?: IntersectionObserverInit;
    targets: Element[];
    disconnected: boolean;
  }> = [];
  vi.stubGlobal('IntersectionObserver', class {
    record: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, options, targets: [], disconnected: false };
      observers.push(this.record);
    }
    observe(target: Element) { this.record.targets.push(target); }
    disconnect() { this.record.disconnected = true; }
  });
  const entry = (top: number, isIntersecting: boolean) => ({
    isIntersecting,
    boundingClientRect: { top } as DOMRectReadOnly,
    rootBounds: { top: 64 } as DOMRectReadOnly
  } as IntersectionObserverEntry);
  /** Delivers queued crossings, oldest first, as one observer callback. */
  const deliver = (...crossings: Array<[top: number, isIntersecting: boolean]>) => act(() => {
    observers.at(-1)!.callback(crossings.map(([top, isIntersecting]) => entry(top, isIntersecting)), {} as IntersectionObserver);
  });
  return {
    observers,
    deliver,
    scrollHeroOut: () => deliver([-420, false]),
    scrollHeroBack: () => deliver([-20, true])
  };
};
