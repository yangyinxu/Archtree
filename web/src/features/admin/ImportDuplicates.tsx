import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminRequest, candidatesSchema, importPath, type ImportDecision, type ImportDetail } from './adminApi';
import { adminWorkspace } from './adminWorkspace';
import styles from './adminStyles';

/** Candidate names are evidence, never a unique identity or an automatic reuse decision. */
export function ImportDuplicates({ item, disabled, onSave }: { item: ImportDetail; disabled: boolean; onSave: (decisions: ImportDecision[]) => void }) {
  const t = useAdminText();
  const access = useAdminAccess();
  const [requested, setRequested] = useState(false);
  const key = `duplicate-edits:${item.id}`;
  const [edits, setEdits] = useState<{ revision: number; decisions: ImportDecision[] } | null>(() => adminWorkspace.buffer(key) ?? null);
  const conflict = Boolean(edits && edits.revision !== item.revision);
  const query = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, item.id, 'duplicates', item.revision],
    queryFn: ({ signal }) => adminRequest(`${importPath(item.id)}/duplicate-candidates`, candidatesSchema, { signal }),
    enabled: requested, retry: false, gcTime: 0
  });
  // This release decides one primary Artist entry without a label; other drafts publish only after S7a, so they show no Artist row.
  const artist = item.draft.album.artists.length === 1 && !item.draft.album.label ? item.draft.album.artists[0] : null;
  const decisions = (edits?.decisions ?? item.decisions).filter(decision => artist || decision.scope !== 'artist');
  const scopes = [...(artist ? [{ scope: 'artist' as const, slotId: null, label: artist.name }] : []), { scope: 'album' as const, slotId: null, label: item.draft.album.title }, ...item.draft.tracks.map(track => ({ scope: 'track' as const, slotId: track.slotId, label: track.title }))];
  return <section className={styles.panel}>
    <header className={styles.sectionHeader}><div><h2>{t('duplicates.title')}</h2><p className={styles.muted}>{t('duplicates.copy')}</p></div></header>
    <button className={styles.button} type="button" disabled={disabled || query.isFetching} onClick={() => { setRequested(true); if (requested) void query.refetch(); }}>{t('action.find_matches')}</button>
    {query.isFetching && <p role="status">{t('common.loading')}</p>}
    {query.isError && <p role="alert">{t('common.error')}</p>}
    {query.isSuccess && <>
      {scopes.map((row, index) => {
        const current = decisions.find(decision => decision.scope === row.scope && decision.slotId === row.slotId);
        const candidates = query.data.items.filter(candidate => candidate.kind === row.scope && (candidate.match === 'sha256' ? candidate.matchedSlotIds.includes(row.slotId ?? '') : candidate.label.toLocaleLowerCase() === row.label.toLocaleLowerCase()));
        return <div key={`${row.scope}:${row.slotId}`}><label className={styles.field}>
          {t(`duplicates.${row.scope}`)} · {row.label || t('common.untitled')}
          <select className={styles.input} disabled={disabled} aria-label={`${index + 1} · ${t('duplicates.decision')}`}
            value={current?.action === 'reuse' ? current.candidateId ?? '' : current?.action ?? ''}
            onChange={event => {
              const value = event.target.value;
              const others = decisions.filter(decision => decision.scope !== row.scope || decision.slotId !== row.slotId);
              const candidate = candidates.find(candidate => candidate.id === value);
              const next = value ? [...others, { scope: row.scope, slotId: row.slotId, action: candidate ? 'reuse' : value as 'skip' | 'create-distinct', candidateId: candidate?.id ?? null, candidateRevision: candidate?.revision ?? null }] : others;
              const buffer = { revision: edits?.revision ?? item.revision, decisions: next as ImportDecision[] };
              setEdits(buffer); adminWorkspace.retain(key, buffer, access);
            }}>
            <option value="">{t('duplicates.undecided')}</option>
            <option value="create-distinct">{t('duplicates.distinct')}</option>
            {row.scope === 'track' && <option value="skip">{t('duplicates.skip')}</option>}
            {candidates.map(candidate => <option value={candidate.id} key={candidate.id}>{t('duplicates.reuse')} · {candidate.label} · {t(`duplicates.${candidate.match}`)} · {t(`field.${candidate.visibility}`)} · {candidate.id.slice(-6)}</option>)}
          </select>
        </label>{candidates.map(candidate => <p key={candidate.id}><Link className={styles.itemLink} to={`/admin/catalog/${candidate.kind === 'track' ? 'audioTrack' : candidate.kind}/${candidate.id}`}>{candidate.label}</Link> · {t(`duplicates.${candidate.match}`)} · {t(`field.${candidate.visibility}`)}</p>)}</div>;
      })}
      {conflict && <div role="alert"><p>{t('common.conflict')}</p><button className={styles.button} onClick={() => { setEdits(null); adminWorkspace.forget(key); }}>{t('review.load_saved')}</button></div>}
      <button className={styles.button} disabled={disabled || edits === null || conflict} onClick={() => onSave(decisions)}>{t('action.save_decisions')}</button>
    </>}
  </section>;
}
