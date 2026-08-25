import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import zhBundleJson from '../../../localization/generated/bundles/zh-Hans.json';
import manifestJson from '../../../localization/generated/manifest.json';
import { LanguageSelector } from './LanguageSelector';
import { LocalizationProvider, useLocalization } from './LocalizationProvider';
import { localizationPreferenceStorageKey } from './storage';

const LocalizedProbe = () => {
  const { preference, systemLocale, t } = useLocalization();
  return (
    <>
      <output data-testid="localized-home">{t('shell.nav.home')}</output>
      <output data-testid="locale-preference">{preference}</output>
      <output data-testid="system-locale">{systemLocale}</output>
      <LanguageSelector />
    </>
  );
};

const response = (value: unknown, etag: string) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'Content-Type': 'application/json', ETag: etag }
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.removeAttribute('dir');
});

test('downloads, activates, persists, and restores a selected language', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    return path.includes('/bundles/zh-Hans')
      ? response(zhBundleJson, '"zh-bundle"')
      : response(manifestJson, '"manifest"');
  });
  vi.stubGlobal('fetch', fetchMock);

  const first = render(
    <LocalizationProvider>
      <LocalizedProbe />
    </LocalizationProvider>
  );
  expect(screen.getByTestId('localized-home')).toHaveTextContent('Home');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/localizations/v1/manifest',
    expect.any(Object)
  ));

  await user.click(screen.getByRole('button', {
    name: 'Change language. Current language: English (United States)'
  }));
  expect(screen.getByRole('dialog', { name: 'Choose your language' })).toBeInTheDocument();
  expect(screen.getByText('Choose a language for Finitude.')).toBeVisible();
  expect(screen.queryByRole('radio', { name: 'Browser default' })).not.toBeInTheDocument();
  expect(screen.getByRole('radio', {
    name: 'English (United States)'
  })).toHaveAccessibleDescription('English (United States)');
  const chineseOption = screen.getByRole('radio', { name: '简体中文' });
  expect(chineseOption).toHaveAccessibleDescription('Simplified Chinese');
  expect(screen.getByText('Simplified Chinese')).toBeVisible();
  await user.click(chineseOption);

  await waitFor(() => expect(screen.getByTestId('localized-home')).toHaveTextContent('首页'));
  expect(document.documentElement).toHaveAttribute('lang', 'zh-Hans');
  expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  expect(window.localStorage.getItem(localizationPreferenceStorageKey)).toBe('zh-Hans');
  expect(screen.getByTestId('locale-preference')).toHaveTextContent('zh-Hans');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  first.unmount();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(
    <LocalizationProvider>
      <LocalizedProbe />
    </LocalizationProvider>
  );
  expect(screen.getByTestId('localized-home')).toHaveTextContent('首页');
  expect(document.documentElement).toHaveAttribute('lang', 'zh-Hans');
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
});

test('starts in en-US when a new browser prefers Simplified Chinese', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('navigator', {
    ...navigator,
    language: 'zh-CN',
    languages: ['zh-CN']
  });
  vi.stubGlobal('fetch', vi.fn(async () => response(manifestJson, '"manifest"')));

  render(
    <LocalizationProvider>
      <LocalizedProbe />
    </LocalizationProvider>
  );

  expect(screen.getByTestId('localized-home')).toHaveTextContent('Home');
  expect(screen.getByTestId('locale-preference')).toHaveTextContent('en-US');
  expect(screen.getByTestId('system-locale')).toHaveTextContent('zh-Hans');
  expect(window.localStorage.getItem(localizationPreferenceStorageKey)).toBeNull();

  await user.click(screen.getByRole('button', {
    name: 'Change language. Current language: English (United States)'
  }));
  expect(screen.getByRole('radio', { name: 'English (United States)' })).toBeChecked();
  expect(screen.queryByRole('radio', { name: 'Browser default' })).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: '简体中文' })).toHaveAccessibleDescription(
    'Simplified Chinese'
  );
});

test('migrates a legacy Browser default preference to en-US', () => {
  vi.stubGlobal('navigator', {
    ...navigator,
    language: 'zh-CN',
    languages: ['zh-CN']
  });
  window.localStorage.setItem(localizationPreferenceStorageKey, 'system');
  vi.stubGlobal('fetch', vi.fn(async () => response(manifestJson, '"manifest"')));

  render(
    <LocalizationProvider>
      <LocalizedProbe />
    </LocalizationProvider>
  );

  expect(screen.getByTestId('localized-home')).toHaveTextContent('Home');
  expect(screen.getByTestId('locale-preference')).toHaveTextContent('en-US');
  expect(window.localStorage.getItem(localizationPreferenceStorageKey)).toBe('en-US');
});

test('keeps the active language when an explicit uncached download fails', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/bundles/zh-Hans')) {
      return new Response(JSON.stringify({ message: 'offline' }), { status: 503 });
    }
    return response(manifestJson, '"manifest"');
  }));
  render(
    <LocalizationProvider>
      <LocalizedProbe />
    </LocalizationProvider>
  );
  await user.click(await screen.findByRole('button', {
    name: 'Change language. Current language: English (United States)'
  }));
  await user.click(screen.getByRole('radio', { name: '简体中文' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    '简体中文 could not be downloaded'
  );
  expect(screen.getByTestId('localized-home')).toHaveTextContent('Home');
  expect(window.localStorage.getItem(localizationPreferenceStorageKey)).toBeNull();
});
