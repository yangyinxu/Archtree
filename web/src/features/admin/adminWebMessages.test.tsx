import { Suspense, type PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAdminWebMessages } from './adminWebMessages';

const localization = vi.hoisted(() => ({ locale: 'en-US', t: vi.fn(() => 'Existing translated text') }));
vi.mock('../../localization/LocalizationProvider', async importOriginal => ({
  ...await importOriginal<typeof import('../../localization/LocalizationProvider')>(),
  useLocalization: () => localization
}));

beforeEach(() => { localization.locale = 'en-US'; });
afterEach(() => cleanup());

/** The release-packaged web-admin copy resolves asynchronously behind a Suspense boundary. */
async function mountMessages() {
  return act(async () => renderHook(useAdminWebMessages, { wrapper: ({ children }: PropsWithChildren) => <Suspense fallback={null}>{children}</Suspense> }));
}

test('the active locale\'s web-admin bundle loads, and a locale without one reads the en-US bundle', async () => {
  const { result, rerender } = await mountMessages();
  await waitFor(() => expect(result.current?.locale).toBe('en-US'));
  expect(result.current!.messages['admin.lookup_evidence.step_barcode']).toBe('Search by the barcode in the file tags');
  localization.locale = 'zh-Hans'; await act(async () => rerender());
  await waitFor(() => expect(result.current?.locale).toBe('zh-Hans'));
  expect(result.current!.messages['admin.lookup_evidence.step_barcode']).toBe('按文件标签中的条码搜索');
  localization.locale = 'fr-FR'; await act(async () => rerender());
  await waitFor(() => expect(result.current?.locale).toBe('en-US'));
  expect(result.current!.messages['admin.lookup_evidence.chosen_barcode']).toBe('Chosen automatically: the barcode in the tags of every file.');
});
