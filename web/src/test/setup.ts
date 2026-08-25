import '@testing-library/jest-dom/vitest';
import IntlMessageFormat from 'intl-messageformat';

import fallbackBundle from '../../../localization/generated/bundles/en-US.json';
import { installBundleValidation } from '../localization/bundleValidation';
import { installMessageFormatter } from '../localization/LocalizationProvider';
import { installEmbeddedFallback } from '../localization/contract';

installEmbeddedFallback(fallbackBundle);
installBundleValidation(IntlMessageFormat);
installMessageFormatter(IntlMessageFormat);

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
