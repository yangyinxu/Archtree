import { createHash } from 'node:crypto';

/** Locale identity is canonical BCP 47; lowercase route segments keep existing URLs stable. */
export const engineeringLocales = [
  { locale: 'en-US', prefix: '', name: 'English' },
  { locale: 'zh-Hans', prefix: 'zh-hans', name: '简体中文' }
];

/** Visits only human-readable fields; commands, paths, source anchors and IDs stay authoritative. */
const visitText = (guide, visit) => {
  const sources = (entries, prefix) => entries?.forEach((entry, index) => visit(`${prefix}.${index}.label`, entry, 'label'));
  for (const page of guide.pages) {
    const prefix = `page.${page.slug ? page.slug.replaceAll('/', '.') : 'overview'}`;
    for (const field of ['title', 'eyebrow', 'description']) visit(`${prefix}.${field}`, page, field);
    for (const section of page.sections) {
      const key = `${prefix}.section.${section.id}`;
      visit(`${key}.title`, section, 'title');
      section.body?.forEach((_value, index) => visit(`${key}.body.${index}`, section.body, index));
      for (const collection of ['items', 'steps']) section[collection]?.forEach((entry, index) => {
        for (const field of ['title', 'text']) visit(`${key}.${collection}.${index}.${field}`, entry, field);
        sources(entry.sources, `${key}.${collection}.${index}.sources`);
      });
      sources(section.sources, `${key}.sources`);
      if (section.callout) for (const field of ['title', 'text']) visit(`${key}.callout.${field}`, section.callout, field);
    }
  }
};

/** Builds a stable translation key set from existing English documentation and interface copy. */
export const collectEngineeringMessages = (guide, ui) => {
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)
    || Object.entries(ui).some(([key, value]) => !key.startsWith('ui.') || typeof value !== 'string' || !value.trim())) {
    throw new Error('Engineering interface messages must be nonempty ui.* strings.');
  }
  const messages = { ...ui };
  visitText(guide, (key, object, field) => {
    if (Object.hasOwn(messages, key)) throw new Error(`Duplicate engineering translation key: ${key}`);
    messages[key] = object[field];
  });
  return Object.fromEntries(Object.entries(messages).sort(([left], [right]) => left.localeCompare(right, 'en')));
};

/** English changes require explicit translation review, including reordered editorial list entries. */
export const engineeringTranslationDigest = messages => createHash('sha256')
  .update(JSON.stringify(Object.entries(messages).sort(([left], [right]) => left.localeCompare(right, 'en')))).digest('hex');

const variables = value => [...new Set([...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]))].sort().join(',');

/** Refuses partial, stale or malformed translations before any published document is replaced. */
export const localizeEngineeringGuide = (guide, ui, translation) => {
  const english = collectEngineeringMessages(guide, ui);
  if (!translation || typeof translation !== 'object' || Array.isArray(translation)
    || Object.keys(translation).sort().join(',') !== 'locale,messages,schemaVersion,sourceDigest'
    || translation.schemaVersion !== 1 || translation.locale !== 'zh-Hans'
    || translation.sourceDigest !== engineeringTranslationDigest(english)) {
    throw new Error('Engineering translation is invalid or stale. Review it against the current English source.');
  }
  const messages = translation.messages;
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)
    || Object.keys(messages).sort().join('\n') !== Object.keys(english).sort().join('\n')) {
    throw new Error('Engineering translation keys must exactly match the English source.');
  }
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== 'string' || !value.trim() || value.length > 3000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      throw new Error(`Invalid engineering translation: ${key}`);
    }
    if (key.startsWith('ui.') && variables(value) !== variables(english[key])) {
      throw new Error(`Engineering translation variables do not match: ${key}`);
    }
  }
  const localized = structuredClone(guide);
  visitText(localized, (key, object, field) => { object[field] = messages[key]; });
  return { guide: localized, ui: Object.fromEntries(Object.keys(ui).map(key => [key, messages[key]])) };
};

/** Resolves language-specific topic links while leaving shared static assets unprefixed. */
export const engineeringPagePath = (slug = '', locale = 'en-US') => {
  const definition = engineeringLocales.find(entry => entry.locale === locale);
  if (!definition) throw new Error('Unsupported engineering locale.');
  return `/engineering${definition.prefix ? `/${definition.prefix}` : ''}${slug ? `/${slug}` : ''}`;
};
