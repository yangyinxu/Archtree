import { use } from 'react';
import { useLocalization } from '../../localization/LocalizationProvider';

const bundles = new Map(Object.entries(import.meta.glob<Record<string, string>>(
  '../../../../localization/generated/web-admin/bundles/*.json', { import: 'messages' }
)).map(([path, loader]) => [path.split('/').at(-1)!.replace(/\.json$/, ''), loader]));
const settled = new Map<string, Promise<Record<string, string> | null>>();

/** One load per locale for the session; a bundle that cannot load settles as null, never as an error. */
function messagesFor(locale: string) {
  let pending = settled.get(locale);
  if (!pending) {
    const loader = bundles.get(locale);
    pending = loader ? loader().then(messages => messages, () => null) : Promise.resolve(null);
    settled.set(locale, pending);
  }
  return pending;
}

/**
 * The release-packaged `web-admin` copy of the active locale (en-US when it has no bundle) for supplementary administrator words
 * that may be left out: suspends until the bundle loads, and returns null when it cannot load, so the caller asks for a reload
 * instead of failing the page. It reads the same generated bundles as the Page copy (adminPageText.ts), so both share their chunks.
 */
export function useAdminWebMessages(): { locale: string; messages: Record<string, string> } | null {
  const { locale } = useLocalization();
  const formatLocale = bundles.has(locale) ? locale : 'en-US';
  const messages = use(messagesFor(formatLocale));
  return messages ? { locale: formatLocale, messages } : null;
}
