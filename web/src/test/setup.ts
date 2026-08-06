import '@testing-library/jest-dom/vitest';

beforeEach(() => {
  vi.stubGlobal('navigator', {
    ...window.navigator,
    locks: {
      request: (
        _name: string,
        _options: { mode: 'exclusive' },
        callback: () => Promise<unknown>
      ) => callback()
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
