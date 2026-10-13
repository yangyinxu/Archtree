import { useEffect, useState, type ComponentType } from 'react';
import { useLocalization } from '../localization/LocalizationProvider';

/** Catalog entry remains available if loading the private Follow controls fails. */
export const LazyArtistFollowButton = ({ artistId }: { artistId: string }) => {
  const { t } = useLocalization();
  const [Control, setControl] = useState<ComponentType<{ artistId: string }>>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void import('./ArtistFollowButton').then(({ ArtistFollowButton }) => {
      if (active) setControl(() => ArtistFollowButton);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  return Control ? <Control artistId={artistId} /> : failed
    ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t('artist.follow_status_retry')}</button>
    : null;
};
