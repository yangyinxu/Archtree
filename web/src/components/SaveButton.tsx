import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bookmark, BookmarkCheck } from 'lucide-react';

import {
  saveContent,
  unsaveContent
} from '../api/listener';
import type { LibraryTarget } from '../api/contentSchemas';
import { captureAccountOperation, isAccountOperationCurrent } from '../api/accountEpoch';
import styles from './SaveButton.module.css';
import { useLocalization } from '../localization/LocalizationProvider';

export interface SaveButtonProps {
  target: LibraryTarget;
  viewerId?: string | null;
  saved: boolean | null;
  onSavedChange?: (saved: boolean) => void;
  compact?: boolean;
}

/** Confirms server mutations before changing Save state and preserves the signed-out prompt. */
export const SaveButton = ({
  target,
  viewerId,
  saved,
  onSavedChange,
  compact = false
}: SaveButtonProps) => {
  const { t } = useLocalization();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const ownerKey = `${viewerId ?? 'signed-out'}:${target.contentType}:${target.contentId}`;
  const ownerRef = useRef(ownerKey);
  const activeOwnerRef = useRef(ownerKey);
  activeOwnerRef.current = ownerKey;
  const visibleMessage = ownerRef.current === ownerKey ? message : '';
  const mutation = useMutation({
    mutationFn: (variables: { viewerId: string; target: LibraryTarget; saved: boolean; ownerKey: string }) => variables.saved
      ? unsaveContent(variables.viewerId, variables.target)
      : saveContent(variables.viewerId, variables.target),
    onMutate: (variables) => captureAccountOperation(variables.viewerId),
    onSuccess: async (result, variables, guard) => {
      if (!isAccountOperationCurrent(guard, variables.viewerId)) return;
      // The reconciliation path is needed only after an explicit successful write.
      const { commitSaveStatus } = await import('../api/saveCache');
      if (!await commitSaveStatus(queryClient, result, guard)) return;
      if (activeOwnerRef.current === variables.ownerKey) {
        setMessage(result.saved ? t('save.status.saved') : t('save.status.removed'));
        onSavedChange?.(result.saved);
      }
    },
    onError: (_error, variables, guard) => {
      if (isAccountOperationCurrent(guard, variables.viewerId) && activeOwnerRef.current === variables.ownerKey) {
        setMessage(t('save.error.update'));
      }
    }
  });

  useEffect(() => {
    ownerRef.current = ownerKey;
    setMessage('');
    mutation.reset();
  }, [ownerKey]);

  const signedOut = !viewerId;
  const label = saved ? t('save.action.remove') : t('save.action.save');
  // A signed-out activation is available because its outcome is the explanatory alert.
  const actionUnavailable = saved === null || mutation.isPending;

  return (
    <span className={`${styles.wrapper} ${compact ? styles.compact : ''}`}>
      <button
        aria-disabled={actionUnavailable}
        aria-label={label}
        className={`${styles.button} ${signedOut ? styles.signedOut : ''}`}
        onClick={() => {
          if (signedOut) {
            setMessage(t('save.status.signed_out'));
            return;
          }
          if (saved === null || mutation.isPending) return;
          setMessage('');
          mutation.mutate({ viewerId: viewerId!, target, saved, ownerKey });
        }}
        type="button"
      >
        {saved ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
        {!compact && <span>{mutation.isPending ? t('save.status.updating') : label}</span>}
      </button>
      {visibleMessage && <span className={styles.message} role={mutation.isError || signedOut ? 'alert' : 'status'}>{visibleMessage}</span>}
    </span>
  );
};
