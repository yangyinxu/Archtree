import { act, cleanup, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { loadCatalogArtwork } from './catalogArtworkLoader';
import { useCatalogArtwork } from './useCatalogArtwork';
import { deferred, viewer } from './adminFixtures.testSupport';

vi.mock('./catalogArtworkLoader', () => ({ loadCatalogArtwork: vi.fn() }));
const path = '/api/admin/v1/catalog/album/111111111111111111111111/artwork';
/** Renders exactly the hook's synchronous display decision, independent of image decoding. */
function Cover({ source = path, eager = true }: { source?: string; eager?: boolean }) {
  const image = useCatalogArtwork(source, viewer, eager);
  return <span ref={image.ref}>{image.src && <img src={image.src} alt="Private cover" />}</span>;
}
beforeEach(() => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin');
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:private-cover');
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); adminWorkspace.reset(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('a changed source hides its old blob immediately and revokes it', async () => {
  vi.mocked(loadCatalogArtwork).mockResolvedValueOnce(new Blob(['image'])).mockReturnValueOnce(new Promise(() => {}));
  const view = render(<Cover />);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:private-cover');
  view.rerender(<Cover source={path.replace('1111', '2222')} />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-cover');
});

test.each(['user', 'reset', 'account'] as const)('a %s transition clears private bytes and aborts old work', async transition => {
  vi.mocked(loadCatalogArtwork).mockResolvedValue(new Blob(['image']));
  render(<Cover />); await screen.findByRole('img');
  const signal = vi.mocked(loadCatalogArtwork).mock.calls[0][2];
  act(() => {
    if (transition === 'user') adminWorkspace.select('user');
    else if (transition === 'reset') adminWorkspace.reset();
    else adminWorkspace.authorize(captureAccountOperation('b'.repeat(24)), true, true);
  });
  expect(signal.aborted).toBe(true); expect(screen.queryByRole('img')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-cover');
});

test('an unmounted or revoked read never creates an object URL from late bytes', async () => {
  const late = deferred<Blob>(); vi.mocked(loadCatalogArtwork).mockReturnValue(late.promise);
  const view = render(<Cover />); view.unmount();
  await act(async () => late.resolve(new Blob(['image'])));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(vi.mocked(loadCatalogArtwork).mock.calls[0][2].aborted).toBe(true);
});

test('leaving Admin between rendering and passive effects does not capture an obsolete view', async () => {
  /** A layout transition can invalidate the render snapshot before the image effect starts. */
  function LeaveBeforeLoad() {
    const image = useCatalogArtwork(path, viewer, true);
    useLayoutEffect(() => { adminWorkspace.select('user'); }, []);
    return <span ref={image.ref} />;
  }
  expect(() => render(<LeaveBeforeLoad />)).not.toThrow();
  await act(async () => {});
  expect(loadCatalogArtwork).not.toHaveBeenCalled();
});

test('offscreen covers wait until near the viewport and disconnect their observer', async () => {
  let observed!: IntersectionObserverCallback;
  const disconnect = vi.fn(), observe = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observed = callback; }
    observe = observe; disconnect = disconnect;
  });
  vi.mocked(loadCatalogArtwork).mockResolvedValue(new Blob(['image']));
  render(<Cover eager={false} />); expect(observe).toHaveBeenCalled();
  expect(loadCatalogArtwork).not.toHaveBeenCalled();
  act(() => observed([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  await screen.findByRole('img'); expect(disconnect).toHaveBeenCalled();
});
