import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminRequest, candidatesSchema, duplicateEditsKey, importPath, type DecisionEdits, type ImportCandidate, type ImportDecision, type ImportDetail } from './adminApi';
import { adminWorkspace } from './adminWorkspace';
import { staleDecisionEdits } from './importApproval';
import styles from './adminStyles';

/** One decision row: each Artist entry (by key), the label, the Album and each track. */
interface DecisionRow { scope: ImportDecision['scope']; slotId: string | null; entryKey: string | null; kind: ImportCandidate['kind']; name: string; text: string }
const sameRow = (decision: Pick<ImportDecision, 'scope' | 'slotId' | 'entryKey'>, row: DecisionRow) => decision.scope === row.scope && decision.slotId === row.slotId && decision.entryKey === row.entryKey;

/**
 * Candidate names are evidence, never a unique identity or an automatic reuse decision. Each Artist entry and the label need their
 * own decision, and two entries cannot reuse one Artist; an append needs none for them, so their rows say they are not applied.
 * Unsaved decisions survive field saves, Luna and automatic writes; they conflict once a decided entry or label was renamed or
 * another save stored decisions after the first edit. Candidates are read again after automatic writes rename what they match.
 */
export function ImportDuplicates({ item, disabled, onSave }: { item: ImportDetail; disabled: boolean; onSave: (body: { expectedRevision: number; decisions: ImportDecision[] }) => void }) {
  const t = useAdminText(), { t: sharedText } = useLocalization();
  const access = useAdminAccess();
  const [requested, setRequested] = useState(false);
  const key = duplicateEditsKey(item.id);
  const [edits, setEdits] = useState<DecisionEdits | null>(() => adminWorkspace.buffer(key) ?? null);
  const conflict = Boolean(edits && staleDecisionEdits(item, edits));
  const query = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, item.id, 'duplicates', item.revision, item.valueRevision],
    queryFn: ({ signal }) => adminRequest(`${importPath(item.id)}/duplicate-candidates`, candidatesSchema, { signal }),
    enabled: requested, retry: false, gcTime: 0
  });
  const { artists, label, title } = item.draft.album;
  const rows: DecisionRow[] = [
    ...artists.map(entry => ({ scope: 'artist' as const, slotId: null, entryKey: entry.key, kind: 'artist' as const, name: entry.name, text: `${t('duplicates.artist')} · ${entry.name} · ${sharedText(`catalog.credit.${entry.role}` as MessageKey)}` })),
    ...(label ? [{ scope: 'label' as const, slotId: null, entryKey: null, kind: 'organization' as const, name: label.name, text: `${t('duplicates.label')} · ${label.name}` }] : []),
    { scope: 'album' as const, slotId: null, entryKey: null, kind: 'album' as const, name: title, text: `${t('duplicates.album')} · ${title || t('common.untitled')}` },
    ...item.draft.tracks.map(track => ({ scope: 'track' as const, slotId: track.slotId, entryKey: null, kind: 'track' as const, name: track.title, text: `${t('duplicates.track')} · ${track.title || t('common.untitled')}` }))
  ];
  // Only decisions on a current row are shown or saved; a removed or renamed entry's decision was already cleared by the server.
  const decisions = (edits?.decisions ?? item.decisions).filter(decision => rows.some(row => sameRow(decision, row)));
  const append = decisions.find(decision => decision.scope === 'album')?.action === 'reuse';
  const decide = (row: DecisionRow, value: string, candidates: ImportCandidate[]) => {
    const others = decisions.filter(decision => !sameRow(decision, row));
    const candidate = candidates.find(item => item.id === value);
    const next: ImportDecision[] = value ? [...others, { scope: row.scope, slotId: row.slotId, entryKey: row.entryKey, boundName: row.scope === 'artist' || row.scope === 'label' ? row.name : null,
      action: candidate ? 'reuse' : value as 'skip' | 'create-distinct', candidateId: candidate?.id ?? null, candidateRevision: candidate?.revision ?? null }] : others;
    const buffer: DecisionEdits = { revision: edits?.revision ?? item.revision, decisions: next };
    setEdits(buffer); adminWorkspace.retain(key, buffer, access);
  };
  return <section className={styles.panel}>
    <header className={styles.sectionHeader}><div><h2>{t('duplicates.title')}</h2><p className={styles.muted}>{t('duplicates.copy')}</p></div></header>
    <button className={styles.button} type="button" disabled={disabled || query.isFetching} onClick={() => { setRequested(true); if (requested) void query.refetch(); }}>{t('action.find_matches')}</button>
    {query.isFetching && <p role="status">{t('common.loading')}</p>}
    {query.isError && <p role="alert">{t('common.error')}</p>}
    {query.isSuccess && <>
      {rows.map((row, index) => {
        const current = decisions.find(decision => sameRow(decision, row));
        const candidates = query.data.items.filter(candidate => candidate.kind === row.kind && (candidate.match === 'sha256' ? candidate.matchedSlotIds.includes(row.slotId ?? '') : candidate.label.toLocaleLowerCase() === row.name.toLocaleLowerCase()));
        // Another entry's reuse already names this Artist, and two entries cannot reuse one Artist.
        const taken = new Set(row.scope === 'artist' ? decisions.filter(decision => decision.scope === 'artist' && decision.action === 'reuse' && !sameRow(decision, row)).map(decision => decision.candidateId) : []);
        const notApplied = append && (row.scope === 'artist' || row.scope === 'label');
        return <div key={`${row.scope}:${row.slotId}:${row.entryKey}`}>{notApplied ? <p className={styles.field}>{row.text}<span className={styles.muted}>{t('duplicates.not_applied')}</span></p> : <><label className={styles.field}>
          {row.text}
          <select className={styles.input} disabled={disabled} aria-label={`${index + 1} · ${t('duplicates.decision')}`}
            value={current?.action === 'reuse' ? current.candidateId ?? '' : current?.action ?? ''}
            onChange={event => decide(row, event.target.value, candidates)}>
            <option value="">{t('duplicates.undecided')}</option>
            <option value="create-distinct">{t('duplicates.distinct')}</option>
            {row.scope === 'track' && <option value="skip">{t('duplicates.skip')}</option>}
            {candidates.map(candidate => <option value={candidate.id} key={candidate.id} disabled={taken.has(candidate.id)}>{t('duplicates.reuse')} · {candidate.label} · {t(`duplicates.${candidate.match}`)} · {t(`field.${candidate.visibility}`)} · {candidate.id.slice(-6)}</option>)}
          </select>
        </label>{candidates.map(candidate => <p key={candidate.id}><Link className={styles.itemLink} to={`/admin/catalog/${candidate.kind === 'track' ? 'audioTrack' : candidate.kind}/${candidate.id}`}>{candidate.label}</Link> · {t(`duplicates.${candidate.match}`)} · {t(`field.${candidate.visibility}`)}</p>)}</>}</div>;
      })}
      {conflict && <div role="alert"><p>{t('common.conflict')}</p><button className={styles.button} onClick={() => { setEdits(null); adminWorkspace.forget(key); }}>{t('review.load_saved')}</button></div>}
      <button className={styles.button} disabled={disabled || edits === null || conflict} onClick={() => onSave({ expectedRevision: edits?.revision ?? item.revision, decisions })}>{t('action.save_decisions')}</button>
    </>}
  </section>;
}
