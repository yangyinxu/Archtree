import { useState } from 'react';
import type { ContentSummary } from '../../api/contentSchemas';
import { ContentListRow } from '../../components/ContentListRow';
import { SaveButton } from '../../components/SaveButton';
import { launchStandalonePlayback } from '../playback/launchPlayback';
import { LazyAddTrackToPlaylistButton } from '../playlists/LazyAddTrackToPlaylistButton';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './LibraryMusicRows.module.css';

type MusicRow = { content: ContentSummary; saved: boolean; available?: boolean };
export interface MusicRowsProps { rows: MusicRow[]; viewerId: string; label: string; savedOnly?: boolean; }

/** Uses the actual Save state; unsaving history changes the button, not history membership. */
const MusicRows = ({ rows, viewerId, label, savedOnly = false }: MusicRowsProps) => {
  const { t } = useLocalization();
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  return <ul className={styles.list} aria-label={label}>{rows.map(({ content, saved, available = true }) => {
    const key = `${content.contentType}:${content.id}`;
    const actualSaved = confirmed[key] ?? saved;
    if (savedOnly && !actualSaved) return null;
    if (content.contentType !== 'album' && content.contentType !== 'audioTrack') return null;
    return <ContentListRow key={`${content.contentType}:${content.id}`} item={content}
      onPlay={content.contentType === 'audioTrack' && available
        ? (track) => { void launchStandalonePlayback(track, viewerId); } : undefined}
      trailing={<span className={styles.rowActions}>
        {!available && <span className={styles.unavailable}>{t('common.state.unavailable')}</span>}
        {content.contentType === 'audioTrack' && available && <LazyAddTrackToPlaylistButton track={content} viewerId={viewerId} />}
        <SaveButton compact saved={actualSaved} onSavedChange={(value) => setConfirmed((current) => ({ ...current, [key]: value }))} target={{ contentType: content.contentType, contentId: content.id }} viewerId={viewerId} />
      </span>} />;
  })}</ul>;
};


export default MusicRows;
