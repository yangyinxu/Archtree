import { createRef } from 'react';
import { createPortal } from 'react-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModalDialog } from './ModalDialog';

test('a body-level dialog retains its accessible title without creating another page banner', () => {
  const focus = createRef<HTMLButtonElement>();
  render(<><header>Site navigation</header>{createPortal(<ModalDialog title="Share music" initialFocusRef={focus} onClose={vi.fn()}>
    <button ref={focus}>Close</button>
  </ModalDialog>, document.body)}</>);
  const dialog = screen.getByRole('dialog', { name: 'Share music' });
  expect(within(dialog).getByRole('heading', { level: 2, name: 'Share music' })).toBeVisible();
  expect(screen.getAllByRole('banner')).toHaveLength(1);
});


test('a frozen administrator target precedes its description and preserves focus and Escape', async () => {
  const focus = createRef<HTMLButtonElement>(); const close = vi.fn();
  render(<ModalDialog title="Change visibility?" description="Only this placement changes." headerContent={<strong>Featured releases</strong>} initialFocusRef={focus} onClose={close}>
    <button ref={focus}>Cancel</button><button>Hide this placement</button>
  </ModalDialog>);
  const dialog = screen.getByRole('dialog', { name: 'Change visibility?' });
  expect(dialog).toHaveAccessibleDescription('Only this placement changes.');
  const target = within(dialog).getByText('Featured releases'), description = within(dialog).getByText('Only this placement changes.');
  expect(target.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await waitFor(() => expect(focus.current).toHaveFocus());
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(within(dialog).getByRole('button', { name: 'Hide this placement' })).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' }); expect(close).toHaveBeenCalledTimes(1);
});
