import {
  getBrowserAuthenticationCapabilities,
  registerBrowserAccount,
  requestBrowserPasswordReset,
  resendBrowserVerification,
  resetBrowserPassword,
  verifyBrowserEmail
} from './account';

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

test('uses the browser registration and non-enumerating email endpoints', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
    message: 'If the account can use this action, an email has been sent.'
  }, 202)));
  vi.stubGlobal('fetch', fetchMock);

  await registerBrowserAccount({
    email: ' Listener@Example.com ',
    password: 'a private password',
    displayName: 'Quiet Listener'
  });
  await resendBrowserVerification({ email: 'listener@example.com' });
  await requestBrowserPasswordReset({ email: 'listener@example.com' });

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/auth/browser/register', expect.objectContaining({
    body: JSON.stringify({
      email: 'listener@example.com',
      password: 'a private password',
      displayName: 'Quiet Listener'
    }),
    credentials: 'same-origin',
    method: 'POST'
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/auth/browser/email/resend-verification', expect.any(Object));
  expect(fetchMock).toHaveBeenNthCalledWith(3, '/auth/browser/password/forgot', expect.any(Object));
});

test('uses no-content browser verification and reset contracts', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);

  await verifyBrowserEmail({ email: 'listener@example.com', code: '123456' });
  await resetBrowserPassword({
    email: 'listener@example.com',
    code: '654321',
    password: 'another private password'
  });

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/auth/browser/email/verify', expect.objectContaining({
    body: JSON.stringify({ email: 'listener@example.com', code: '123456' }),
    credentials: 'same-origin',
    method: 'POST'
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/auth/browser/password/reset', expect.objectContaining({
    credentials: 'same-origin',
    method: 'POST'
  }));
});
