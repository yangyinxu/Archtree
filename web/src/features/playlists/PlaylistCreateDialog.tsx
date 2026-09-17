import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { playlistNameSchema } from '../../api/playlists';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { PlaylistNameDialogProps } from './PlaylistDialogs';
import { playlistCreationSession, usePlaylistCreationSession } from './playlistCreationSession';
import { playlistMutationMessage } from './playlistMutationMessage';
import styles from './Playlists.module.css';

/** Closing the presentation never discards a dispatched create intent or its original retry identity. */
export const PlaylistCreateDialog = ({ viewerId, onClose, onConfirmed, returnFocusRef }: PlaylistNameDialogProps) => {
  const { t } = useLocalization();
  const client = useQueryClient();
  const state = usePlaylistCreationSession();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState({ viewerId, name: '', error: '' });
  const name = draft.viewerId === viewerId ? draft.name : '';
  const validationError = draft.viewerId === viewerId ? draft.error : '';
  const setName = (value: string) => setDraft({ viewerId, name: value, error: '' });
  const owned = state.viewerId === viewerId;
  const intent = owned ? state.intent : null;
  const pending = owned && state.status === 'pending';
  const uncertain = owned && ['uncertain', 'expired'].includes(state.status);
  useEffect(() => { playlistCreationSession.ensure(viewerId, client); }, [viewerId, client]);
  useEffect(() => {
    if (!owned || state.status !== 'confirmed' || !intent) return;
    const confirmed = playlistCreationSession.takeConfirmed(viewerId, intent.key);
    if (confirmed) onConfirmed(confirmed.id);
  }, [owned, state.status, intent, viewerId, onConfirmed]);
  const error = owned && state.status === 'rejected' ? state.error : null;
  return <ModalDialog closeDisabled={pending} description={t('playlist.name.create_description')}
    initialFocusRef={input} kicker={t('library.title')} onClose={onClose} returnFocusRef={returnFocusRef}
    title={t('playlist.name.create_title')}>
    <form className={styles.dialogForm} onSubmit={event => {
      event.preventDefault();
      if (!owned || intent) return;
      const parsed = playlistNameSchema.safeParse(name);
      if (!parsed.success) { setDraft({ viewerId, name, error: t('playlist.name.validation') }); input.current?.focus(); return; }
      setName(parsed.data);
      void playlistCreationSession.start(viewerId, parsed.data);
    }}>
      <label className={styles.field}><span>{t('playlist.name.field')}</span>
        <input aria-describedby="playlist-name-hint" aria-busy={pending} autoComplete="off" ref={input}
          readOnly={!owned || Boolean(intent)} value={intent?.name ?? name}
          onChange={event => setName(event.currentTarget.value)} />
      </label>
      <p className={styles.fieldHint} id="playlist-name-hint">{t('playlist.name.hint')}</p>
      {Boolean(validationError || error) && <p className={styles.feedbackError} role="alert">{validationError || playlistMutationMessage(error, 'create', t)}</p>}
      {uncertain && intent && <div role="alert" className={styles.feedbackError}>
        <p>{t(state.status === 'expired' ? 'playlist.create.expired' : 'playlist.create.recovery', { name: intent.name })}</p>
        <div className={styles.dialogActions}>
          {state.status !== 'expired' && <button className={styles.primaryButton} type="button" onClick={() => void playlistCreationSession.retry(viewerId)}>{t('social.retry_same')}</button>}
          <button className={styles.secondaryButton} type="button" onClick={() => {
            if (window.confirm(t('playlist.create.abandon_confirm', { name: intent.name }))
              && playlistCreationSession.abandon(viewerId, intent.key)) setName('');
          }}>{t('playlist.create.abandon')}</button>
        </div>
      </div>}
      <div className={styles.dialogActions}>
        <button className={styles.secondaryButton} disabled={pending} onClick={onClose} type="button">{t(uncertain ? 'common.action.close' : 'common.action.cancel')}</button>
        {!uncertain && <button className={styles.primaryButton} disabled={!owned || Boolean(intent)} type="submit">
          {t(pending ? 'playlist.name.saving' : 'playlist.action.create')}
        </button>}
      </div>
    </form>
  </ModalDialog>;
};
