import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  deleteAvatar,
  replaceAvatar,
  type AvatarMutationResult
} from '../../../api/avatar';
import { ApiError } from '../../../api/client';
import { getBrowserSession } from '../../../api/session';
import { browserSessionQueryKey } from '../../../api/session';
import type { BrowserSession, BrowserSessionUser } from '../../../api/schemas';
import { Avatar } from '../../../components/Avatar';
import { AvatarCropDialog } from './AvatarCropDialog';
import { useModalFocus } from './useModalFocus';
import styles from './AvatarSettings.module.css';

const acceptedAvatarTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maximumAvatarBytes = 5 * 1024 * 1024;

export type AvatarAccountUser = Pick<
  BrowserSessionUser,
  'id' | 'displayName' | 'email' | 'avatar' | 'avatarRevision'
>;

export interface AvatarSettingsProps {
  user: AvatarAccountUser;
  onAvatarChange?: (result: AvatarMutationResult) => void;
}

interface MutationInput {
  viewerId: string;
  revision: number;
}

interface UploadInput extends MutationInput {
  jpeg: Blob;
}

const failureMessage = (error: unknown, operation: 'upload' | 'delete') => {
  const preserved = operation === 'upload'
    ? 'Your current photo has not changed. Select a photo again to restart.'
    : 'Your current photo remains in place.';
  if (!(error instanceof ApiError)) {
    return `Finitude could not confirm the profile photo change. ${preserved}`;
  }
  if (error.status === 409) {
    return `The photo changed elsewhere, so Finitude reloaded the latest profile. ${preserved}`;
  }
  if (error.status === 413) {
    return `The selected photo exceeds the 5 MB upload limit. ${preserved}`;
  }
  if (error.status === 400) {
    return `The selected photo was rejected. Choose a different JPG, PNG, or WebP photo. ${preserved}`;
  }
  if (error.status === 401 || error.status === 403) {
    return `Your session expired before the change was confirmed. ${preserved}`;
  }
  if (error.status === 429) {
    return `Too many photo requests were sent. Wait a moment before starting again. ${preserved}`;
  }
  return `Archtree could not confirm the profile photo change. ${preserved}`;
};

/** Updates only the still-active viewer's authoritative session projection. */
const mergeAvatarResult = (
  current: BrowserSession | null | undefined,
  viewerId: string,
  result: AvatarMutationResult
) => {
  if (!current || current.user.id !== viewerId) return current;
  return {
    user: {
      ...current.user,
      avatarRevision: result.avatarRevision,
      avatar: result.avatar
        ? { assetId: result.avatar.assetId, revision: result.avatar.revision }
        : null
    }
  };
};

const AvatarDeleteDialog = ({
  isDeleting,
  onCancel,
  onConfirm,
  returnFocusRef,
  fallbackFocusRef
}: {
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef: RefObject<HTMLButtonElement | null>;
}) => {
  const dialogRef = useRef<HTMLElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  useModalFocus(dialogRef, keepButtonRef, returnFocusRef, fallbackFocusRef);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isDeleting) onCancel();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [isDeleting, onCancel]);

  return (
    <div className={styles.overlay} role="presentation">
      <section
        aria-labelledby="remove-avatar-title"
        aria-modal="true"
        className={styles.confirmDialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <p className={styles.kicker}>Profile photo</p>
        <h2 id="remove-avatar-title">Remove your photo?</h2>
        <p className={styles.instructions}>Your initials will be shown instead. The photo is cleared only after Archtree confirms deletion.</p>
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} disabled={isDeleting} onClick={onCancel} ref={keepButtonRef} type="button">Keep photo</button>
          <button className={styles.dangerButton} disabled={isDeleting} onClick={onConfirm} type="button">
            {isDeleting ? 'Removing…' : 'Remove photo'}
          </button>
        </div>
      </section>
    </div>
  );
};

/** Presents the complete select, crop, preview, confirm, and delete avatar lifecycle. */
export const AvatarSettings = ({ user, onAvatarChange }: AvatarSettingsProps) => {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const candidateUrlRef = useRef('');
  const previousViewerRef = useRef(user.id);
  const activeViewerRef = useRef(user.id);
  activeViewerRef.current = user.id;
  const [candidateUrl, setCandidateUrl] = useState('');
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const discardCandidate = () => {
    if (candidateUrlRef.current) URL.revokeObjectURL(candidateUrlRef.current);
    candidateUrlRef.current = '';
    setCandidateUrl('');
  };

  const commitResult = (viewerId: string, result: AvatarMutationResult) => {
    queryClient.setQueryData<BrowserSession | null>(browserSessionQueryKey, (current) => (
      mergeAvatarResult(current, viewerId, result)
    ));
    queryClient.removeQueries({ queryKey: ['account', viewerId, 'avatar'] });
    if (activeViewerRef.current === viewerId) onAvatarChange?.(result);
  };

  const reconcileConflict = async (error: unknown, viewerId: string) => {
    if (!(error instanceof ApiError) || error.status !== 409) return;
    try {
      const latest = await getBrowserSession();
      if (latest?.user.id !== viewerId || activeViewerRef.current !== viewerId) return;
      queryClient.setQueryData(browserSessionQueryKey, latest);
      queryClient.removeQueries({ queryKey: ['account', viewerId, 'avatar'] });
    } catch {
      // The existing confirmed avatar remains the safest display if reconciliation is unavailable.
    }
  };

  const upload = useMutation({
    mutationFn: ({ jpeg, revision, viewerId }: UploadInput) => replaceAvatar(
      jpeg,
      revision,
      viewerId
    ),
    onSuccess: (result, variables) => {
      commitResult(variables.viewerId, result);
      if (activeViewerRef.current === variables.viewerId) {
        setFeedback({
          kind: 'success',
          message: result.cleanupPending
            ? 'Profile photo updated. Archtree will continue cleaning up the previous photo.'
            : 'Profile photo updated.'
        });
      }
    },
    onError: async (error, variables) => {
      await reconcileConflict(error, variables.viewerId);
      if (activeViewerRef.current === variables.viewerId) {
        setFeedback({ kind: 'error', message: failureMessage(error, 'upload') });
      }
    }
  });

  const removal = useMutation({
    mutationFn: ({ revision, viewerId }: MutationInput) => deleteAvatar(revision, viewerId),
    onSuccess: (result, variables) => {
      commitResult(variables.viewerId, result);
      if (activeViewerRef.current === variables.viewerId) {
        setIsConfirmingDelete(false);
        setFeedback({ kind: 'success', message: 'Profile photo removed.' });
      }
    },
    onError: async (error, variables) => {
      await reconcileConflict(error, variables.viewerId);
      if (activeViewerRef.current === variables.viewerId) {
        setIsConfirmingDelete(false);
        setFeedback({ kind: 'error', message: failureMessage(error, 'delete') });
      }
    }
  });

  useEffect(() => {
    if (previousViewerRef.current === user.id) return;
    previousViewerRef.current = user.id;
    discardCandidate();
    setIsConfirmingDelete(false);
    setFeedback(null);
    upload.reset();
    removal.reset();
  }, [user.id]);

  useEffect(() => () => {
    if (candidateUrlRef.current) URL.revokeObjectURL(candidateUrlRef.current);
  }, []);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const [file] = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!file) return;
    setFeedback(null);
    if (!acceptedAvatarTypes.has(file.type)) {
      setFeedback({ kind: 'error', message: 'Choose a JPG, PNG, or WebP photo.' });
      return;
    }
    if (file.size > maximumAvatarBytes) {
      setFeedback({ kind: 'error', message: 'Choose a photo smaller than 5 MB.' });
      return;
    }
    discardCandidate();
    const source = URL.createObjectURL(file);
    candidateUrlRef.current = source;
    setCandidateUrl(source);
  };

  const confirmCrop = (jpeg: Blob) => {
    const variables = { jpeg, viewerId: user.id, revision: user.avatarRevision };
    discardCandidate();
    setFeedback(null);
    upload.mutate(variables);
  };

  const busy = upload.isPending || removal.isPending;
  const accountStateIsCurrent = previousViewerRef.current === user.id;

  return (
    <section aria-labelledby="profile-photo-title" className={styles.settings} ref={settingsRef} tabIndex={-1}>
      <Avatar
        ariaLabel="Current profile photo"
        avatar={user.avatar}
        displayName={user.displayName}
        email={user.email}
        size="large"
        viewerId={user.id}
      />
      <div className={styles.settingsCopy}>
        <h2 id="profile-photo-title">Profile photo</h2>
        <p>Your photo is private to your account. Crop changes are uploaded only after you confirm the circular preview.</p>
      </div>
      <div className={styles.settingsActions}>
        <input
          accept="image/jpeg,image/png,image/webp"
          aria-label="Choose profile photo"
          className={styles.fileInput}
          disabled={busy}
          onChange={chooseFile}
          ref={inputRef}
          type="file"
        />
        <button className={styles.primaryButton} disabled={busy} onClick={() => inputRef.current?.click()} ref={changeButtonRef} type="button">
          {upload.isPending ? 'Uploading…' : 'Change photo'}
        </button>
        {user.avatar && (
          <button className={styles.textDangerButton} disabled={busy} onClick={() => setIsConfirmingDelete(true)} ref={removeButtonRef} type="button">
            Remove photo
          </button>
        )}
      </div>
      <div aria-live="polite" className={styles.feedback}>
        {accountStateIsCurrent && feedback && (
          <p className={feedback.kind === 'error' ? styles.error : styles.success} role={feedback.kind === 'error' ? 'alert' : 'status'}>
            {feedback.message}
          </p>
        )}
      </div>

      {accountStateIsCurrent && candidateUrl && (
        <AvatarCropDialog
          fallbackFocusRef={settingsRef}
          onCancel={discardCandidate}
          onUsePhoto={confirmCrop}
          returnFocusRef={changeButtonRef}
          sourceUrl={candidateUrl}
        />
      )}
      {accountStateIsCurrent && isConfirmingDelete && (
        <AvatarDeleteDialog
          isDeleting={removal.isPending}
          onCancel={() => setIsConfirmingDelete(false)}
          onConfirm={() => {
            setFeedback(null);
            removal.mutate({ viewerId: user.id, revision: user.avatarRevision });
          }}
          fallbackFocusRef={changeButtonRef}
          returnFocusRef={removeButtonRef}
        />
      )}
    </section>
  );
};
