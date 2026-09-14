import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { RoomMedia } from '../../api/rooms';
import { RoomMediaPicker } from './RoomMediaPicker';
import * as roomMediaApi from '../../api/roomMedia';

const mocks = vi.hoisted(() => ({ search: vi.fn(), changed: vi.fn() }));
const track = (index: number, title = `Song ${index}`): RoomMedia => ({ mediaTrackId: index.toString(16).padStart(24, '0'), title,
  mediaRevision: `mr_${'a'.repeat(32)}`, durationMs: 185_000, mediaType: 'Audio',
  streamUrl: `/content/mediaTrack/stream/${index.toString(16).padStart(24, '0')}?revision=mr_${'a'.repeat(32)}` });
type PickerOptions = { viewerId: string; scopeKey: string; multiple?: boolean; disabled?: boolean; disabledMediaIds?: ReadonlySet<string> };
const Harness = ({ options, initial }: { options: PickerOptions; initial: RoomMedia[] }) => {
  const [selected, setSelected] = useState(initial);
  return <RoomMediaPicker {...options} selected={selected} onSelectionChange={items => { mocks.changed(items); setSelected(items); }} />;
};
const show = (settings: Partial<PickerOptions> = {}, initial: RoomMedia[] = []) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let options: PickerOptions = { viewerId: 'viewer-1', scopeKey: 'create', ...settings };
  const content = () => <StrictMode><QueryClientProvider client={client}>
    <Harness key={`${options.viewerId}:${options.scopeKey}`} options={options} initial={initial} />
  </QueryClientProvider></StrictMode>;
  const view = render(content());
  return { ...view, client, update(next: Partial<PickerOptions>) { options = { ...options, ...next }; view.rerender(content()); } };
};
const search = (query: string) => {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search room-ready songs' }), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
};
const choices = () => screen.getByRole('list', { name: 'Room-ready songs' });
beforeEach(() => {
  advanceAccountEpoch(); vi.clearAllMocks();
  // Spy on the real module so StrictMode's concurrent lazy imports share the same intercepted exports.
  vi.spyOn(roomMediaApi, 'searchRoomMedia').mockImplementation(mocks.search);
  mocks.search.mockResolvedValue({ items: [track(1)], nextCursor: null });
});

test('searches explicitly and retains removable selections across pages and search terms', async () => {
  mocks.search.mockImplementation(async (_viewer, input) => input.query ? { items: [track(3, 'Old favorite')], nextCursor: null }
    : input.cursor ? { items: [track(2)], nextCursor: null } : { items: [track(1)], nextCursor: 'second-page' });
  show({ multiple: true });
  expect(await screen.findByText(/Rooms currently support verified WAV audio/)).toBeVisible();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Song 1 3:05' }));
  expect(mocks.changed).toHaveBeenLastCalledWith([track(1)]);
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Song 2 3:05' }));
  expect(mocks.search).toHaveBeenCalledWith('viewer-1', { query: undefined, cursor: 'second-page' }, expect.any(AbortSignal));
  search('  Old favorite  ');
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Old favorite 3:05' }));
  expect(mocks.search).toHaveBeenCalledWith('viewer-1', { query: 'Old favorite', cursor: undefined }, expect.any(AbortSignal));
  expect(mocks.changed).toHaveBeenLastCalledWith([track(1), track(2), track(3, 'Old favorite')]);
  const selected = screen.getByRole('list', { name: 'Selected songs (3)' });
  expect(within(selected).getAllByRole('listitem')).toHaveLength(3);
  fireEvent.click(within(selected).getByRole('button', { name: 'Remove Song 1 from selection' }));
  expect(mocks.changed).toHaveBeenLastCalledWith([track(2), track(3, 'Old favorite')]);
  expect(within(choices()).queryByText('Song 1')).not.toBeInTheDocument();
});

test('late search results cannot replace a newer query and the previous choices are hidden while loading', async () => {
  let finish!: (value: { items: RoomMedia[]; nextCursor: null }) => void;
  mocks.search.mockImplementation(async (_viewer, input) => input.query === 'slow' ? new Promise(resolve => { finish = resolve; })
    : { items: [track(input.query ? 3 : 1)], nextCursor: null });
  show(); await screen.findByRole('radio', { name: 'Song 1 3:05' });
  search('slow'); await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  search('fast'); await screen.findByRole('radio', { name: 'Song 3 3:05' });
  await act(async () => { finish({ items: [track(2)], nextCursor: null }); });
  expect(screen.queryByRole('radio', { name: 'Song 2 3:05' })).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Song 3 3:05' })).toBeVisible();
});

test('empty intermediate pages retain Load more and empty completed searches explain the query', async () => {
  mocks.search.mockImplementation(async (_viewer, input) => input.query ? { items: [], nextCursor: null }
    : input.cursor ? { items: [track(90, 'An older song')], nextCursor: null } : { items: [], nextCursor: 'older' });
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
  await screen.findByRole('radio', { name: 'An older song 3:05' });
  search('missing'); expect(await screen.findByText('No room-ready songs matched “missing”.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

test('read failure hides cached results and explicit retry restores the search', async () => {
  const { client } = show(); await screen.findByRole('radio'); mocks.search.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => { await client.invalidateQueries({ queryKey: ['social', 'viewer-1', 'room-media-search'] }); });
  expect(await screen.findByRole('alert')).toBeVisible(); expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('radio')).toBeEnabled(); expect(mocks.changed).not.toHaveBeenCalled();
});

test('an expired pagination cursor refreshes from the first page while preserving the draft', async () => {
  let expired = false;
  mocks.search.mockImplementation(async (_viewer, input) => {
    if (input.cursor === 'expired') { expired = true; throw new Error('Cursor expired'); }
    if (input.cursor === 'fresh') return { items: [track(2)], nextCursor: null };
    return { items: [track(1)], nextCursor: expired ? 'fresh' : 'expired' };
  });
  show({ multiple: true }); fireEvent.click(await screen.findByRole('checkbox', { name: 'Song 1 3:05' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('alert'); expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Selected songs (1)' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('checkbox', { name: 'Song 1 3:05' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('checkbox', { name: 'Song 2 3:05' })).toBeEnabled();
  expect(mocks.search.mock.calls.filter(([, input]) => input.cursor === 'expired')).toHaveLength(1);
});

test('single selection excludes pending requests and replaces rather than accumulating choices', async () => {
  mocks.search.mockResolvedValue({ items: [track(1), track(2), track(3)], nextCursor: null });
  const view = show({ disabledMediaIds: new Set([track(1).mediaTrackId]) });
  expect(await screen.findByRole('radio', { name: 'Song 1 3:05 · Already requested' })).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: 'Song 2 3:05' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Song 3 3:05' }));
  expect(mocks.changed).toHaveBeenLastCalledWith([track(3)]);
  view.update({ disabled: true });
  for (const input of screen.getAllByRole('radio')) expect(input).toBeDisabled();
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
});

test('one hundred retained selections block additions until a selection is removed', async () => {
  const selected = Array.from({ length: 100 }, (_, index) => track(index + 1));
  mocks.search.mockResolvedValue({ items: [track(1), track(101)], nextCursor: null }); show({ multiple: true }, selected);
  expect(await screen.findByRole('checkbox', { name: 'Song 101 3:05' })).toBeDisabled();
  expect(screen.getByText('You can choose up to 100 songs for a room.')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'Song 1 3:05' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Song 1 from selection' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Song 101 3:05' }));
  expect(mocks.changed.mock.lastCall![0]).toHaveLength(100);
  expect(mocks.changed.mock.lastCall![0].at(-1)).toEqual(track(101));
});

test.each(['account', 'membership'])('changing %s cancels old reads and isolates the new selection draft', async change => {
  let finish!: (value: { items: RoomMedia[]; nextCursor: null }) => void;
  let oldSignal: AbortSignal | undefined;
  mocks.search.mockImplementation((_viewer, input, signal) => {
    if (input.query === 'old') { oldSignal = signal; return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve({ items: [track(1)], nextCursor: null });
  });
  const view = show(); fireEvent.click(await screen.findByRole('radio', { name: 'Song 1 3:05' }));
  search('old'); await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.update(change === 'account' ? { viewerId: 'viewer-2' } : { scopeKey: 'room-new-epoch-member' });
  await waitFor(() => expect(oldSignal?.aborted).toBe(true));
  await act(async () => { finish({ items: [track(2)], nextCursor: null }); });
  expect(screen.queryByRole('list', { name: /Selected songs/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: 'Song 2 3:05' })).not.toBeInTheDocument();
  expect(screen.getByRole('searchbox')).toHaveValue('');
});
