import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminRequest, candidatesSchema, duplicateEditsKey, importPath, type DecisionEdits, type ImportDetail, type ImportDraftV2 } from './adminApi';
import { adminWorkspace } from './adminWorkspace';
import { approvalBody, approvalChecklist, shownDecisions, type ApprovalBody, type ApprovalIdentity } from './importApproval';
import { entriesByline } from './artistEntriesByline';
import type { ImportDraftChange } from './importDraftPatch';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

/** The publish body a confirmation can send, and whether everything it shows is decided and current. */
export interface ApprovalState { body: ApprovalBody; ready: boolean }

const identityKeys = { new: 'publication.new_record', needsDecision: 'publication.needs_decision', changed: 'publication.decision_changed', notApplied: 'publication.not_applied' } as const;

/**
 * The publication confirmation's list of everything that becomes catalog content, built from the project, the editor's draft and
 * its unsaved changes as they were when Publish was chosen. It reports the publish body to the dialog, which approves it only while
 * every shown identity is decided and current. Loaded on demand with the confirmation.
 */
export function ImportApprovalChecklist({ item, draft, changes, onChange }: {
  item: ImportDetail; draft: ImportDraftV2; changes: ImportDraftChange[]; onChange: (approval: ApprovalState | null) => void;
}) {
  const t = useAdminText(), { t: sharedText } = useLocalization(), access = useAdminAccess(), heading = useId();
  // Review's unsaved decisions are read once, as the dialog opens; the modal keeps Review from changing them behind it.
  const [body] = useState(() => {
    const decisions = shownDecisions(item, draft, adminWorkspace.buffer<DecisionEdits>(duplicateEditsKey(item.id)) ?? null);
    return decisions && approvalBody(item, changes, decisions);
  });
  // A reuse is shown by name and visibility from the same candidate read Review uses (and shares while Review keeps it).
  const reuses = Boolean(body?.decisions.some(decision => decision.action === 'reuse'));
  const candidates = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, item.id, 'duplicates', item.revision],
    queryFn: ({ signal }) => adminRequest(`${importPath(item.id)}/duplicate-candidates`, candidatesSchema, { signal }),
    enabled: reuses, retry: false, gcTime: 0
  });
  const checklist = body && (!reuses || candidates.isSuccess) ? approvalChecklist(draft, body.decisions, candidates.data?.items ?? []) : null;
  const ready = Boolean(checklist && checklist.blocked === 0);
  useEffect(() => { onChange(body && { body, ready }); }, [body, ready]);
  const identity = (value: ApprovalIdentity) => value.kind === 'reused'
    ? [t('publication.reused_record', { name: value.label }), value.hidden && t('field.hidden')].filter(Boolean).join(' · ') : t(identityKeys[value.kind]);
  // An append applies none of the draft's Album values or cover; each such row says so.
  const applied = (text: string) => checklist?.append ? `${text} · ${t('publication.not_applied')}` : text;
  const cover = body?.selectedCoverSlotId ?? null;
  const coverText = cover === null ? t('media.no_cover') : cover === 'cover' ? t('media.manual_cover') : item.manifest.files.find(file => `embedded-${file.slotId}` === cover)?.filename ?? cover;
  return <section aria-labelledby={heading} className={styles.checklist}>
    <h3 id={heading}>{t('publication.checklist')}</h3>
    {changes.length > 0 && <p role="note">{t('publication.unsaved_included')}</p>}
    {!body && <p role="alert">{t('publication.decisions_conflict')}</p>}
    {reuses && candidates.isPending && <p role="status">{t('common.loading')}</p>}
    {reuses && candidates.isError && <p role="alert">{t('common.error')}</p>}
    {checklist && <>
      {checklist.append && <p role="note">{t('publication.append_not_applied')}</p>}
      <dl>
        <div><dt>{t('field.title')}</dt><dd>{applied(draft.album.title || t('common.untitled'))}</dd></div>
        <div><dt>{t('field.artists')}</dt><dd>{entriesByline(draft.album.artists) || '—'}
          <ol>{checklist.artists.map(entry => <li key={entry.key}>{[entry.name, sharedText(`catalog.credit.${entry.role}` as MessageKey),
            entry.joinPhrase && t('publication.join_phrase', { phrase: entry.joinPhrase }), identity(entry.identity)].filter(Boolean).join(' · ')}</li>)}</ol></dd></div>
        <div><dt>{t('field.label')}</dt><dd>{checklist.label ? `${checklist.label.name} · ${identity(checklist.label.identity)}` : t('publication.no_label')}</dd></div>
        <div><dt>{t('field.releaseDate')}</dt><dd>{applied(reviewValueText(draft.album.releaseDate))}</dd></div>
        <div><dt>{t('field.visibility')}</dt><dd>{applied(t(`field.${draft.album.visibility}`))}</dd></div>
        <div><dt>{t('layout.selectedCover')}</dt><dd>{applied(coverText)}</dd></div>
        <div><dt>{t('duplicates.album')}</dt><dd>{identity(checklist.album)}</dd></div>
        {/* An existing member keeps its stored title and position, so it is named by its catalog title only (by its draft title
            while its match changed, which blocks approval). */}
        <div><dt>{t('catalog.track')}</dt><dd><ol>{checklist.tracks.map(track => <li key={track.slotId}>{(track.existing
          ? [track.identity.kind !== 'reused' && (track.title || t('common.untitled')), identity(track.identity), t('publication.existing_member')]
          : [t('publication.track_position', { disc: String(track.discNumber ?? 1), track: track.trackNumber === null ? '—' : String(track.trackNumber) }),
            track.title || t('common.untitled'), identity(track.identity)]).filter(Boolean).join(' · ')}</li>)}</ol></dd></div>
      </dl>
    </>}
  </section>;
}
