import {
  avatarMutationResultSchema,
  deleteAvatar,
  getPrivateAvatar,
  replaceAvatar
} from './avatar';

const mutationResult = {
  avatarRevision: 8,
  avatar: { assetId: 'avatar-8', revision: 8 },
  cleanupPending: false
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const blobText = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

test('uploads only a JPEG multipart body with revision and idempotency headers', async () => {
  const fetchMock = vi.fn(async () => jsonResponse(mutationResult));
  vi.stubGlobal('fetch', fetchMock);

  await expect(replaceAvatar(
    new Blob(['confirmed crop'], { type: 'image/jpeg' }),
    7,
    'listener-1',
    'replace-operation'
  )).resolves.toEqual(mutationResult);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const headers = new Headers(init.headers);
  expect(path).toBe('/auth/avatar');
  expect(init.method).toBe('PUT');
  expect(init.credentials).toBe('same-origin');
  expect(headers.get('If-Match')).toBe('7');
  expect(headers.get('Idempotency-Key')).toBe('replace-operation');
  expect(headers.get('X-Finitude-Avatar-Viewer')).toBe('listener-1');
  expect(headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=FinitudeWebAvatar-/);
  const body = await blobText(init.body as Blob);
  expect(body).toContain('name="avatar"; filename="avatar.jpg"');
  expect(body).toContain('confirmed crop');
});

test('deletes with the same revision and idempotency contract', async () => {
  const response = { avatarRevision: 9, avatar: null };
  const fetchMock = vi.fn(async () => jsonResponse(response));
  vi.stubGlobal('fetch', fetchMock);

  await expect(deleteAvatar(8, 'listener-1', 'delete-operation')).resolves.toEqual(response);

  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const headers = new Headers(init.headers);
  expect(path).toBe('/auth/avatar');
  expect(init.method).toBe('DELETE');
  expect(headers.get('If-Match')).toBe('8');
  expect(headers.get('Idempotency-Key')).toBe('delete-operation');
  expect(headers.get('X-Finitude-Avatar-Viewer')).toBe('listener-1');
});

test('rejects mutation responses containing undeclared account data', () => {
  expect(avatarMutationResultSchema.safeParse({
    ...mutationResult,
    accessToken: 'must-not-enter-avatar-state'
  }).success).toBe(false);
});

test('does not retry private bytes after authentication resolves another account', async () => {
  const anotherSession = {
    user: {
      id: 'listener-2',
      email: 'other@example.com',
      role: 'user',
      displayName: 'Other',
      avatarRevision: 1,
      avatar: { revision: 1 },
      emailVerified: true
    }
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
    String(input) === '/auth/avatar'
      ? jsonResponse({}, 401)
      : jsonResponse(anotherSession)
  ));
  vi.stubGlobal('fetch', fetchMock);

  await expect(getPrivateAvatar('listener-1', 3)).rejects.toMatchObject({ status: 401 });
  expect(fetchMock.mock.calls.filter(([path]) => String(path) === '/auth/avatar')).toHaveLength(1);
});

test('accepts only non-empty image responses for the current account', async () => {
  const fetchMock = vi.fn(async () => new Response(new Blob(['private image']), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg' }
  }));
  vi.stubGlobal('fetch', fetchMock);

  const blob = await getPrivateAvatar('listener-1', 3);
  expect(blob.size).toBeGreaterThan(0);
  expect(fetchMock).toHaveBeenCalledWith('/auth/avatar', expect.objectContaining({
    cache: 'no-store',
    credentials: 'same-origin',
    headers: expect.objectContaining({
      'X-Finitude-Avatar-Revision': '3',
      'X-Finitude-Avatar-Viewer': 'listener-1'
    })
  }));
});
