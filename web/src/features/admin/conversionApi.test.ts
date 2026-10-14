import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { conversionApi, conversionManifestSchema, conversionReceiptSchema } from './conversionApi';
import { json, viewer } from './adminFixtures.testSupport';

const trackId = '111111111111111111111111', operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operation = { operationId, trackId, status: 'awaitingUpload', upload: 'notStarted', publication: 'notStarted', ready: false,
  cleanupPending: false, issue: null, output: { sha256: 'a'.repeat(64), byteLength: 3, preset: 'mp3-320' } };
const manifest = { schemaVersion: 1, album: null, tracks: [{ id: trackId, albumId: null, revision: `cr_${'a'.repeat(43)}`,
  sourceRevision: `mr_${'b'.repeat(32)}`, title: 'Track', originalFileName: 'Track.wav', format: { container: 'WAVE', codec: 'PCM', lossless: true,
    sampleRate: 48000, channels: 2, bitDepth: 16, duration: 1 }, mediaUrl: `/api/admin/v1/catalog/audioTrack/${trackId}/media` }] };
beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('private source DTO rejects external, mismatched, raw storage and duplicate source identities', () => {
  expect(conversionManifestSchema.safeParse(manifest).success).toBe(true);
  for (const mediaUrl of ['https://example.com/source.wav', '/api/admin/v1/catalog/audioTrack/222222222222222222222222/media']) {
    expect(conversionManifestSchema.safeParse({ ...manifest, tracks: [{ ...manifest.tracks[0], mediaUrl }] }).success).toBe(false);
  }
  expect(conversionManifestSchema.safeParse({ ...manifest, s3Key: 'private' }).success).toBe(false);
  expect(conversionManifestSchema.safeParse({ ...manifest, tracks: [...manifest.tracks, ...manifest.tracks] }).success).toBe(false);
});

test('a valid empty Album can be previewed while an empty track selection cannot', () => {
  const album = { id: trackId, title: 'Empty Album', revision: `cr_${'a'.repeat(43)}`, membershipRevision: `cm_${'b'.repeat(43)}` };
  expect(conversionManifestSchema.safeParse({ schemaVersion: 1, album, tracks: [] }).success).toBe(true);
  expect(conversionManifestSchema.safeParse({ schemaVersion: 1, album: null, tracks: [] }).success).toBe(false);
  expect(conversionManifestSchema.safeParse({ schemaVersion: 1, album: { ...album, id: 'invalid' }, tracks: [] }).success).toBe(false);
});

test('MP3 multipart has an explicit boundary, typed bytes and a stable operation URL', async () => {
  let request: RequestInit | undefined, path = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { path = url; request = init; return json({ schemaVersion: 1, operation }); }));
  const guard = adminWorkspace.capture();
  await conversionApi.upload(trackId, operationId, new File(['abc'], 'Song.mp3', { type: 'untrusted' }), guard);
  expect(path).toBe(`/api/admin/v1/conversions/tracks/${trackId}/operations/${operationId}/upload`);
  const headers = new Headers(request!.headers);
  expect(headers.get('X-Finitude-Account-Viewer')).toBe(viewer);
  expect(headers.get('Content-Type')).toBe(`multipart/form-data; boundary=FinitudeConversion-${operationId}`);
  expect(conversionReceiptSchema.safeParse({ schemaVersion: 1, operation: { ...operation, output: { ...operation.output, secret: 'no' } } }).success).toBe(false);
});

test('changing to User view cannot dispatch a new conversion API call with a stale guard', async () => {
  vi.stubGlobal('fetch', vi.fn()); const guard = adminWorkspace.capture(); adminWorkspace.select('user');
  await expect(conversionApi.source('tracks', trackId, guard)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});
