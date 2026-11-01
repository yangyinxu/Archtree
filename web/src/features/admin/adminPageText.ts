import { Component, use, type ReactNode } from 'react';
import { formatLocalizedMessage, useLocalization } from '../../localization/LocalizationProvider';
import type { MessageVariables } from '../../localization/contract';
import { useAdminText } from './AdminAccess';

const bundles = new Map(Object.entries(import.meta.glob<Record<string, string>>(
  '../../../../localization/generated/web-admin/bundles/*.json', { import: 'messages' }
)).map(([path, loader]) => [path.split('/').at(-1)!.replace(/\.json$/, ''), loader]));
const loaded = new Map<string, Promise<Record<string, string>>>();

/**
 * Suspends until the complete selected locale is ready; no mixed-language approval can be submitted. A pack that fails to load
 * is forgotten, so a later render loads it again.
 */
function messagesFor(locale: string) {
  let pending = loaded.get(locale);
  if (!pending) {
    const request = bundles.get(locale)!();
    request.catch(() => { if (loaded.get(locale) === request) loaded.delete(locale); });
    loaded.set(locale, pending = request);
  }
  return pending;
}

/**
 * Renders `fallback` (nothing by default) in place of its children once they fail, such as when the release-packaged copy they
 * read cannot load: an optional control or line then disappears instead of replacing the whole page with the route's error.
 */
export class DeliveryTextBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback ?? null : this.props.children; }
}

/**
 * Release-packaged administrator copy (`web-admin` delivery) for keys under one of `prefixes`, each read as `admin.<key>`; any
 * other key reads the runtime administrator copy. Canonically generated, so this copy never expands older native runtime
 * bundles. Suspends until the selected locale's pack is loaded, so callers render inside Suspense.
 */
export function useAdminDeliveryText(prefixes: readonly string[]) {
  const existing = useAdminText(), { locale } = useLocalization();
  const formatLocale = bundles.has(locale) ? locale : 'en-US';
  const messages = use(messagesFor(formatLocale));
  return (key: string, variables?: MessageVariables) => {
    if (!prefixes.some(prefix => key.startsWith(prefix))) return existing(key, variables);
    const name = 'admin.' + key;
    return formatLocalizedMessage({ locale: formatLocale, messages }, name, variables);
  };
}
const PAGE_KEYS = ['pages.'] as const, ALBUM_IMPORT_KEYS = ['album_import.'] as const;
/** Page-management copy. */
export const useAdminPageText = () => useAdminDeliveryText(PAGE_KEYS);
/** Copy for adding files to an existing Album: the Album page's links, the create page's target and the summary's next step. */
export const useAlbumImportText = () => useAdminDeliveryText(ALBUM_IMPORT_KEYS);
