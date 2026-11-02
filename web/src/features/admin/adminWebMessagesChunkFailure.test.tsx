import { Suspense, type PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAdminWebMessages } from './adminWebMessages';

vi.mock('../../localization/LocalizationProvider', async importOriginal => ({
  ...await importOriginal<typeof import('../../localization/LocalizationProvider')>(),
  useLocalization: () => ({ locale: 'en-US', t: () => 'Existing translated text' })
}));
// The packaged bundle's chunk cannot load, as after a deploy removed it.
vi.mock('../../../../localization/generated/web-admin/bundles/en-US.json', () => { throw new Error('Synthetic chunk failure'); });
afterEach(() => cleanup());

test('a web-admin bundle that cannot load reads as null instead of failing the page', async () => {
  const { result } = await act(async () => renderHook(useAdminWebMessages, { wrapper: ({ children }: PropsWithChildren) => <Suspense fallback={<p>loading</p>}>{children}</Suspense> }));
  await waitFor(() => expect(result.current).toBeNull());
});
