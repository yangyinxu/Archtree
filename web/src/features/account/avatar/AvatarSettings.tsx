import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';

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
import {
  useLocalization,
  type LocalizationContextValue
} from '../../../localization/LocalizationProvider';
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

const failureMessage = (
  error: unknown,
  operation: 'upload' | 'delete',
  t: LocalizationContextValue['t']
) => {
  const preserved = operation === 'upload'
    ? t('avatar.preserved.upload')
    : t('avatar.preserved.delete');
  if (!(error instanceof ApiError)) {
    return t('avatar.error.unconfirmed', { preserved });
  }
  if (error.status === 409) {
    return t('avatar.error.conflict', { preserved });
  }
  if (error.status === 413) {
    return t('avatar.error.too_large', { preserved });
  }
  if (error.status === 400) {
    return t('avatar.error.rejected', { preserved });
  }
  if (error.status === 401 || error.status === 403) {
    return t('avatar.error.session', { preserved });
  }
  if (error.status === 429) {
    return t('avatar.error.rate', { preserved });
  }
  return t('avatar.error.server', { preserved });
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
  const { t } = useLocalization();
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
        <p className={styles.kicker}>{t('avatar.delete.kicker')}</p>
        <h2 id="remove-avatar-title">{t('avatar.delete.title')}</h2>
        <p className={styles.instructions}>{t('avatar.delete.description')}</p>
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} disabled={isDeleting} onClick={onCancel} ref={keepButtonRef} type="button">{t('avatar.delete.keep')}</button>
          <button className={styles.dangerButton} disabled={isDeleting} onClick={onConfirm} type="button">
            {isDeleting ? t('avatar.delete.removing') : t('avatar.delete.remove')}
          </button>
        </div>
      </section>
    </div>
  );
};

/** Presents the complete select, crop, preview, confirm, and delete avatar lifecycle. */
export const AvatarSettings = ({ user, onAvatarChange }: AvatarSettingsProps) => {
  const { t } = useLocalization();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
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
            ? t('avatar.updated_cleanup')
            : t('avatar.updated')
        });
      }
    },
    onError: async (error, variables) => {
      await reconcileConflict(error, variables.viewerId);
      if (activeViewerRef.current === variables.viewerId) {
        setFeedback({ kind: 'error', message: failureMessage(error, 'upload', t) });
      }
    }
  });

  const removal = useMutation({
    mutationFn: ({ revision, viewerId }: MutationInput) => deleteAvatar(revision, viewerId),
    onSuccess: (result, variables) => {
      commitResult(variables.viewerId, result);
      if (activeViewerRef.current === variables.viewerId) {
        setIsConfirmingDelete(false);
        setFeedback({ kind: 'success', message: t('avatar.removed') });
      }
    },
    onError: async (error, variables) => {
      await reconcileConflict(error, variables.viewerId);
      if (activeViewerRef.current === variables.viewerId) {
        setIsConfirmingDelete(false);
        setFeedback({ kind: 'error', message: failureMessage(error, 'delete', t) });
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
      setFeedback({ kind: 'error', message: t('avatar.choose_type') });
      return;
    }
    if (file.size > maximumAvatarBytes) {
      setFeedback({ kind: 'error', message: t('avatar.choose_size') });
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
      <button
        aria-busy={upload.isPending}
        aria-label={t('avatar.edit_label')}
        className={styles.avatarButton}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        ref={avatarButtonRef}
        type="button"
      >
        <Avatar
          avatar={user.avatar}
          displayName={user.displayName}
          email={user.email}
          size="large"
          viewerId={user.id}
        />
        <span aria-hidden="true" className={styles.avatarEditOverlay}>
          <Pencil aria-hidden="true" focusable="false" strokeWidth={2.1} />
        </span>
      </button>
      <input
        accept="image/jpeg,image/png,image/webp"
        aria-label={t('avatar.choose_label')}
        disabled={busy}
        hidden
        onChange={chooseFile}
        ref={inputRef}
        type="file"
      />
      <div className={styles.settingsCopy}>
        <h2 id="profile-photo-title">{t('avatar.heading')}</h2>
        <p>{t('avatar.description')}</p>
      </div>
      {user.avatar && (
        <div className={styles.settingsActions}>
          <button className={styles.textDangerButton} disabled={busy} onClick={() => setIsConfirmingDelete(true)} ref={removeButtonRef} type="button">
            {t('avatar.delete.remove')}
          </button>
        </div>
      )}
      <div aria-live="polite" className={styles.feedback}>
        {accountStateIsCurrent && upload.isPending ? (
          <p className={styles.progress} role="status">{t('avatar.uploading')}</p>
        ) : accountStateIsCurrent && feedback && (
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
          returnFocusRef={avatarButtonRef}
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
          fallbackFocusRef={avatarButtonRef}
          returnFocusRef={removeButtonRef}
        />
      )}
    </section>
  );
};
