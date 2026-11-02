import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VideoCatalogLookup } from './VideoCatalogLookup';
import { adminEndpointRequest } from './adminTransport';

vi.mock('./AdminAccess', () => ({ useAdminAccess: () => ({ active: true, viewerId: 'synthetic', epoch: 1, generation: 1 }) }));
vi.mock('./adminPageText', () => ({ useAdminDeliveryText: () => (key: string) => key }));
vi.mock('./CatalogPresentation', () => ({ catalogName: (item: { fields: { title?: string; name?: string } }) => item.fields.title ?? item.fields.name }));
vi.mock('./adminTransport', () => ({ adminEndpointRequest: vi.fn() }));

const selected = { id: '111111111111111111111111', kind: 'album' as const, name: 'Selected Album', revision: 'saved-revision' };
const result = { id: '222222222222222222222222', kind: 'album', revision: 'new-revision', fields: { title: 'Another Album' } };
function setup() {
  const onChange = vi.fn(), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(adminEndpointRequest).mockResolvedValue({ items: [result], nextCursor: null });
  render(<QueryClientProvider client={client}><VideoCatalogLookup label="Album" kinds={['album']} value={selected} disabled={false} onChange={onChange} allowNone /><button>Outside</button></QueryClientProvider>);
  return { onChange, input: screen.getByRole('combobox'), client };
}
afterEach(cleanup);

test('query edits dismissed with Escape preserve the committed Album and return input focus', async () => {
  const { input, onChange } = setup();
  fireEvent.focus(input); fireEvent.change(input, { target: { value: 'unselected query' } });
  await screen.findByRole('option', { name: /Another Album/ });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(input).toHaveValue('Selected Album'); expect(input).toHaveFocus(); expect(onChange).not.toHaveBeenCalled();
});

test('outside pointer and focus leaving the field close it without clearing the selection', async () => {
  const { input, onChange } = setup();
  fireEvent.focus(input); await screen.findByRole('listbox');
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  fireEvent.focus(input); await screen.findByRole('listbox');
  fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument(); expect(onChange).not.toHaveBeenCalled(); expect(input).toHaveValue('Selected Album');
});

test('an internal option commits once and toggle dismissal wins over restoring input focus', async () => {
  const { input, onChange } = setup(); fireEvent.focus(input);
  const option = await screen.findByRole('option', { name: /Another Album/ });
  fireEvent.pointerDown(option); fireEvent.click(option);
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ id: result.id, kind: 'album', name: 'Another Album', revision: 'new-revision' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'video.lookup_open' })); await screen.findByRole('listbox');
  fireEvent.click(screen.getByRole('button', { name: 'video.lookup_close' }));
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument()); expect(input).toHaveFocus();
});

test('keyboard selection uses the active real catalog row without creating a typed identity', async () => {
  const { input, onChange } = setup(); fireEvent.focus(input); await screen.findByRole('option', { name: /Another Album/ });
  fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: result.id })); expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('No Album is an explicit keyboard choice rather than a side effect of dismissing a query', async () => {
  const { input, onChange } = setup(); fireEvent.focus(input); await screen.findByRole('listbox');
  fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledExactlyOnceWith(null); expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('Artist and Organization choices retain their typed identity when their ObjectIds are equal', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), onChange = vi.fn();
  vi.mocked(adminEndpointRequest).mockImplementation(async path => ({ items: [{ ...result, kind: path.startsWith('/catalog/artist') ? 'artist' : 'organization', fields: { name: path.startsWith('/catalog/artist') ? 'Same ID Artist' : 'Same ID Organization' } }], nextCursor: null }) as never);
  render(<QueryClientProvider client={client}><VideoCatalogLookup label="Subject" kinds={['artist', 'organization']} value={null} disabled={false} onChange={onChange} /></QueryClientProvider>);
  fireEvent.focus(screen.getByRole('combobox'));
  await screen.findByRole('option', { name: /Same ID Artist/ });
  fireEvent.click(screen.getByRole('option', { name: /Same ID Organization/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: result.id, kind: 'organization', name: 'Same ID Organization' }));
  client.clear();
});
