import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ModalDialog } from '../../components/ModalDialog';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminEndpointRequest, adminRequest, importPath, type AdminGuard } from './adminTransport';
import { catalogItemSchema, type CatalogItem, type CatalogKind } from './catalogApi';
import { useAdminCommand } from './useAdminCommand';
import { useOnline } from './useAdminOnline';
import { adminWorkspace } from './adminWorkspace';
import styles from './adminStyles';
import type { CoverUpload } from './catalogCoverUpload';

// Import schemas load with the first source search, as conversionImportBridge loads them, keeping this route in its JavaScript budget.
const importSchemas = () => import('./adminApi');
const operationSchema = z.object({ state: z.enum(['copying','needsAttention','complete','cancelled']), cleanupPending: z.boolean() }).strict();
const resultSchema = z.object({ item: catalogItemSchema.nullable(), receipt: z.object({operationId:z.string()}).strict(), coverOperation: operationSchema }).strict().refine(value=>value.item!==null||value.coverOperation.state==='cancelled');
const listSchema = z.object({ items: z.array(operationSchema.extend({operationId:z.string().regex(/^[a-f0-9-]{36}$/i),startedByMe:z.boolean()}).strict()).max(256) }).strict();
// Upload helpers load on the first file choice; a failed load is retried by the next choice.
let uploadModule: Promise<typeof import('./catalogCoverUpload')> | undefined;
const loadUpload = () => uploadModule ??= import('./catalogCoverUpload').catch(error => { uploadModule = undefined; throw error; });
/** An upload sent under `owner`; an unknown outcome keeps it, with its in-memory bytes, for Retry until the view or account changes. */
type UploadIntent = { upload: CoverUpload; operationId: string; owner: AdminGuard };
const idle: { running: boolean; intent: UploadIntent | null; message: string | null } = { running: false, intent: null, message: null };
/** Existing cover changes copy an explicitly chosen ready private image; they never adopt a draft automatically. */
export function CatalogCover({item,kind,id,disabled,approvalDisabled=false,onConfirmed,onRemoved}:{item:CatalogItem|null;kind:CatalogKind;id:string;disabled:boolean;approvalDisabled?:boolean;onConfirmed:(item:CatalogItem)=>void;onRemoved:()=>void}) {
  const t=useAdminText(),access=useAdminAccess(),online=useOnline(),path=`/catalog/${kind}/${id}`;
  const [choosing,setChoosing]=useState(false),[search,setSearch]=useState(''),[queryText,setQueryText]=useState(''),[project,setProject]=useState<string|null>(null);
  const [approval,setApproval]=useState<{revision:string;label:string;source:{importId:string;slotId:string;expectedSourceRevision:number}|{uploadId:string}|null;preview?:string}|null>(null);
  const [upload,setUpload]=useState(idle),picker=useRef<HTMLInputElement>(null),approvalOpen=useRef(false);approvalOpen.current=Boolean(approval);
  const [cancellation,setCancellation]=useState<{operationId:string;revision:string|null;label:string}|null>(null);
  const label = item ? ('name' in item.fields ? item.fields.name : item.fields.title) || t('common.untitled') : t('cover.title');
  // A finished upload binds the item as it is then, not as it was when the file was chosen.
  const latest=useRef({item,label});latest.current={item,label};
  const cancel=useRef<HTMLButtonElement>(null);
  const pendingApproval = useRef<string | null>(null);
  const mutation=useAdminCommand(`cover:${kind}:${id}`,resultSchema.refine(value=>value.item===null||value.item.kind===kind&&value.item.id===id));
  const operations=useQuery({queryKey:['admin-imports',access.viewerId,access.epoch,access.generation,'cover-operations',kind,id],queryFn:({signal})=>adminEndpointRequest(`${path}/cover-operations`,listSchema,{signal}),enabled:access.active,retry:false,gcTime:0});
  const imports=useInfiniteQuery({queryKey:['admin-imports',access.viewerId,access.epoch,access.generation,'cover-sources',queryText],initialPageParam:null as string|null,queryFn:async({signal,pageParam})=>adminRequest(`?${new URLSearchParams({limit:'25',q:queryText,...(pageParam?{cursor:pageParam}:{})})}`,(await importSchemas()).workbenchSchema,{signal}),enabled:access.active&&choosing,getNextPageParam:page=>page.nextCursor??undefined,retry:false,gcTime:0});
  const source=useQuery({queryKey:['admin-imports',access.viewerId,access.epoch,access.generation,'cover-source',project],queryFn:async({signal})=>adminRequest(importPath(project!),(await importSchemas()).responseSchema.refine(value=>value.item.id===project),{signal}),enabled:access.active&&choosing&&Boolean(project),retry:false,gcTime:0});
  const recoveryDisabled=disabled||!access.active||!online||mutation.running;
  const locked=recoveryDisabled||Boolean(mutation.intent);
  // A new approval needs current editing authority; old exact-identity cleanup and cancellation do not.
  const newDisabled=locked||upload.running||Boolean(upload.intent)||approvalDisabled||!access.catalogEditing||!item?.capabilities.editing||operations.isPending||operations.isError||Boolean(operations.data?.items.some(operation=>!['complete','cancelled'].includes(operation.state)));
  const current=()=>adminWorkspace.current(access)&&navigator.onLine!==false;
  const [outcome,setOutcome]=useState<(z.infer<typeof operationSchema> & { operationId: string })|null>(null);
  useEffect(()=>{if(mutation.result){setOutcome({...mutation.result.coverOperation, operationId:pendingApproval.current ?? mutation.result.receipt.operationId});if(mutation.result.item)onConfirmed(mutation.result.item);else onRemoved();mutation.command.acknowledge();void operations.refetch();}},[mutation.result]);
  // The preview URL is revoked when its approval closes and on unmount; a view or account change drops a kept upload and its approval.
  useEffect(()=>{const preview=approval?.preview;return()=>{if(preview)URL.revokeObjectURL(preview);};},[approval?.preview]);
  useEffect(()=>()=>{setUpload(idle);setApproval(value=>value?.source&&'uploadId' in value.source?null:value);},[access.active,access.viewerId,access.epoch,access.generation]);
  const send=async(intent:UploadIntent)=>{
    if(!adminWorkspace.current(intent.owner))return;
    setUpload({running:true,intent,message:null});
    let m:typeof import('./catalogCoverUpload');
    try{m=await loadUpload();}catch{if(adminWorkspace.current(intent.owner))setUpload({...idle,message:'common.reload'});return;}
    try{
      const uploadId=await m.uploadCatalogCover(kind,id,intent.upload,intent.operationId,intent.owner);
      if(!adminWorkspace.current(intent.owner))return;
      // An approval opened meanwhile is left alone; the unused upload is deleted a day later.
      const now=latest.current;setUpload(idle);if(approvalOpen.current||!now.item)return;
      setApproval({revision:now.item.revision,label:now.label,source:{uploadId},preview:URL.createObjectURL(intent.upload.bytes)});
    }catch(error){if(!adminWorkspace.current(intent.owner))return;const refusal=m.coverUploadRefusal(error);setUpload({running:false,intent:refusal.keep?intent:null,message:refusal.message});}
  };
  const choose=async(file:File)=>{
    if(newDisabled||!current()||!item)return;
    let owner:AdminGuard;try{owner=adminWorkspace.capture();}catch{return;}
    setUpload({running:true,intent:null,message:null});
    let m:typeof import('./catalogCoverUpload');
    try{m=await loadUpload();}catch{if(adminWorkspace.current(owner))setUpload({...idle,message:'common.reload'});return;}
    const read=await m.readCoverUpload(file);if(!adminWorkspace.current(owner))return;
    if('refusal' in read){setUpload({...idle,message:read.refusal});return;}
    void send({upload:read,operationId:crypto.randomUUID(),owner});
  };
  const visibleOperations = operations.data?.items.map(operation => operation.operationId === outcome?.operationId ? { ...operation, ...outcome } : operation);
  const outcomeKey=(operation:z.infer<typeof operationSchema>)=>operation.state==='cancelled'?operation.cleanupPending?'cover.cancelled_cleanup':'cover.cancelled':operation.state==='complete'?operation.cleanupPending?'cover.cleanup_pending':'cover.complete':'cover.pending';
  if(!access.active)return null;
  return <section className={styles.panel}><header className={styles.sectionHeader}><div><h2>{t('cover.title')}</h2>{item && <p className={styles.muted}>{t('cover.editor_copy')}</p>}</div><button className={styles.button} disabled={operations.isFetching||recoveryDisabled} onClick={()=>{if(!recoveryDisabled&&current())void operations.refetch();}}>{t('common.refresh')}</button></header>
    {item && <div className={styles.actions}><button className={styles.button} disabled={newDisabled} onClick={()=>setChoosing(!choosing)}>{t('cover.choose')}</button><button className={styles.button} disabled={newDisabled} onClick={()=>picker.current?.click()}>{t('cover.upload')}</button><input hidden ref={picker} type="file" accept="image/jpeg,image/png,image/webp" disabled={newDisabled} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void choose(file);}}/>{item?.coverUrl&&<button className={styles.button} disabled={newDisabled} onClick={()=>setApproval({revision:item.revision,label,source:null})}>{t('cover.clear')}</button>}</div>}
    {mutation.error&&<div role="alert"><p>{t(`common.${mutation.error}`)}</p>{mutation.error==='reload'&&<button className={styles.button} type="button" onClick={()=>window.location.reload()}>{t('common.reload_action')}</button>}{mutation.intent&&<button className={styles.button} disabled={recoveryDisabled} onClick={()=>{if(!recoveryDisabled&&current())mutation.command.retry();}}>{t('common.retry_operation')}</button>}</div>}
    {upload.running&&<p role="status">{t('cover.uploading')}</p>}
    {upload.message&&<div role="alert"><p>{t(upload.message)}</p>{upload.message==='common.reload'&&<button className={styles.button} type="button" onClick={()=>window.location.reload()}>{t('common.reload_action')}</button>}{upload.intent&&<><button className={styles.button} disabled={recoveryDisabled||upload.running} onClick={()=>{if(upload.intent&&current()&&adminWorkspace.current(upload.intent.owner))void send(upload.intent);}}>{t('common.retry_operation')}</button><button className={styles.button} onClick={()=>setUpload(idle)}>{t('common.cancel')}</button></>}</div>}
    {outcome&&!visibleOperations?.some(operation=>operation.operationId === outcome.operationId && (!['complete','cancelled'].includes(operation.state)||operation.cleanupPending))&&<p role="status" className={styles.notice}>{t(outcomeKey(outcome))}</p>}
    {operations.isPending&&<p role="status">{t('common.loading')}</p>}
    {operations.isError&&<p role="alert">{t('common.error')}</p>}
    {visibleOperations?.filter(operation=>!['complete','cancelled'].includes(operation.state)||operation.cleanupPending).map(operation=><div key={operation.operationId} className={styles.recovery}><p>{t(outcomeKey(operation))}</p><div className={styles.actions}>{(operation.state==='cancelled'?operation.cleanupPending:operation.startedByMe)&&<button className={styles.button} disabled={locked} onClick={()=>{if(locked||!current())return;pendingApproval.current=operation.operationId;mutation.command.reconcile(`${path}/cover-operations/${operation.operationId}/reconcile`,operation.operationId);}}>{t(operation.state === 'cancelled' ? 'action.recover' : 'action.resume')}</button>}{!['complete','cancelled'].includes(operation.state)&&<button className={styles.button} disabled={locked} onClick={()=>{if(!locked&&current())setCancellation({operationId:operation.operationId,revision:item?.revision??null,label});}}>{t('action.cancel_approval')}</button>}</div></div>)}
    {choosing&&item&&<>
      <div className={styles.toolbar}><label>{t('workbench.search')}<input className={styles.input} maxLength={100} value={search} onChange={event=>setSearch(event.target.value)}/></label><button className={styles.button} onClick={()=>{setQueryText(search.trim());setProject(null);}}>{t('workbench.search')}</button></div>
      {imports.isPending&&<p role="status">{t('common.loading')}</p>}{imports.isError&&<p role="alert">{t('common.error')}</p>}
      <div className={styles.actions}>{[...new Map((imports.data?.pages.flatMap(page=>page.items)??[]).map(project=>[project.id,project])).values()].map(project=><button className={styles.button} key={project.id} onClick={()=>setProject(project.id)}>{project.title||project.rootLabel}</button>)}{imports.hasNextPage&&<button className={styles.button} disabled={imports.isFetchingNextPage} onClick={()=>void imports.fetchNextPage()}>{t('workbench.more')}</button>}</div>
      {source.isFetching&&<p role="status">{t('common.loading')}</p>}{source.isError&&<p role="alert">{t('common.error')}</p>}
      {source.data?.item.assets.filter(asset=>asset.state==='ready'&&asset.contentType.startsWith('image/')).map(asset=><button key={asset.slotId} className={styles.artworkChoice} disabled={newDisabled} onClick={()=>setApproval({revision:item.revision,label,source:{importId:source.data!.item.id,slotId:asset.slotId,expectedSourceRevision:source.data!.item.revision}})}><img width={96} height={96} alt={t('media.cover_candidate')} src={`/api/admin/v1/imports/${source.data!.item.id}/assets/${encodeURIComponent(asset.slotId)}/preview?viewer=${encodeURIComponent(access.viewerId)}`}/>{t('cover.use')}</button>)}
      {source.isSuccess&&!source.data.item.assets.some(asset=>asset.state==='ready'&&asset.contentType.startsWith('image/'))&&<p>{t('cover.no_candidates')}</p>}
    </>}
    {approval&&<ModalDialog title={t('cover.confirm')} description={t('cover.confirm_copy')} headerContent={<div className={styles.target}><strong>{approval.label}</strong>{approval.preview&&<img src={approval.preview} alt={t('cover.upload_preview')} width={96} height={96} onLoad={event=>{const image=event.currentTarget,max=Math.max(image.naturalWidth,image.naturalHeight);if(max){image.width=Math.round(96*image.naturalWidth/max);image.height=Math.round(96*image.naturalHeight/max);}}}/>}</div>} initialFocusRef={cancel} onClose={()=>setApproval(null)}><div className={styles.dialogActions}><button ref={cancel} className={styles.button} onClick={()=>setApproval(null)}>{t('common.cancel')}</button><button className={styles.button} disabled={newDisabled||approval.revision!==item?.revision} onClick={()=>{if(newDisabled||!current()||!adminWorkspace.getSnapshot().catalogEditing||approval.revision!==item?.revision)return;pendingApproval.current=null;mutation.command.run(`${path}/cover`,{expectedRevision:approval.revision,...approval.source},approval.source?'POST':'DELETE');setApproval(null);setChoosing(false);}}>{t(approval.source?'cover.replace':'cover.clear')}</button></div></ModalDialog>}
    {cancellation&&<ModalDialog title={t('cover.cancel_confirm')} description={t('cover.cancel_confirm_copy')} headerContent={<div className={styles.target}><strong>{cancellation.label}</strong><p className={styles.muted}>{t(`catalog.${kind}`)}</p></div>} initialFocusRef={cancel} onClose={()=>setCancellation(null)}><details className={styles.details}><summary>{t('action.details')}</summary><p>{id}</p><p>{cancellation.operationId}</p></details><div className={styles.dialogActions}><button ref={cancel} className={styles.button} onClick={()=>setCancellation(null)}>{t('action.keep_reviewing')}</button><button className={`${styles.button} ${styles.primary}`} disabled={locked||cancellation.revision!==(item?.revision??null)} onClick={()=>{if(locked||!current()||cancellation.revision!==(item?.revision??null))return;pendingApproval.current=cancellation.operationId;mutation.command.run(`${path}/cover-operations/${cancellation.operationId}/cancel`,{expectedRevision:cancellation.revision},'POST');setCancellation(null);}}>{t('action.cancel_approval')}</button></div></ModalDialog>}
  </section>;
}
