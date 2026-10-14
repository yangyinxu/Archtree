import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { AdminControls, AdminGate, AdminViewLabel } from './AdminAccess';
import { adminWorkspace } from './adminWorkspace';
import { adminRequest } from './adminApi';
import { z } from 'zod';
import { capabilities, deferred, json, session, viewer } from './adminFixtures.testSupport';
import { advanceAccountEpoch } from '../../api/accountEpoch';

const mount = (role = 'admin') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['browser-session'], { ...session, user: { ...session.user, role } });
  render(<QueryClientProvider client={client}><MemoryRouter><AdminControls /><AdminGate><p>Private workbench</p></AdminGate></MemoryRouter></QueryClientProvider>);
  return client;
};
beforeEach(() => adminWorkspace.reset());
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); });

test('ordinary users never fetch admin capability or render its switch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); mount('user');
  expect(screen.queryByRole('button', { name: /Current view/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Private workbench')).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
});
test('confirmed administrators start in User view; explicit switch preserves account epoch', async () => {
  const fetch = vi.fn(async () => json(capabilities)); vi.stubGlobal('fetch', fetch); mount();
  const before = adminWorkspace.getSnapshot().epoch;
  await screen.findByRole('button', { name: 'Current view: User' });
  expect(screen.queryByText('Private workbench')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Admin view' }));
  await screen.findByText('Private workbench');
  const epoch = adminWorkspace.getSnapshot().epoch; expect(epoch).toBeGreaterThanOrEqual(before);
  fireEvent.click(screen.getByRole('button', { name: 'Current view: Admin' }));
  fireEvent.click(screen.getByRole('button', { name: 'User' }));
  expect(screen.queryByText('Private workbench')).not.toBeInTheDocument();
  expect(adminWorkspace.getSnapshot().epoch).toBe(epoch); expect(fetch).toHaveBeenCalledTimes(2);
});
test('late capability response cannot revive private access after explicit permission rejection', async () => {
  const pending = deferred<Response>(); let count = 0;
  vi.stubGlobal('fetch', vi.fn(async path => {
    if (String(path).endsWith('capabilities')) return ++count <= 2 ? json(capabilities) : pending.promise;
    return json({ code: 'ADMIN_REQUIRED' }, 403);
  }));
  const client = mount(); await screen.findByRole('button', { name: 'Switch to Admin view' });
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Admin view' }));
  await screen.findByText('Private workbench');
  let rejection!: Promise<unknown>;
  await act(async () => { rejection = adminRequest('/x', z.object({})).catch(() => undefined); await client.invalidateQueries({ queryKey: ['admin-capabilities'], refetchType: 'none' }); void client.refetchQueries({ queryKey: ['admin-capabilities'] }); await rejection; });
  await act(async () => pending.resolve(json(capabilities)));
  await waitFor(() => expect(adminWorkspace.getSnapshot().authorized).toBe(false));
  expect(screen.queryByText('Private workbench')).not.toBeInTheDocument();
});
test('account epoch synchronously erases private presentation and buffers, including same-user ABA', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(capabilities))); const client = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Switch to Admin view' }));
  await screen.findByText('Private workbench');
  adminWorkspace.retain('sensitive', 'draft', adminWorkspace.capture());
  act(() => { advanceAccountEpoch(); client.setQueryData(['browser-session'], null); });
  expect(adminWorkspace.buffer('sensitive')).toBeUndefined(); expect(screen.queryByText('Private workbench')).not.toBeInTheDocument();
  act(() => { advanceAccountEpoch(); client.setQueryData(['browser-session'], session); });
  await screen.findByRole('button', { name: 'Current view: User' });
  expect(adminWorkspace.getSnapshot().viewerId).toBe(viewer); expect(screen.queryByText('Private workbench')).not.toBeInTheDocument();
});


test.each([
  ['Current view: Admin', 'Admin', 'Current view:'],
  ['Current view: User', 'User', 'Current view:'],
  ['当前视角：管理员', '管理员', '当前视角：'],
  ['当前视角：用户', '用户', '当前视角：']
])('view label %s intentionally separates its intact role', (label, role, prefix) => {
  render(<button aria-label={label}><AdminViewLabel label={label} role={role} /></button>);
  const button = screen.getByRole('button', { name: label });
  expect(button.children).toHaveLength(1);
  expect(button.firstElementChild?.tagName).toBe('SPAN');
  expect(button.querySelector(':scope > br')).toBeNull();
  expect(button.firstChild).toHaveTextContent(prefix);
  expect(button.querySelector('br')).not.toBeNull();
  expect(screen.getByText(role)).toHaveStyle({ whiteSpace: 'nowrap' });
});
test('an unfamiliar view label stays complete without a guessed line break', () => {
  render(<AdminViewLabel label="View changed" role="Admin" />);
  expect(screen.getByText('View changed')).toBeVisible();
  expect(document.querySelector('br')).toBeNull();
});
