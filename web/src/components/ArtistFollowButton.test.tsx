import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArtistFollowButton } from './ArtistFollowButton';
import { artistFollowQueryKey, personalizationCapabilitiesQueryKey } from '../api/artistFollows';
import { browserSessionQueryKey } from '../api/session';
import { advanceAccountEpoch } from '../api/accountEpoch';

const id='000000000000000000000065';
const falseStatus={artistId:id,following:false,followedAt:null};
const trueStatus={artistId:id,following:true,followedAt:'2026-10-12T15:00:00.000Z'};
const json=(payload:unknown,status=200)=>new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json','X-Finitude-Account-Viewer':'viewer-a'}});
const session=(viewerId:string)=>({user:{id:viewerId,email:'synthetic@example.test',displayName:'Lorem',role:'user',emailVerified:true,authenticationMethods:['password']}});
function renderButton(signedIn=true, status:unknown=falseStatus) {
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
 client.setQueryData(browserSessionQueryKey,signedIn?session('viewer-a'):null);
 client.setQueryData(personalizationCapabilitiesQueryKey,{contractVersion:1,deterministicDiscovery:false,artistFollows:true});
 if(status)client.setQueryData(artistFollowQueryKey('viewer-a',id),status);
 render(<QueryClientProvider client={client}><ArtistFollowButton artistId={id}/></QueryClientProvider>);
 return client;
}
afterEach(()=>vi.restoreAllMocks());

test('signed-out activation explains sign-in without dispatching a follow or navigating',async()=>{
 const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);renderButton(false);
 await userEvent.click(screen.getByRole('button',{name:'Follow'}));
 expect(screen.getByRole('alert')).toHaveTextContent('Log in');expect(fetchMock).not.toHaveBeenCalled();
});

test('confirmation changes state and invalidates only that account Home',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(json(trueStatus)));
 const client=renderButton(); const invalidate=vi.spyOn(client,'invalidateQueries');
 await userEvent.click(screen.getByRole('button',{name:'Follow'}));
 expect(await screen.findByRole('button',{name:'Following'})).toHaveAttribute('aria-pressed','true');
 expect(invalidate).toHaveBeenCalledWith({queryKey:['listener','home','viewer-a']});
});

test('pending state is disabled and failed mutation preserves confirmed state with explicit retry',async()=>{
 let release!:(value:Response)=>void;
 const fetchMock=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve;})).mockResolvedValueOnce(json(trueStatus));
 vi.stubGlobal('fetch',fetchMock);renderButton();
 await userEvent.click(screen.getByRole('button',{name:'Follow'}));
 expect(await screen.findByRole('button',{name:'Following…'})).toBeDisabled();
 await act(async()=>release(json({message:'Unavailable'},503)));
 expect(await screen.findByRole('button',{name:'Follow'})).toHaveAttribute('aria-pressed','false');
 await userEvent.click(screen.getByRole('button',{name:'Retry update'}));
 expect(await screen.findByRole('button',{name:'Following'})).toBeInTheDocument();
});

test('unknown failed status stays unavailable until an explicit successful retry',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(json({message:'Unavailable'},503)).mockResolvedValueOnce(json({items:[falseStatus]})));
 renderButton(true,null);
 expect(await screen.findByRole('button',{name:'Retry follow status'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Checking your account…'})).toBeDisabled();
 await userEvent.click(screen.getByRole('button',{name:'Retry follow status'}));
 expect(await screen.findByRole('button',{name:'Follow'})).toBeEnabled();
});

test('late acknowledgement after account switch cannot restore the previous follow cache',async()=>{
 let release!:(value:Response)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;})));
 const client=renderButton();
 await userEvent.click(screen.getByRole('button',{name:'Follow'}));
 await waitFor(()=>expect(release).toBeDefined());
 await act(async()=>{advanceAccountEpoch();client.removeQueries({queryKey:artistFollowQueryKey('viewer-a',id)});client.setQueryData(browserSessionQueryKey,null);release(json(trueStatus));});
 expect(await screen.findByRole('button',{name:'Follow'})).toHaveAttribute('aria-disabled','true');
 expect(client.getQueryData(artistFollowQueryKey('viewer-a',id))).toBeUndefined();
});

test('explicit disabled flag hides the action and obsolete private Home source',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(json({code:'ARTIST_FOLLOWS_DISABLED'},503)));
 const client=renderButton();
 await userEvent.click(screen.getByRole('button',{name:'Follow'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Follow'})).not.toBeInTheDocument());
 expect(client.getQueryData(personalizationCapabilitiesQueryKey)).toMatchObject({artistFollows:false});
});

test('a delayed capability true cannot reopen Follow after the explicit disabled mutation gate',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(json({code:'ARTIST_FOLLOWS_DISABLED'},503)));
 const client=renderButton();
 let release!:(value:unknown)=>void;
 const stale=client.fetchQuery({queryKey:personalizationCapabilitiesQueryKey,staleTime:0,queryFn:({signal})=>{
   void signal;return new Promise(resolve=>{release=resolve;});
 }}).catch(()=>undefined);
 await userEvent.click(screen.getByRole('button',{name:'Follow'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Follow'})).not.toBeInTheDocument());
 await act(async()=>release({contractVersion:1,deterministicDiscovery:false,artistFollows:true}));
 await stale;
 expect(client.getQueryData(personalizationCapabilitiesQueryKey)).toMatchObject({artistFollows:false});
 expect(screen.queryByRole('button',{name:'Follow'})).not.toBeInTheDocument();
});

test('a late inactive Home read cannot restore releases after confirmed Unfollow',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(json(falseStatus)));
 const client=renderButton(true,trueStatus);
 const homeKey=['listener','home','viewer-a'];
 const oldHome={title:'Home',sections:[{id:'private',title:'New releases',presentation:'carousel',items:[{reason:{code:'followedArtist',artist:{id,name:'Lorem'}}}]}]};
 client.setQueryData(homeKey,oldHome);
 let release!:(value:unknown)=>void;
 const pending=client.fetchQuery({queryKey:homeKey,staleTime:0,queryFn:({signal})=>{
   void signal;return new Promise(resolve=>{release=resolve;});
 }}).catch(()=>undefined);
 await userEvent.click(screen.getByRole('button',{name:'Following'}));
 expect(await screen.findByRole('button',{name:'Follow'})).toHaveAttribute('aria-pressed','false');
 await act(async()=>release(oldHome));await pending;
 expect(client.getQueryData(homeKey)).toMatchObject({sections:[]});
});

test('Artist A to B to A navigation fences an old mutation even in the same account',async()=>{
 const other='000000000000000000000066';
 let release!:(value:Response)=>void;
 vi.stubGlobal('fetch',vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve;})).mockResolvedValueOnce(json(falseStatus)));
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
 client.setQueryData(browserSessionQueryKey,session('viewer-a'));
 client.setQueryData(personalizationCapabilitiesQueryKey,{contractVersion:1,deterministicDiscovery:false,artistFollows:true});
 client.setQueryData(artistFollowQueryKey('viewer-a',id),falseStatus);
 client.setQueryData(artistFollowQueryKey('viewer-a',other),{...falseStatus,artistId:other});
 const view=(artistId:string)=><QueryClientProvider client={client}><ArtistFollowButton artistId={artistId}/></QueryClientProvider>;
 const {rerender}=render(view(id));
 await userEvent.click(screen.getByRole('button',{name:'Follow'}));
 await waitFor(()=>expect(release).toBeDefined());
 rerender(view(other));
 await act(async()=>client.setQueryData(artistFollowQueryKey('viewer-a',id),trueStatus));
 rerender(view(id));
 await userEvent.click(await screen.findByRole('button',{name:'Following'}));
 expect(await screen.findByRole('button',{name:'Follow'})).toHaveAttribute('aria-pressed','false');
 await act(async()=>release(json(trueStatus)));
 expect(client.getQueryData(artistFollowQueryKey('viewer-a',id))).toEqual(falseStatus);
});
