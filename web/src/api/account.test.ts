import {
  completeBrowserRegistration,
  confirmBrowserEmailVerification,
  getBrowserAuthenticationCapabilities,
  inspectBrowserEmailVerification,
  inspectBrowserRegistration,
  requestBrowserEmailVerification,
  requestBrowserPasswordReset,
  requestBrowserRegistration,
  resetBrowserPassword
} from './account';
import { ApiError } from './client';

const linkToken = 'Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

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

test('requests registration and verification links with only the normalized email', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
    message: 'Check your email for the next step.'
  }, 202)));
  vi.stubGlobal('fetch', fetchMock);

  await expect(requestBrowserRegistration({ email: ' Listener@Example.test ' })).resolves.toEqual({
    message: 'Check your email for the next step.'
  });
  await requestBrowserEmailVerification({ email: 'Legacy@Example.test' });
  await requestBrowserPasswordReset({ email: 'listener@example.test' });

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/auth/browser/registration/request', expect.objectContaining({
    body: JSON.stringify({ email: 'listener@example.test' }),
    credentials: 'same-origin',
    method: 'POST'
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/auth/browser/email-verification/request', expect.objectContaining({
    body: JSON.stringify({ email: 'legacy@example.test' }),
    method: 'POST'
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(3, '/auth/browser/password/forgot', expect.any(Object));
  const headers = new Headers(fetchMock.mock.calls[0][1].headers);
  expect(headers.get('Content-Type')).toBe('application/json');
});

test('link requests reject unexpected fields before any request', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  expect(() => requestBrowserRegistration({ email: 'listener@example.test', password: 'unexpected' } as never)).toThrow();
  expect(() => inspectBrowserRegistration({ token: 'too-short' })).toThrow();
  expect(() => inspectBrowserEmailVerification({ token: `${linkToken}=` })).toThrow();
  expect(() => confirmBrowserEmailVerification({ token: linkToken, email: 'x@example.test' } as never)).toThrow();
  expect(() => completeBrowserRegistration({ token: linkToken, password: 'short', displayName: 'Quiet Listener' })).toThrow();
  expect(() => completeBrowserRegistration({ token: linkToken, password: 'a private password', displayName: '   ' })).toThrow();
  expect(() => completeBrowserRegistration({ token: linkToken, password: 'a private password', displayName: 'x'.repeat(81) })).toThrow();
  expect(() => completeBrowserRegistration({ token: linkToken, password: 'a private password', displayName: 'Quiet\u0007Listener' })).toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('inspects and completes registration links with strict bodies and responses', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ email: 'listener@example.test' }))
    .mockResolvedValueOnce(jsonResponse({ email: 'listener@example.test' }, 201))
    .mockResolvedValueOnce(jsonResponse({ email: 'listener@example.test', userId: 'internal' }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(inspectBrowserRegistration({ token: linkToken })).resolves.toEqual({ email: 'listener@example.test' });
  await expect(completeBrowserRegistration({
    token: linkToken,
    password: 'a private password',
    displayName: '  Quiet Listener  '
  })).resolves.toEqual({ email: 'listener@example.test' });
  await expect(inspectBrowserRegistration({ token: linkToken })).rejects.toMatchObject({ kind: 'invalid-response' });

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/auth/browser/registration/inspect', expect.objectContaining({
    body: JSON.stringify({ token: linkToken }),
    credentials: 'same-origin',
    method: 'POST'
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/auth/browser/registration/complete', expect.objectContaining({
    body: JSON.stringify({ token: linkToken, password: 'a private password', displayName: 'Quiet Listener' }),
    method: 'POST'
  }));
});

test('keeps typed link failures for the pages and never retries through cookie refresh', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ code: 'link_invalid', message: 'This link is invalid, expired, or already used.' }, 400))
    .mockResolvedValueOnce(jsonResponse({ code: 'email_already_registered', message: 'This email already has an account.' }, 409))
    .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401));
  vi.stubGlobal('fetch', fetchMock);

  await expect(inspectBrowserRegistration({ token: linkToken })).rejects.toMatchObject({ status: 400, code: 'link_invalid' });
  await expect(completeBrowserRegistration({
    token: linkToken,
    password: 'a private password',
    displayName: 'Quiet Listener'
  })).rejects.toMatchObject({ status: 409, code: 'email_already_registered' });
  const unauthorized = await inspectBrowserEmailVerification({ token: linkToken }).catch((error: unknown) => error);
  expect(unauthorized).toBeInstanceOf(ApiError);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock).not.toHaveBeenCalledWith('/auth/browser/refresh', expect.anything());
});

test('inspects and confirms verification links with no-content confirmation', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ email: 'legacy@example.test' }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(inspectBrowserEmailVerification({ token: linkToken })).resolves.toEqual({ email: 'legacy@example.test' });
  await expect(confirmBrowserEmailVerification({ token: linkToken })).resolves.toBeUndefined();

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/auth/browser/email-verification/inspect', expect.objectContaining({
    body: JSON.stringify({ token: linkToken }),
    method: 'POST'
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/auth/browser/email-verification/confirm', expect.objectContaining({
    body: JSON.stringify({ token: linkToken }),
    credentials: 'same-origin',
    method: 'POST'
  }));
});

test('uses the no-content browser reset contract', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);

  await resetBrowserPassword({
    email: 'listener@example.test',
    code: '654321',
    password: 'another private password'
  });

  expect(fetchMock).toHaveBeenCalledWith('/auth/browser/password/reset', expect.objectContaining({
    body: JSON.stringify({ email: 'listener@example.test', code: '654321', password: 'another private password' }),
    credentials: 'same-origin',
    method: 'POST'
  }));
});
