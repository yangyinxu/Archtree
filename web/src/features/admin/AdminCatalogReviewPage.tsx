import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { AdminGate, useAdminAccess, useAdminText } from './AdminAccess';
import { AdminNav } from './AdminNav';
import { adminEndpointRequest } from './adminTransport';
import type { ImportDraft } from './adminNamingSchema';
import { adminWorkspace } from './adminWorkspace';
import { ImportDraftEditor } from './ImportDraftEditor';
import { reviewValueText } from './reviewValueText';
import { reviewChanges, reviewFieldKey, reviewResponseSchema, type CatalogReview, type ReviewField } from './catalogReviewApi';
import { useCatalogReviewCommand } from './useCatalogReviewCommand';
import { useOnline } from './useAdminOnline';
import styles from './adminStyles';

interface ReviewBuffer { draft: ImportDraft; revision: number; dirty: boolean; suggestions: string[]; fields: string[] }
type Stage = 'draft' | 'review' | 'apply';
type Confirmation = { kind: 'analyze'; item: CatalogReview } | { kind: 'apply'; item: CatalogReview; fields: ReviewField[] };
const valueText = reviewValueText;
// Review is loaded only when requested; its selections remain in the parent account-fenced buffer.
const ImportReview = lazy(() => import('./ImportReview').then(module => ({ default: module.ImportReview })));
const CatalogReviewApply = lazy(() => import('./CatalogReviewApply').then(module => ({ default: module.CatalogReviewApply })));
const ModalDialog = lazy(() => import('../../components/ModalDialog').then(module => ({ default: module.ModalDialog })));

/** Existing-catalog suggestions stay private until a separately frozen field selection is approved. */
function ReviewProject({ id }: { id: string }) {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline();
  const path = `/catalog-reviews/${id}`, bufferKey = `catalog-review-editor:${id}`;
  const [editor, setEditor] = useState<ReviewBuffer | null>(() => adminWorkspace.buffer(bufferKey) ?? null);
  const [confirmed, setConfirmed] = useState<CatalogReview | null>(null);
  const latestRevision = useRef(0);
  const [stage, setStage] = useState<Stage>(() => adminWorkspace.buffer(`catalog-review-stage:${id}`) ?? 'draft');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const mutation = useCatalogReviewCommand(id, { id });
  const query = useQuery({
    queryKey: ['admin-catalog-reviews', access.viewerId, access.epoch, access.generation, id],
    queryFn: ({ signal }) => adminEndpointRequest(path, reviewResponseSchema.refine(value => value.item.id === id), { signal }),
    retry: false, gcTime: 0, refetchOnWindowFocus: 'always',
    refetchInterval: query => online && ['queued', 'running'].includes(query.state.data?.item.analysis.state ?? '') ? 3000 : false
  });
  useEffect(() => {
    const item = query.data?.item;
    if (!item || item.revision < latestRevision.current) return;
    latestRevision.current = item.revision;
    setConfirmed(item);
    setEditor(previous => previous && (previous.dirty || previous.revision > item.revision) ? previous
      : { draft: item.draft, revision: item.revision, dirty: false,
        suggestions: previous?.revision === item.revision ? previous.suggestions : [], fields: previous?.revision === item.revision ? previous.fields : [] });
  }, [query.data]);
  useEffect(() => {
    if (!mutation.result) return;
    const { item, receipt } = mutation.result;
    // A late receipt cannot roll back a newer read; retain the local edit and its visible conflict.
    if (item.revision >= latestRevision.current) {
      latestRevision.current = item.revision;
      setConfirmed(item);
      setEditor(previous => previous && (previous.revision > item.revision || previous.dirty && receipt.kind === 'cancel-analysis') ? previous
        : { draft: item.draft, revision: item.revision, dirty: false, suggestions: [], fields: [] });
    }
    mutation.command.acknowledge();
    void query.refetch();
  }, [mutation.result]);
  useEffect(() => { if (editor) adminWorkspace.retain(bufferKey, editor, access); }, [editor]);
  useEffect(() => { adminWorkspace.retain(`catalog-review-stage:${id}`, stage, access); }, [stage]);
  const item = confirmed;
  const active = Boolean(item && ['queued', 'running'].includes(item.analysis.state));
  const locked = mutation.running || Boolean(mutation.intent) || !online || item?.state === 'applied';
  const conflict = Boolean(editor?.dirty && item && editor.revision !== item.revision);
  const savedOnly = locked || Boolean(editor?.dirty) || conflict || active;
  const canAnalyze = Boolean(item && !savedOnly && item.sourceStatus === 'current' && item.capabilities.analysis
    && item.analysis.generation < 2 && item.analysis.issue !== 'providerOutcomeUnknown');
  const changes = item ? reviewChanges(item) : [];
  const analysisState = item?.analysis.state === 'idle' ? 'notStarted' : item?.analysis.state === 'needsAttention' ? 'failed' : item?.analysis.state;
  const selected = changes.filter(change => editor?.fields.includes(reviewFieldKey(change)));
  const filenames = item?.source.tracks.map(track => ({ slotId: track.slotId, filename: track.originalFileName ?? '',
    relativePath: track.originalFileName ?? t('catalog_review.filename_missing'), byteLength: null })) ?? [];
  const mutate = (action: string, payload: object) => {
    if (item) mutation.command.run(`${path}/${action}`, { expectedRevision: item.revision, ...payload }, 'POST');
  };
  const setCurrent = (next: CatalogReview) => setEditor({ draft: next.draft, revision: next.revision, dirty: false, suggestions: [], fields: [] });
  return <section className={styles.page}><AdminNav />
    <Link className={styles.back} to="/admin/imports?source=catalogReviews">{t('common.back')}</Link>
    <header className={styles.header}><div><h1 className={styles.title}>{item?.source.album.title || t('catalog_review.title')}</h1>
      <p className={styles.meta}>{t('catalog_review.title')}</p></div>
      <button className={styles.button} type="button" disabled={query.isFetching || !online} onClick={() => void query.refetch()}>{t('common.refresh')}</button></header>
    {!online && <p role="status" className={styles.error}>{t('common.offline')}</p>}
    {query.isPending && <p role="status">{t('common.loading')}</p>}
    {query.isError && <p role="alert" className={styles.error}>{t('common.error')}</p>}
    {mutation.error && <div role="alert" className={styles.error}><p>{t(`common.${mutation.error}`)}</p>
      {mutation.intent && <button className={styles.button} type="button" disabled={mutation.running || !online} onClick={mutation.command.retry}>{t('common.retry_operation')}</button>}
    </div>}
    {item && editor && <>
      <p className={styles.muted}>{t('catalog_review.context_copy')}</p>
      <div className={styles.actions}><Link className={styles.link} to={`/admin/catalog/album/${item.source.album.id}`}>{t('published.edit_album')}</Link></div>
      <dl className={styles.statusRow}><div><dt>{t('stage.analysis')}</dt><dd>{t(`state.${analysisState}`)}</dd></div>
        <div><dt>{t('stage.review')}</dt><dd>{t(item.state === 'applied' ? 'catalog_review.applied' : item.suggestions.some(value => value.decision === 'pending') ? 'state.needsReview' : item.analysis.state === 'complete' ? 'state.approved' : 'state.notStarted')}</dd></div></dl>
      {item.state === 'applied' ? <section className={styles.notice} role="status"><h2>{t('catalog_review.applied')}</h2><p>{t('catalog_review.applied_copy')}</p></section>
        : item.sourceStatus !== 'current' && <p role="alert" className={styles.error}>{t(`catalog_review.source_${item.sourceStatus}`)}</p>}
      <div role="tablist" aria-label={t('catalog_review.title')} className={styles.filters}>
        {(['draft', 'review', 'apply'] as const).map((value, index, stages) => <button key={value} role="tab" type="button" id={`catalog-review-tab-${value}`}
          className={styles.filter} aria-selected={stage === value} aria-controls={`catalog-review-panel-${value}`} tabIndex={stage === value ? 0 : -1}
          onClick={() => setStage(value)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? stages[(index + 1) % stages.length] : event.key === 'ArrowLeft' ? stages[(index + stages.length - 1) % stages.length]
              : event.key === 'Home' ? stages[0] : event.key === 'End' ? stages[2] : null;
            if (next) { event.preventDefault(); setStage(next); document.getElementById(`catalog-review-tab-${next}`)?.focus(); }
          }}>{t(value === 'apply' ? 'catalog_review.apply_tab' : `section.${value}`)}</button>)}
      </div>
      {conflict && <section className={styles.error} role="alert"><p>{t('common.conflict')}</p>
        <button className={styles.button} type="button" onClick={() => setCurrent(item)}>{t('review.load_saved')}</button></section>}
      {editor.dirty && <p role="status" className={styles.muted}>{t('catalog_review.save_draft_first')}</p>}
      <div hidden={stage !== 'draft'} role="tabpanel" id="catalog-review-panel-draft" aria-labelledby="catalog-review-tab-draft">
        <form className={styles.panel} onSubmit={event => { event.preventDefault(); if (!locked && !conflict) mutation.command.run(path, { expectedRevision: editor.revision, draft: editor.draft }); }}>
          <header className={styles.sectionHeader}><h2>{t('layout.metadata')}</h2></header>
          <ImportDraftEditor draft={editor.draft} filenames={filenames} disabled={locked} artistReadOnly visibilityReadOnly onChange={draft => setEditor({ ...editor, draft, dirty: true })} />
          <p className={styles.muted}>{t('catalog_review.artist_hint')}</p>
          <div className={styles.actions}><button className={`${styles.button} ${styles.primary}`} type="submit" disabled={locked || !editor.dirty || conflict}>{t('action.save')}</button>
            <span role="status">{t(editor.dirty ? 'common.unsaved' : 'catalog_review.draft_saved')}</span></div>
        </form>
        <section className={styles.panel}><header className={styles.sectionHeader}><h2>{t('stage.analysis')}</h2></header>
          <div className={styles.actions}>{active
            ? <button className={styles.button} type="button" disabled={mutation.running || Boolean(mutation.intent) || !online} onClick={() => mutate('cancel-analysis', {})}>{t('analysis.stop')}</button>
            : <button className={styles.button} type="button" disabled={!canAnalyze} onClick={() => setConfirmation({ kind: 'analyze', item })}>{t(item.analysis.generation ? 'action.reanalyze' : 'action.analyze')}</button>}</div>
          {!item.capabilities.analysis && item.state !== 'applied' && <p>{t('analysis.unavailable')}</p>}
          {item.analysis.generation >= 2 && <p>{t('catalog_review.analysis_limit')}</p>}
          {item.analysis.issue && <p role="status">{t(`issue.${item.analysis.issue}`)}</p>}
        </section>
      </div>
      <div hidden={stage !== 'review'} role="tabpanel" id="catalog-review-panel-review" aria-labelledby="catalog-review-tab-review">
        {stage === 'review' && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><ImportReview draft={editor.draft} filenames={filenames} suggestions={item.suggestions.filter(value => value.field !== 'artistName')}
          selected={editor.suggestions} onSelect={suggestions => setEditor({ ...editor, suggestions })} disabled={savedOnly}
          onAdopt={selectedIds => mutate('adopt', { generation: item.analysis.generation, selectedIds, rejectIds: [] })}
          onReject={rejectIds => mutate('adopt', { generation: item.analysis.generation, selectedIds: [], rejectIds })} /></Suspense>}
        {item.suggestions.some(value => value.field === 'artistName') && <section className={styles.panel}><h2>{t('field.artistName')}</h2><p>{t('catalog_review.artist_hint')}</p>
          {item.suggestions.filter(value => value.field === 'artistName').map(value => <article key={value.id} className={styles.card}>
            <div className={styles.diff}><div><strong>{t('review.baseline')}</strong><pre>{valueText(value.baseline)}</pre></div>
              <div><strong>{t('review.current')}</strong><pre>{valueText(editor.draft.album.artistName)}</pre></div>
              <div><strong>{t('review.suggested')}</strong><pre>{valueText(value.value)}</pre></div></div>
            {value.decision === 'pending' && <button className={styles.button} type="button" disabled={savedOnly}
              onClick={() => mutate('adopt', { generation: item.analysis.generation, selectedIds: [], rejectIds: [value.id] })}>{t('action.keep')}</button>}
          </article>)}</section>}
      </div>
      <div hidden={stage !== 'apply'} role="tabpanel" id="catalog-review-panel-apply" aria-labelledby="catalog-review-tab-apply">
        {stage === 'apply' && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><CatalogReviewApply item={item} changes={changes}
          selected={selected} disabled={savedOnly} onSelect={(key, checked) => setEditor({ ...editor, fields: checked
            ? [...editor.fields, key] : editor.fields.filter(value => value !== key) })}
          onConfirm={fields => setConfirmation({ kind: 'apply', item, fields })} /></Suspense>}
      </div>
      {confirmation && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><ModalDialog title={t(confirmation.kind === 'analyze' ? 'catalog_review.analysis_confirm' : 'catalog_review.apply_confirm')}
        description={t(confirmation.kind === 'analyze' ? 'catalog_review.analysis_copy' : 'catalog_review.apply_copy')}
        headerContent={<div className={styles.target}><strong>{confirmation.item.source.album.title || t('common.untitled')}</strong>
          {confirmation.kind === 'apply' && <p>{t('catalog_review.selected', { count: confirmation.fields.length })}</p>}</div>}
        initialFocusRef={cancel} onClose={() => setConfirmation(null)}>
        <div className={styles.dialogActions}><button className={styles.button} type="button" ref={cancel} onClick={() => setConfirmation(null)}>{t('common.cancel')}</button>
          <button className={`${styles.button} ${styles.primary}`} type="button" disabled={savedOnly || confirmation.item.revision !== item.revision
            || item.sourceStatus !== 'current' || (confirmation.kind === 'analyze' ? !canAnalyze : !item.capabilities.apply)} onClick={() => {
              setConfirmation(null);
              mutation.command.run(`${path}/${confirmation.kind}`, { expectedRevision: confirmation.item.revision,
                ...(confirmation.kind === 'apply' ? { fields: confirmation.fields } : {}) }, 'POST');
            }}>{t(confirmation.kind === 'analyze' ? 'catalog_review.analysis_confirm' : 'catalog_review.apply_action')}</button></div>
      </ModalDialog></Suspense>}
    </>}
  </section>;
}

export function AdminCatalogReviewPage({ projectId }: { projectId?: string } = {}) {
  const { reviewId = '' } = useParams();
  const id = projectId ?? reviewId, t = useAdminText();
  return <AdminGate>{/^[a-f0-9]{24}$/.test(id) ? <ReviewProject key={id} id={id} /> : <p className={styles.page}>{t('common.error')}</p>}</AdminGate>;
}
