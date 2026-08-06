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
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const ownerKey = `${viewerId ?? 'signed-out'}:${target.contentType}:${target.contentId}`;
  const ownerRef = useRef(ownerKey);
  const visibleMessage = ownerRef.current === ownerKey ? message : '';
  const mutation = useMutation({
    mutationFn: () => saved
      ? unsaveContent(viewerId ?? '', target)
      : saveContent(viewerId ?? '', target),
    onMutate: () => captureAccountOperation(viewerId ?? ''),
    onSuccess: (result, _variables, guard) => {
      if (!isAccountOperationCurrent(guard, viewerId ?? '')) return;
      setMessage(result.saved ? 'Saved to your Library.' : 'Removed from your Library.');
      onSavedChange?.(result.saved);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['listener', 'home'] }),
        queryClient.invalidateQueries({ queryKey: ['listener', 'library'] }),
        queryClient.invalidateQueries({ queryKey: ['listener', 'save-statuses'] })
      ]);
    },
    onError: (_error, _variables, guard) => {
      if (isAccountOperationCurrent(guard, viewerId ?? '')) {
        setMessage('Finitude could not update your Library. Try again.');
      }
    }
  });

  useEffect(() => {
    ownerRef.current = ownerKey;
    setMessage('');
    mutation.reset();
  }, [ownerKey]);

  const signedOut = !viewerId;
  const label = saved ? 'Remove from Library' : 'Save to Library';
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
            setMessage('Log in to save albums and soundtracks.');
            return;
          }
          if (saved === null || mutation.isPending) return;
          setMessage('');
          mutation.mutate();
        }}
        type="button"
      >
        {saved ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
        {!compact && <span>{mutation.isPending ? 'Updating…' : label}</span>}
      </button>
      {visibleMessage && <span className={styles.message} role={mutation.isError || signedOut ? 'alert' : 'status'}>{visibleMessage}</span>}
    </span>
  );
};
