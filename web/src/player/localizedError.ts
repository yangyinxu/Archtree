import type { LocalizationContextValue } from '../localization/LocalizationProvider';
import type { MessageKey } from '../localization/contract';
import type { PlayerErrorCode } from './types';

const messageKeys: Record<PlayerErrorCode, MessageKey> = {
  autoplayBlocked: 'player.error.autoplay_blocked',
  decode: 'player.error.decode',
  network: 'player.error.network',
  streamUnavailable: 'player.error.stream_unavailable',
  unknown: 'player.error.unknown'
};

/** Converts stable playback failure codes into copy from the active locale. */
export const localizedPlayerError = (
  code: PlayerErrorCode,
  t: LocalizationContextValue['t']
) => t(messageKeys[code]);
