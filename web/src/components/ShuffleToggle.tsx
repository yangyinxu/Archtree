import { useSyncExternalStore } from 'react';

import { useLocalization } from '../localization/LocalizationProvider';
import { playerStore } from '../player';
import { Icon } from './Icon';
import h from './DetailHero.module.css';

const shuffleEnabled = () => playerStore.getSnapshot().shuffleEnabled;

/**
 * Detail-page Shuffle: mirrors and flips the shared player's shuffle state, exactly like the
 * player bar's control (a no-op inside a Room). It never changes which MediaTrack Play starts from.
 */
export const ShuffleToggle = ({ disabled }: { disabled?: boolean }) => {
  const { t } = useLocalization();
  const on = useSyncExternalStore(playerStore.subscribe, shuffleEnabled, shuffleEnabled);
  return (
    <button
      aria-label={on ? t('player.shuffle.disable') : t('player.shuffle.enable')}
      aria-pressed={on}
      className={h.iconAction}
      disabled={disabled}
      onClick={() => playerStore.toggleShuffle()}
      title={on ? t('player.shuffle.on') : t('player.shuffle.off')}
      type="button"
    >
      <Icon name="shuffle" />
    </button>
  );
};
