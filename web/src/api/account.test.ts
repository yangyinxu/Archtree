import { getBrowserAuthenticationCapabilities } from './account';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

test('reads only browser-ready authentication capabilities', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    password: true,
    emailRegistration: true,
    apple: false,
    google: false,
    passkey: false
  }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(getBrowserAuthenticationCapabilities()).resolves.toEqual({
    password: true,
    emailRegistration: true,
    apple: false,
    google: false,
    passkey: false
  });
  expect(fetchMock).toHaveBeenCalledWith(
    '/auth/browser/capabilities',
    expect.objectContaining({ credentials: 'same-origin' })
  );
});
