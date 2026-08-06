import { expect, test as base } from '@playwright/test';

import {
  installSignedOutApi,
  type BrowserApiFixture
} from './apiRoutes';

interface BrowserFixtures {
  api: BrowserApiFixture;
}

/** Gives each test a fresh browser context and rejects any undeclared API request. */
export const test = base.extend<BrowserFixtures>({
  api: [async ({ page }, use) => {
    const api = await installSignedOutApi(page);
    await use(api);

    if (api.unhandled.length > 0) {
      throw new Error(`Unhandled browser-test requests:\n${JSON.stringify(api.unhandled, null, 2)}`);
    }
  }, { auto: true }]
});

export { expect };
