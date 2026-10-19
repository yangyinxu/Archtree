import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminRequest, duplicateEditsKey, importPath, type DecisionEdits, type ImportDecision, type ImportDetail, type ImportDraftV2 } from './adminApi';
import { candidatesSchema, identityPreselections } from './importIdentity';
import { adminWorkspace } from './adminWorkspace';
import { approvalBody, approvalChecklist, shownDecisions, type ApprovalBody, type ApprovalIdentity } from './importApproval';
import { entriesByline } from './artistEntriesByline';
import type { ImportDraftChange } from './importDraftPatch';
import { reviewValueText } from './reviewValueText';
import styles from './adminStyles';

/**
 * The publish body a confirmation can send, with the preselections it shows (the approval refuses any other set), and whether
 * everything it shows is decided and current.
 */
export interface ApprovalState { body: ApprovalBody & { preselections: ImportDecision[] }; ready: boolean }

const identityKeys = { new: 'publication.new_record', needsDecision: 'publication.needs_decision', changed: 'publication.decision_changed', notApplied: 'publication.not_applied' } as const;

/**
 * The publication confirmation's list of everything that becomes catalog content, built from the project, the editor's draft and
 * its unsaved changes as they were when Publish was chosen. It always reads the duplicate candidates, since the rows Review
 * preselects depend on them, and reports the publish body, carrying the preselections it shows, to the dialog, which approves it
 * only once that read settled and every shown identity is answered or preselected, and current. Loaded on demand with the
 * confirmation.
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
  // The same candidate read Review uses (and shares while Review keeps it): reuses are shown by name and visibility from it, and
  // the preselections are computed from it; a row renamed in the unsaved draft is never preselected (its candidates are stale).
  const candidates = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, item.id, 'duplicates', item.revision, item.valueRevision],
    queryFn: ({ signal }) => adminRequest(`${importPath(item.id)}/duplicate-candidates`, candidatesSchema, { signal }),
    enabled: Boolean(body), retry: false, gcTime: 0
  });
  const preselections = body && candidates.isSuccess ? identityPreselections(draft, item.draft, body.decisions, candidates.data) : [];
  const checklist = body && candidates.isSuccess ? approvalChecklist(draft, body.decisions, candidates.data.items,
    { automaticPaths: item.automaticPaths, possibleLabelEntryKeys: item.possibleLabelEntryKeys, changedPaths: changes.map(change => change.path) }, preselections) : null;
  const ready = Boolean(checklist && checklist.blocked === 0 && !candidates.isFetching);
  // Reported again only when what it shows changes, so the dialog's state update never loops back here.
  const shown = JSON.stringify(preselections);
  useEffect(() => { onChange(body && { body: { ...body, preselections: JSON.parse(shown) as ImportDecision[] }, ready }); }, [body, ready, shown]);
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
    {body && candidates.isPending && <p role="status">{t('common.loading')}</p>}
    {body && candidates.isError && <p role="alert">{t('common.error')}</p>}
    {checklist && <>
      {checklist.append && <p role="note">{t('publication.append_not_applied')}</p>}
      <dl>
        <div><dt>{t('field.title')}</dt><dd>{applied(draft.album.title || t('common.untitled'))}</dd></div>
        <div><dt>{t('field.artists')}</dt><dd>{[entriesByline(draft.album.artists) || '—', checklist.artistsFromTags && t('publication.tags_only')].filter(Boolean).join(' · ')}
          <ol>{checklist.artists.map(entry => <li key={entry.key}>{[entry.name, sharedText(`catalog.credit.${entry.role}` as MessageKey),
            entry.joinPhrase && t('publication.join_phrase', { phrase: entry.joinPhrase }), identity(entry.identity), entry.possibleLabel && t('entries.possible_label')].filter(Boolean).join(' · ')}</li>)}</ol></dd></div>
        <div><dt>{t('field.label')}</dt><dd>{checklist.label ? [checklist.label.name, identity(checklist.label.identity), checklist.labelFromTags && t('publication.tags_only')].filter(Boolean).join(' · ') : t('publication.no_label')}</dd></div>
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
