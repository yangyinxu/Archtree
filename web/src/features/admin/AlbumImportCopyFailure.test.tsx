import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { CatalogAlbumFilesLink } from './CatalogAlbumFilesLink';
import { ImportAlbumTargetCard } from './ImportAlbumTargetCard';
import { session, viewer } from './adminFixtures.testSupport';

/**
 * A deploy removed the release-packaged copy of adding files to an Album while a tab was open: reading it fails. The Album page's
 * links are left out while the page around them keeps rendering, and the create page's target card asks for a reload, never
 * reporting the Album as eligible. All names and identifiers are synthetic.
 */
vi.mock('./adminPageText', async importOriginal => ({
  ...await importOriginal<typeof import('./adminPageText')>(),
  useAlbumImportText: () => { throw new TypeError('Failed to fetch dynamically imported module'); }
}));

beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.restoreAllMocks(); });

const mount = (children: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['browser-session'], session);
  render(<QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>);
};

test('an Album page link whose copy cannot load is left out while the page around it keeps rendering', () => {
  mount(<section><h1>Synthetic Album page</h1><CatalogAlbumFilesLink id={'f'.repeat(24)} /><p>Synthetic Tracks section</p><CatalogAlbumFilesLink id={'f'.repeat(24)} missing /></section>);
  expect(screen.getByRole('heading', { name: 'Synthetic Album page' })).toBeVisible();
  expect(screen.getByText('Synthetic Tracks section')).toBeVisible();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('a target card whose copy cannot load asks for a reload and never reports the Album as eligible', () => {
  const onEligible = vi.fn();
  mount(<ImportAlbumTargetCard albumId={'f'.repeat(24)} recheck={0} refused={false} onEligible={onEligible} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/Reload the page to continue/);
  expect(onEligible).not.toHaveBeenCalled();
});
