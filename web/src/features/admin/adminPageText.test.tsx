import { Suspense, type PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAdminPageText, useAlbumImportText } from './adminPageText';

const localization = vi.hoisted(() => ({
  locale: 'en-US',
  t: vi.fn((_key: string, _variables?: Record<string, string | number>) => 'Existing translated text')
}));

// Locale selection belongs to LocalizationProvider; this hook must react to its published locale.
vi.mock('../../localization/LocalizationProvider', async importOriginal => ({
  ...await importOriginal<typeof import('../../localization/LocalizationProvider')>(),
  useLocalization: () => localization
}));

beforeEach(() => { localization.locale = 'en-US'; localization.t.mockClear(); });
afterEach(() => cleanup());

/** Locale chunks are release-packaged but resolve asynchronously behind the route's Suspense boundary. */
async function mountText() {
  return act(async () => renderHook(useAdminPageText, { wrapper: ({ children }: PropsWithChildren) => <Suspense fallback={null}>{children}</Suspense> }));
}

test('Page counts use the scoped English plural rules for zero, one and several placements', async () => {
  const { result } = await mountText();
  await waitFor(() => expect(result.current).toEqual(expect.any(Function)));
  expect(result.current('pages.item_count', { count: 0 })).toBe('0 items');
  expect(result.current('pages.item_count', { count: 1 })).toBe('1 item');
  expect(result.current('pages.item_count', { count: 2 })).toBe('2 items');
});

test('an active locale change replaces Page copy and its cached number format without remounting the hook', async () => {
  const { result, rerender } = await mountText();
  await waitFor(() => expect(result.current).toEqual(expect.any(Function)));
  expect(result.current('pages.subtitle')).toBe('Manage placements on Home and Library.');
  expect(result.current('pages.item_count', { count: 1 })).toBe('1 item');
  localization.locale = 'zh-Hans'; await act(async () => rerender());
  await waitFor(() => expect(result.current('pages.subtitle')).toBe('管理首页与资料库的展示位置。'));
  expect(result.current('pages.item_count', { count: 1 })).toBe('1 个项目');
  expect(result.current('pages.confirm_stale')).toBe('此页面已更新。请关闭弹窗，刷新并重新核对后确认。');
  localization.locale = 'en-US'; await act(async () => rerender());
  await waitFor(() => expect(result.current('pages.item_count', { count: 1 })).toBe('1 item'));
});

test('a locale without release-packaged Page copy uses the complete English fallback and its number rules', async () => {
  localization.locale = 'fr-FR';
  const { result } = await mountText();
  await waitFor(() => expect(result.current).toEqual(expect.any(Function)));
  expect(result.current('pages.subtitle')).toBe('Manage placements on Home and Library.');
  expect(result.current('pages.item_count', { count: 1234 })).toBe('1,234 items');
  expect(result.current('pages.load_error')).toBe('Unable to load page items. Try again.');
});

test('operation captions retain the target name and action as literal message values', async () => {
  const { result, rerender } = await mountText();
  await waitFor(() => expect(result.current).toEqual(expect.any(Function)));
  const name = '<b>Untranslated title</b>';
  expect(result.current('pages.operation_target', { position: 2, name, action: 'Hide this placement' }))
    .toBe('2 · <b>Untranslated title</b>: Hide this placement');
  localization.locale = 'zh-Hans'; await act(async () => rerender());
  await waitFor(() => expect(result.current('pages.operation_target', { position: 2, name, action: '隐藏此位置' }))
    .toBe('2 · <b>Untranslated title</b>：隐藏此位置'));
});

test('existing administrator keys still delegate to the shared localization catalog with their variables', async () => {
  const { result } = await mountText();
  await waitFor(() => expect(result.current).toEqual(expect.any(Function)));
  const variables = { current: 'Public', next: 'Hidden' };
  expect(result.current('catalog.visibility_change', variables)).toBe('Existing translated text');
  expect(localization.t).toHaveBeenCalledExactlyOnceWith('admin.catalog.visibility_change', variables);
});

test('copy for adding files to an Album reads the release-packaged pack in each locale, while Page and other keys keep their sources', async () => {
  const { result, rerender } = await act(async () => renderHook(useAlbumImportText, { wrapper: ({ children }: PropsWithChildren) => <Suspense fallback={null}>{children}</Suspense> }));
  await waitFor(() => expect(result.current).toEqual(expect.any(Function)));
  expect(result.current('album_import.add')).toBe('Add files to this Album');
  expect(result.current('album_import.no_file_rows', { count: 1 })).toBe('1 row of its expected tracklist has no file yet.');
  expect(result.current('album_import.too_large', { max: 5000 })).toBe('Files cannot be added to this Album: an import can add files only to an Album with at most 5000 tracks.');
  // Page copy is not this hook's: it delegates to the runtime catalog like any other administrator key.
  expect(result.current('pages.subtitle')).toBe('Existing translated text');
  expect(localization.t).toHaveBeenCalledWith('admin.pages.subtitle', undefined);
  localization.locale = 'zh-Hans'; await act(async () => rerender());
  await waitFor(() => expect(result.current('album_import.add')).toBe('向此专辑添加文件'));
  expect(result.current('album_import.upload_missing')).toBe('为没有音频的曲目上传文件');
  expect(result.current('album_import.no_file_rows', { count: 2 })).toBe('完整曲目表中有 2 首曲目还没有音频。');
});

test('Page copy never reads the copy for adding files to an Album from the release-packaged pack', async () => {
  const { result } = await mountText();
  await waitFor(() => expect(result.current).toEqual(expect.any(Function)));
  expect(result.current('album_import.add')).toBe('Existing translated text');
});
