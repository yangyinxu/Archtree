import { lazy, Suspense, useState } from 'react';
import { Bookmark, BookmarkCheck } from 'lucide-react';

import type { SaveButtonProps } from '../../components/SaveButton';
import styles from '../../components/SaveButton.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

/** Keeps Save reachable on stale tabs without ever dispatching an unguarded fallback mutation. */
const SaveFallback = ({ compact, saved, viewerId, target, pending = false }: SaveButtonProps & { pending?: boolean }) => {
  const { t } = useLocalization();
  const [failedOwner, setFailedOwner] = useState('');
  const owner = `${viewerId ?? ''}:${target.contentType}:${target.contentId}`;
  const label = pending ? t('save.status.updating') : t(saved ? 'save.action.remove' : 'save.action.save');
  return <span className={`${styles.wrapper} ${compact ? styles.compact : ''}`}>
    <button aria-label={label} className={styles.button} disabled={pending}
      onClick={() => setFailedOwner(owner)} type="button">
      {saved ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
      {!compact && <span>{label}</span>}
    </button>
    {!pending && failedOwner === owner && <span className={styles.message} role="alert">{t('save.error.update')}</span>}
  </span>;
};

const SaveButton = lazy(() => import('../../components/SaveButton')
  .then((module) => ({ default: module.SaveButton }))
  .catch(() => ({ default: SaveFallback })));

/** Leaves the existing account-guarded Save implementation in its own dynamic chunk. */
export const VideoCardSave = (props: SaveButtonProps) => (
  <Suspense fallback={<SaveFallback {...props} pending />}>
    <SaveButton {...props} />
  </Suspense>
);
