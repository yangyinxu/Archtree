import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { CatalogCover } from './CatalogCover';
import { detail, json, projectId, session, slotId, viewer } from './adminFixtures.testSupport';
import type { CatalogItem } from './catalogApi';
const item:CatalogItem={kind:'artist',id:'111111111111111111111111',revision:`cr_${'a'.repeat(43)}`,visibility:'public',effectiveVisibility:'public',coverUrl:'/api/admin/v1/catalog/artist/111111111111111111111111/artwork',mediaUrl:null,capabilities:{editing:true,visibility:true},fields:{name:'Synthetic artist',bio:'',birthDate:null}};
const operationId='30000000-0000-4000-8000-000000000003';
function mount(removed=vi.fn(),snapshot:CatalogItem|null=item){const client=new QueryClient();client.setQueryData(['browser-session'],session);const confirmed=vi.fn();render(<QueryClientProvider client={client}><MemoryRouter><CatalogCover item={snapshot} kind={item.kind} id={item.id} disabled={false} onConfirmed={confirmed} onRemoved={removed}/></MemoryRouter></QueryClientProvider>);return confirmed;}
beforeEach(()=>{adminWorkspace.reset();adminWorkspace.authorize(captureAccountOperation(viewer),true,true,undefined,{editing:true,visibility:true});adminWorkspace.select('admin');});
afterEach(()=>{cleanup();adminWorkspace.reset();vi.unstubAllGlobals();});
test('ready source cover selection captures both revisions and requires separate approval; cleanup pending is confirmed success',async()=>{
  const source=detail();source.assets=[{slotId:'cover',state:'ready',byteLength:3,sha256:'a'.repeat(64),contentType:'image/jpeg',tags:null,recovery:{operationId,expectedRevision:1,kind:'upload',startedByMe:true}}];const writes:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:string,init:RequestInit)=>{
    if(init.method==='POST'){const body=JSON.parse(String(init.body));writes.push(body);return json({item,receipt:{operationId:body.operationId},coverOperation:{state:'complete',cleanupPending:true}});}
    if(path.endsWith('/cover-operations'))return json({items:[]});
    if(path.includes('/imports?')){const {manifest,draft,suggestions,decisions:_decisions,capabilities:_capabilities,receipts:_receipts,assets:_assets,published:_published,publicationRecovery:_recovery,selectedCoverSlotId:_selected,...common}=source;return json({items:[{...common,title:'Synthetic source',rootLabel:manifest.rootLabel,artistName:'',visibility:'hidden',pendingSuggestions:suggestions.length}],counts:{all:1,analyzing:0,awaitingReview:1,needsAttention:0,completed:0},nextCursor:null});}
    return json({item:source,receipt:null});
  }));
  const confirmed=mount();await waitFor(()=>expect(screen.getByRole('button',{name:'Choose from import projects'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Choose from import projects'}));fireEvent.click(await screen.findByRole('button',{name:'Synthetic source'}));fireEvent.click(await screen.findByRole('button',{name:/Use this image/}));expect(writes).toHaveLength(0);fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Replace catalog cover'}));
  await waitFor(()=>expect(confirmed).toHaveBeenCalledWith(item));expect(writes[0]).toMatchObject({expectedRevision:item.revision,expectedSourceRevision:source.revision,importId:projectId,slotId:'cover'});expect(await screen.findByText('The cover change is confirmed. Previous image cleanup still needs attention.')).toBeVisible();
});
test('after reopening, only the initiating administrator can reconcile original cover receipt without generating a new key',async()=>{
  const writes:Array<{path:string;body:string}>=[];vi.stubGlobal('fetch',vi.fn(async(path:string,init:RequestInit)=>{if(init.method==='POST'){writes.push({path,body:String(init.body)});return json({item,receipt:{operationId},coverOperation:{state:'complete',cleanupPending:false}});}return json({items:[{operationId,startedByMe:true,state:'needsAttention',cleanupPending:false},{operationId:'40000000-0000-4000-8000-000000000004',startedByMe:false,state:'needsAttention',cleanupPending:false}]});}));mount();
  await screen.findByRole('button',{name:'Resume operation'});expect(screen.getAllByRole('button',{name:'Resume operation'})).toHaveLength(1);expect(screen.getByRole('button',{name:'Choose from import projects'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Resume operation'}));await waitFor(()=>expect(writes).toHaveLength(1));expect(writes[0]).toEqual({path:`/api/admin/v1/catalog/artist/${item.id}/cover-operations/${operationId}/reconcile`,body:'{}'});expect(await screen.findByText('The catalog cover change is confirmed.')).toBeVisible();
});
test('clear cover is separately confirmed and a lost response retains DELETE plus original payload',async()=>{
  const writes:Array<{method:string;body:string}>=[];vi.stubGlobal('fetch',vi.fn(async(path:string,init:RequestInit)=>{if(init.method==='DELETE'){writes.push({method:init.method,body:String(init.body)});throw new TypeError('offline');}return json({items:[]});}));mount();await waitFor(()=>expect(screen.getByRole('button',{name:'Remove catalog cover'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Remove catalog cover'}));expect(writes).toHaveLength(0);fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Remove catalog cover'}));fireEvent.click(await screen.findByRole('button',{name:'Retry original operation'}));await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[0]).toEqual(writes[1]);expect(JSON.parse(writes[0].body)).toMatchObject({expectedRevision:item.revision});expect(writes[0].body).not.toContain('importId');
});

test('cancelling an unconfirmed operation requires explicit review and retries its new immutable cancellation UUID',async()=>{
  const writes:Array<{path:string;body:string}>=[];let cancelled=false;
  vi.stubGlobal('fetch',vi.fn(async(path:string,init:RequestInit)=>{
    if(init.method==='POST'){writes.push({path,body:String(init.body)});if(writes.length===1)throw new TypeError('offline');cancelled=true;return json({item,receipt:{operationId:JSON.parse(String(init.body)).operationId},coverOperation:{state:'cancelled',cleanupPending:false}});}
    return json({items:[{operationId,startedByMe:false,state:cancelled?'cancelled':'needsAttention',cleanupPending:false}]});
  }));mount();fireEvent.click(await screen.findByRole('button',{name:'Cancel approval'}));expect(writes).toHaveLength(0);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Cancel approval'}));
  fireEvent.click(await screen.findByRole('button',{name:'Retry original operation'}));
  await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[0]).toEqual(writes[1]);
  expect(writes[0].path).toBe(`/api/admin/v1/catalog/artist/${item.id}/cover-operations/${operationId}/cancel`);
  const body=JSON.parse(writes[0].body);expect(body.expectedRevision).toBe(item.revision);expect(body.operationId).not.toBe(operationId);
  expect(await screen.findByText('The unconfirmed cover change is cancelled.')).toBeVisible();
  await waitFor(()=>expect(screen.getByRole('button',{name:'Choose from import projects'})).toBeEnabled());
});
test('cancelled cleanup can be reconciled by another administrator and absent owner is never fabricated',async()=>{
  const removed=vi.fn();vi.stubGlobal('fetch',vi.fn(async(_path:string,init:RequestInit)=>init.method==='POST'?json({item:null,receipt:{operationId},coverOperation:{state:'cancelled',cleanupPending:false}}):json({items:[{operationId,startedByMe:false,state:'cancelled',cleanupPending:true}]})));
  const confirmed=mount(removed);fireEvent.click(await screen.findByRole('button',{name:'Retry cleanup'}));
  await waitFor(()=>expect(removed).toHaveBeenCalledOnce());expect(confirmed).not.toHaveBeenCalled();
});

test('a confirmed cancellation cannot reopen an obsolete approval from a delayed operations read', async () => {
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'POST') {
      writes.push(path);
      return json({ item, receipt: { operationId: path.endsWith('/cancel') ? JSON.parse(String(init.body)).operationId : operationId }, coverOperation: { state: 'cancelled', cleanupPending: path.endsWith('/cancel') } });
    }
    return json({ items: [{ operationId, startedByMe: true, state: 'needsAttention', cleanupPending: false }] });
  }));
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Cancel approval' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel approval' }));
  const cleanup = await screen.findByRole('button', { name: 'Retry cleanup' });
  expect(screen.queryByRole('button', { name: 'Cancel approval' })).not.toBeInTheDocument();
  fireEvent.click(cleanup);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toBe(`/api/admin/v1/catalog/artist/${item.id}/cover-operations/${operationId}/reconcile`);
});
