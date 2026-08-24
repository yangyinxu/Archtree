import { describe, expect, test } from 'vitest';

import { embeddedManifest } from './contract';
import { directionForLocale, matchSupportedLocale, resolveLocalePreference } from './localeMatching';

describe('locale matching', () => {
  test('uses likely subtags for regional browser preferences', () => {
    expect(matchSupportedLocale(['zh-CN'], embeddedManifest)).toBe('zh-Hans');
    expect(matchSupportedLocale(['en-GB'], embeddedManifest)).toBe('en-US');
    expect(matchSupportedLocale(['fr-FR', 'zh-SG'], embeddedManifest)).toBe('zh-Hans');
  });

  test('keeps an explicit published choice and safely falls back otherwise', () => {
    expect(resolveLocalePreference('zh-Hans', embeddedManifest, ['en-US'])).toBe('zh-Hans');
    expect(resolveLocalePreference('fr-FR', embeddedManifest, ['zh-CN'])).toBe('en-US');
    expect(resolveLocalePreference('system', embeddedManifest, ['unknown-tag'])).toBe('en-US');
  });

  test('derives document direction from the locale language', () => {
    expect(directionForLocale('en-US')).toBe('ltr');
    expect(directionForLocale('ar-EG')).toBe('rtl');
    expect(directionForLocale('not_a_locale')).toBe('ltr');
  });
});
