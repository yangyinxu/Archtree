import { readFileSync } from 'node:fs';
import { advanceAccountEpoch } from './accountEpoch';
import { artistFollowStatusSchema, getArtistFollowStatuses, personalizationCapabilitiesSchema, setArtistFollowing } from './artistFollows';
import { albumSummarySchema, listenerHomeSchema } from './contentSchemas';
import { getListenerHome } from './listener';

const id = '000000000000000000000065';
const other = '000000000000000000000066';
const confirmed = { artistId: id, following: true, followedAt: '2026-10-12T15:00:00.000Z' };
const response = (payload: unknown) => new Response(JSON.stringify(payload), {
  headers: { 'Content-Type': 'application/json', 'X-Finitude-Account-Viewer': 'viewer-a' }
});
const fixture = (name: string) => JSON.parse(readFileSync(`../test/fixtures/personalization/v1/${name}`, 'utf8'));
afterEach(() => vi.restoreAllMocks());

test('shared Home fixture preserves exact ordered content IDs and structured reasons only in context', () => {
  const parsed = listenerHomeSchema.parse(fixture('listener-home.json'));
  const expected = fixture('followed-artist-releases.json').expectedItems;
  expect(parsed.sections[0].items.map((item) => ({ contentType: item.contentType, contentId: item.id, reason: item.reason })))
    .toEqual(expected.map(({ order: _order, ...item }: {order:number}) => item));
  expect(albumSummarySchema.parse(parsed.sections[0].items[0])).not.toHaveProperty('reason');
  expect(personalizationCapabilitiesSchema.parse(fixture('personalization-capabilities.json')).artistFollows).toBe(true);
});

test.each([
  { ...confirmed, following: false }, { ...confirmed, followedAt: null },
  { ...confirmed, followedAt: 'invalid' }, { ...confirmed, privateUserId: 'secret' }
])('rejects inconsistent or non-allowlisted status %j', (value) => {
  expect(artistFollowStatusSchema.safeParse(value).success).toBe(false);
});

test('Home negotiates new response shape and preserves current-account viewer header', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response(fixture('listener-home.json')));
  vi.stubGlobal('fetch', fetchMock);
  await getListenerHome('viewer-a');
  const headers = fetchMock.mock.calls[0][1].headers as Headers;
  expect(headers.get('X-Finitude-Personalization-Version')).toBe('1');
  expect(headers.get('X-Finitude-Account-Viewer')).toBe('viewer-a');
});

test.each([
  { items: [] }, { items: [confirmed, confirmed] },
  { items: [{ ...confirmed, artistId: other }] }
])('rejects incomplete, duplicate, or substituted batch receipt', async (payload) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(payload)));
  await expect(getArtistFollowStatuses('viewer-a', [id])).rejects.toMatchObject({ kind: 'invalid-response' });
});

test('batch receipt retains input order and mutation uses naturally idempotent verbs', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(response({items:[confirmed]})).mockResolvedValueOnce(response(confirmed));
  vi.stubGlobal('fetch', fetchMock);
  expect((await getArtistFollowStatuses('viewer-a', [id])).items).toEqual([confirmed]);
  expect(await setArtistFollowing('viewer-a', id, true)).toEqual(confirmed);
  expect(fetchMock.mock.calls[1][0]).toBe(`/content/me/artist-follows/${id}`);
  expect(fetchMock.mock.calls[1][1]).toMatchObject({method:'PUT',body:'{}'});
});

test('mutation never accepts a substituted or opposite receipt', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({...confirmed, following:false, followedAt:null})));
  await expect(setArtistFollowing('viewer-a', id, true)).rejects.toMatchObject({kind:'invalid-response'});
});

test('late response after an account epoch change cannot publish private follow state', async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {release=resolve;})));
  const pending=getArtistFollowStatuses('viewer-a', [id]);
  advanceAccountEpoch();
  release(response({items:[confirmed]}));
  await expect(pending).rejects.toMatchObject({code:'account_viewer_mismatch'});
});

test('contextual reasons accept an existing public Artist name longer than 200 characters',()=>{
 const home=fixture('listener-home.json');
 home.sections[0].items[0].reason.artist.name='Lorem '.repeat(50);
 expect(listenerHomeSchema.parse(home).sections[0].items[0].reason?.artist.name).toBe('Lorem '.repeat(50).trim());
});
