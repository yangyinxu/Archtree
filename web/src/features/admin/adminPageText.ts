import { use } from 'react';
import { formatLocalizedMessage, useLocalization } from '../../localization/LocalizationProvider';
import type { MessageVariables } from '../../localization/contract';
import { useAdminText } from './AdminAccess';

const bundles = new Map(Object.entries(import.meta.glob<Record<string, string>>(
  '../../../../localization/generated/web-admin/bundles/*.json', { import: 'messages' }
)).map(([path, loader]) => [path.split('/').at(-1)!.replace(/\.json$/, ''), loader]));
const loaded = new Map<string, Promise<Record<string, string>>>();

/** Suspends until the complete selected locale is ready; no mixed-language approval can be submitted. */
function messagesFor(locale: string) {
  let pending = loaded.get(locale);
  if (!pending) { pending = bundles.get(locale)!(); loaded.set(locale, pending); }
  return pending;
}

/** Canonically generated, release-packaged Page copy avoids expanding older native runtime bundles. */
export function useAdminPageText() {
  const existing = useAdminText(), { locale } = useLocalization();
  const formatLocale = bundles.has(locale) ? locale : 'en-US';
  const messages = use(messagesFor(formatLocale));
  return (key: string, variables?: MessageVariables) => {
    if (!key.startsWith('pages.')) return existing(key, variables);
    const name = 'admin.' + key;
    return formatLocalizedMessage({ locale: formatLocale, messages }, name, variables);
  };
}
