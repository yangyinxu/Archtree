import { expect, test } from 'vitest';

import zhBundle from '../../../localization/generated/bundles/zh-Hans.json';
import { parseCompatibleBundle } from './contract';

test('rejects a downloaded bundle with a changed named-variable contract', () => {
  expect(() => parseCompatibleBundle({
    ...zhBundle,
    messages: {
      ...zhBundle.messages,
      'language.button.change': '修改语言：{unexpected}'
    }
  })).toThrow(/named-variable contract/);
});

test('rejects malformed ICU and rich-text messages before activation', () => {
  expect(() => parseCompatibleBundle({
    ...zhBundle,
    messages: {
      ...zhBundle.messages,
      'playlist.summary.label': '{count, plural, one {一项}}'
    }
  })).toThrow();
  expect(() => parseCompatibleBundle({
    ...zhBundle,
    messages: {
      ...zhBundle.messages,
      'shell.nav.home': '<strong>首页</strong>'
    }
  })).toThrow(/plain text/);
});
