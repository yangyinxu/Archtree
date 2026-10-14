import { lazy, Suspense, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { AdminGate, useAdminAccess, useAdminText } from './AdminAccess';
import { adminRequest, importPath, responseSchema, type ImportDetail, type ImportDraft } from './adminApi';
import { adminWorkspace } from './adminWorkspace';
import { useAdminMutation } from './useAdminMutation';
import { ImportStages, MutationStatus, useOnline } from './AdminShared';
import { ImportDraftEditor } from './ImportDraftEditor';
import { AdminNav } from './AdminNav';
import styles from './adminStyles';
const ImportMedia = lazy(() => import('./ImportMedia').then(module => ({ default: module.ImportMedia })));
const ImportReview = lazy(() => import('./ImportReview').then(module => ({ default: module.ImportReview })));
const ImportDuplicates = lazy(() => import('./ImportDuplicates').then(module => ({ default: module.ImportDuplicates })));

interface EditorBuffer { draft: ImportDraft; revision: number; dirty: boolean; selected: string[] }
function ImportProject({ id }: { id: string }) {
  const t = useAdminText();
  const access = useAdminAccess();
  const online = useOnline();
  const path = importPath(id);
  const bufferKey = `editor:${id}`;
  const [editor, setEditor] = useState<EditorBuffer | null>(() => adminWorkspace.buffer(bufferKey) ?? null);
  const [confirmed, setConfirmed] = useState<ImportDetail | null>(null);
  const [stage, setStage] = useState<'draft' | 'review' | 'files' | 'publication'>(() => adminWorkspace.buffer(`stage:${id}`) ?? 'draft');
  const [reviewVisited, setReviewVisited] = useState(stage === 'review');
  const mutation = useAdminMutation(id);
  const query = useQuery({
    queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, id],
    queryFn: ({ signal }) => adminRequest(path, responseSchema, { signal }), retry: false, gcTime: 0,
    refetchOnWindowFocus: 'always', refetchInterval: query => online && (['running', 'queued'].includes(query.state.data?.item.analysis.state ?? '') || query.state.data?.item.publication === 'preparing') ? 3000 : false
  });
  useEffect(() => {
    const item = query.data?.item;
    if (!item) return;
    setConfirmed(previous => !previous || item.revision >= previous.revision ? item : previous);
    setEditor(previous => previous && (previous.dirty || previous.revision > item.revision) ? previous : { draft: item.draft, revision: item.revision, dirty: false, selected: previous?.selected ?? [] });
    mutation.operation.reconcile(item);
  }, [query.data]);
  useEffect(() => {
    if (!mutation.result) return;
    const item = mutation.result.item;
    setConfirmed(previous => !previous || item.revision >= previous.revision ? item : previous);
    setEditor({ draft: item.draft, revision: item.revision, dirty: false, selected: [] });
    if (mutation.result.receipt?.kind === 'decisions') adminWorkspace.forget(`duplicate-edits:${id}`);
    mutation.operation.acknowledge();
    void query.refetch();
  }, [mutation.result]);
  useEffect(() => { if (editor) adminWorkspace.retain(bufferKey, editor, access); }, [editor]);
  useEffect(() => { adminWorkspace.retain(`stage:${id}`, stage, access); }, [stage]);
  // Keep candidate search state mounted after its first visit while deferring the initial review bundle.
  useEffect(() => { if (stage === 'review') setReviewVisited(true); }, [stage]);
  const item = confirmed;
  const locked = mutation.running || Boolean(mutation.intent) || !online;
  const publicationLocked = Boolean(confirmed && ['preparing', 'needsAttention', 'complete'].includes(confirmed.publication));
  const conflict = Boolean(editor && item && editor.dirty && editor.revision !== item.revision);
  const savedOnly = locked || publicationLocked || Boolean(editor?.dirty) || conflict;
  const active = item && ['queued', 'running'].includes(item.analysis.state);
  const publicationCleanup = item?.publication === 'cancelled' && Boolean(item.publicationRecovery?.cleanupPending);
  const mutate = (action: string, payload: object) => { if (item) mutation.operation.run(`${path}/${action}`, 'POST', { expectedRevision: item.revision, ...payload }); };
  return <section className={styles.page}><AdminNav />
    <Link className={styles.back} to="/admin/imports">{t('common.back')}</Link>
    <header className={styles.header}><div><h1 className={styles.title}>{item?.draft.album.title || item?.manifest.rootLabel || t('common.untitled')}</h1>{item?.draft.album.artistName && <p className={styles.meta}>{item.draft.album.artistName}</p>}</div>
      <button className={styles.button} type="button" disabled={query.isFetching || !online} onClick={() => void query.refetch()}>{t('common.refresh')}</button></header>
    {!online && <p className={styles.error} role="status">{t('common.offline')}</p>}
    {query.isPending && <p role="status">{t('common.loading')}</p>}
    {query.isError && <p role="alert" className={styles.error}>{t('common.error')}</p>}
    <MutationStatus mutation={mutation} />
    {item && editor && <>
      <ImportStages item={item} />
      <p className={styles.meta}>{t('common.last_updated', { date: new Date(item.updatedAt).toLocaleString() })}</p>
      <div role="tablist" aria-label={t('workbench.title')} className={styles.filters}>{(['draft', 'review', 'files', 'publication'] as const).map(value => <button key={value} id={`import-tab-${value}`} role="tab" type="button" className={styles.filter} aria-selected={stage === value} tabIndex={stage === value ? 0 : -1} onKeyDown={event => { const stages = ['draft', 'review', 'files', 'publication'] as const; const index = stages.indexOf(value); const next = event.key === 'ArrowRight' ? stages[(index + 1) % stages.length] : event.key === 'ArrowLeft' ? stages[(index + stages.length - 1) % stages.length] : event.key === 'Home' ? stages[0] : event.key === 'End' ? stages[3] : null; if (next) { event.preventDefault(); setStage(next); document.getElementById(`import-tab-${next}`)?.focus(); } }} aria-controls={`import-panel-${value}`} onClick={() => setStage(value)}>{t(`section.${value}`)}</button>)}</div>
      {conflict && <section role="alert" className={styles.error}><p>{t('common.conflict')}</p>
        <details><summary>{t('review.saved_version')}</summary><pre className={styles.rawDraft}>{JSON.stringify(item.draft, null, 2)}</pre></details>
        <button className={styles.button} onClick={() => setEditor({ draft: item.draft, revision: item.revision, dirty: false, selected: [] })}>{t('review.load_saved')}</button>
      </section>}
      <div hidden={stage !== 'draft'} role="tabpanel" id="import-panel-draft" aria-labelledby="import-tab-draft">
      <form className={styles.panel} onSubmit={event => { event.preventDefault(); if (!locked && !conflict) mutation.operation.run(path, 'PATCH', { expectedRevision: editor.revision, draft: editor.draft }); }}>
        <header className={styles.sectionHeader}><h2>{t('layout.metadata')}</h2></header>
        <ImportDraftEditor draft={editor.draft} filenames={item.manifest.files} disabled={locked || publicationLocked} onChange={draft => setEditor({ ...editor, draft, dirty: true })} />
        <div className={styles.actions}><button className={`${styles.button} ${styles.primary}`} type="submit" disabled={locked || publicationLocked || !editor.dirty || conflict}>{t('action.save')}</button><span role="status">{t(editor.dirty ? 'common.unsaved' : 'common.saved')}</span></div>
      </form>
      <section className={styles.panel}>
        <header className={styles.sectionHeader}><h2>{t('stage.analysis')}</h2></header>
        <div className={styles.actions}>
          {!active && <button className={styles.button} disabled={savedOnly || publicationCleanup || !access.analysis || !item.capabilities.analysis || item.analysis.generation >= 2 || item.analysis.issue === 'providerOutcomeUnknown'} onClick={() => mutate('analyze', {})}>{t(item.analysis.generation ? 'action.reanalyze' : 'action.analyze')}</button>}
          {active && <button className={styles.button} disabled={locked} onClick={() => mutate('cancel-analysis', {})}>{t('analysis.stop')}</button>}
        </div>
        {(!access.analysis || !item.capabilities.analysis) && <p>{t('analysis.unavailable')}</p>}
        {item.analysis.issue && <p role="status">{t(`issue.${item.analysis.issue}`)}</p>}
      </section>
      </div>
      <div hidden={stage !== 'review'} role="tabpanel" id="import-panel-review" aria-labelledby="import-tab-review">
      {stage === 'review' && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><ImportReview draft={editor.draft} filenames={item.manifest.files} suggestions={item.suggestions} selected={editor.selected}
        onSelect={selected => setEditor({ ...editor, selected })} disabled={savedOnly || Boolean(active)}
        onAdopt={selectedIds => mutate('adopt', { generation: item.analysis.generation, selectedIds, rejectIds: [] })}
        onReject={rejectIds => mutate('adopt', { generation: item.analysis.generation, selectedIds: [], rejectIds })} /></Suspense>}
      {reviewVisited && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><ImportDuplicates key={item.revision} item={item} disabled={savedOnly || Boolean(active)} onSave={decisions => mutate('decisions', { decisions })} /></Suspense>}
      </div>
      {(['files', 'publication'] as const).map(value => <div key={value} hidden={stage !== value} role="tabpanel" id={`import-panel-${value}`} aria-labelledby={`import-tab-${value}`}>
      <Suspense fallback={<p role="status">{t('common.loading')}</p>}><ImportMedia view={value} active={stage === value} item={item} operation={mutation.operation} disabled={locked || editor.dirty || conflict || Boolean(active)} /></Suspense>
      </div>)}
    </>}
  </section>;
}
export function AdminImportPage({ projectId }: { projectId?: string } = {}) {
  const { importId: routeId = '' } = useParams();
  const importId = projectId ?? routeId;
  const t = useAdminText();
  return <AdminGate>{/^[a-f0-9]{24}$/.test(importId) ? <ImportProject key={importId} id={importId} /> : <p className={styles.page}>{t('common.error')}</p>}</AdminGate>;
}
