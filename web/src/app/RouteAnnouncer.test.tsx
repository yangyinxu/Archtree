import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { RouteAnnouncer } from './RouteAnnouncer';

afterEach(cleanup);

test.each([
  ['/admin/imports', 'Workbench'],
  ['/admin/imports/new', 'Upload new Album'],
  ['/admin/imports/111111111111111111111111', 'Album import'],
  ['/admin/catalog-reviews/111111111111111111111111', 'Album completion'],
  ['/admin/catalog', 'Catalog'],
  ['/admin/catalog/album/111111111111111111111111', 'Edit catalog content'],
  ['/admin/catalog/artist/111111111111111111111111', 'Edit catalog content'],
  ['/admin/catalog/audioTrack/111111111111111111111111', 'Edit catalog content'],
  ['/admin/catalog/organization/111111111111111111111111', 'Edit catalog content'],
  ['/admin/pages', 'Page items'],
  ['/missing-listener-page', 'Page not found']
])('announces %s using its matching title', async (path, title) => {
  render(<MemoryRouter initialEntries={[path]}><RouteAnnouncer /></MemoryRouter>);
  expect(await screen.findByText(`${title} page`)).toBeInTheDocument();
  expect(document.title).toBe(`${title} · Finitude`);
});
