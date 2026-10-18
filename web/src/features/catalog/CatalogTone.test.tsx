import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { listenerCapabilitiesQueryKey } from '../../api/listenerCapabilities';
import { browserSessionQueryKey } from '../../api/session';
import { sampleArtworkTone } from '../../artwork/artworkTone';
import { neutralArtworkTone } from '../../artwork/useArtworkTone';
import { ArtistPage } from './ArtistPage';
import { OrganizationPage } from './OrganizationPage';

vi.mock('../../artwork/artworkTone', () => ({ sampleArtworkTone: vi.fn() }));

const sample = vi.mocked(sampleArtworkTone);
const tone = { hero: '#6a2f8a', pane: '#45205c' };
const artwork = '/content/images/0000000000000000000000a7';

/** Serves one catalog response and answers every other request as not found. */
const serve = (path: string, body: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string) => (
  url.includes(path)
    ? new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ message: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
)));

const mount = (path: string, routePath: string, page: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(browserSessionQueryKey, null);
  client.setQueryData(listenerCapabilitiesQueryKey, { playlists: false });
  const main = document.createElement('main');
  main.id = 'main-content';
  document.body.append(main);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path={routePath} element={page} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
    { container: main }
  );
  return { paneTone: () => main.style.getPropertyValue('--tone-color'), ...view };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('Artist tints the main pane with its pane tone, neutral while sampling, and clears it on leave', async () => {
  let finish!: (value: typeof tone) => void;
  sample.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  serve('/artists/artist-1', {
    artist: { contentType: 'artist', id: 'artist-1', name: 'Finite Ensemble', bio: '', artworkUrl: artwork },
    albums: [],
    audioTracks: []
  });
  const { paneTone, unmount } = mount('/artists/artist-1', '/artists/:artistId', <ArtistPage />);

  await screen.findByRole('heading', { level: 1, name: 'Finite Ensemble' });
  expect(paneTone()).toBe(neutralArtworkTone.pane);
  await waitFor(() => expect(sample).toHaveBeenCalledWith(`${artwork}/v1/96.webp`));
  await act(async () => finish(tone));
  expect(paneTone()).toBe(tone.pane);

  unmount();
  expect(paneTone()).toBe('');
});

test('Organization keeps the neutral pane tone because it has no artwork', async () => {
  serve('/organizations/org-1', {
    organization: { id: 'org-1', name: 'Finite Records', organizationType: 'Label', description: '' },
    releases: []
  });
  const { paneTone, unmount } = mount('/organizations/org-1', '/organizations/:organizationId', <OrganizationPage />);

  await screen.findByRole('heading', { level: 1, name: 'Finite Records' });
  expect(paneTone()).toBe(neutralArtworkTone.pane);
  expect(sample).not.toHaveBeenCalled();
  unmount();
  expect(paneTone()).toBe('');
});
