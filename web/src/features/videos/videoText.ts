import en from '../../../../localization/generated/web-listener/bundles/en-US.json';
import zh from '../../../../localization/generated/web-listener/bundles/zh-Hans.json';
import type { formatLocalizedMessage } from '../../localization/LocalizationProvider';
import type { MessageVariables } from '../../localization/contract';

type VideoMessageKey = keyof typeof en.messages;

/** Keeps release copy pure: optional chunks receive the active locale and existing ICU formatter. */
export const videoTextFor = (locale: string, format: typeof formatLocalizedMessage) => {
  const bundle = locale === 'zh-Hans' ? zh : en;
  return (key: VideoMessageKey, variables?: MessageVariables) => format(bundle, key, variables);
};
