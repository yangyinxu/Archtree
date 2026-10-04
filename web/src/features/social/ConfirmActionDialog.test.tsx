import { useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmActionDialog } from './ConfirmActionDialog';

const show = (confirmDisabled = false) => {
  const onConfirm = vi.fn(); const onCancel = vi.fn();
  render(<ConfirmActionDialog title="Block Bob?" description="Unblocking later does not restore the friendship."
    confirmLabel="Block" confirmDisabled={confirmDisabled} onConfirm={onConfirm} onCancel={onCancel} returnFocusRef={{ current: null }} />);
  return { onConfirm, onCancel, dialog: screen.getByRole('dialog', { name: 'Block Bob?' }) };
};

const Trigger = () => {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <><button type="button">Elsewhere</button><button type="button" ref={trigger} onClick={() => setOpen(true)}>Block</button>
    {open && <ConfirmActionDialog title="Block Bob?" description="Unblocking later does not restore the friendship." confirmLabel="Block"
      onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)} returnFocusRef={trigger} />}</>;
};

test('closing returns focus to the trigger even when clicking it did not focus it, as in Safari', async () => {
  render(<Trigger />);
  screen.getByRole('button', { name: 'Elsewhere' }).focus();
  // fireEvent.click does not move focus, like a Safari mouse click on a button.
  fireEvent.click(screen.getByRole('button', { name: 'Block' }));
  const dialog = screen.getByRole('dialog', { name: 'Block Bob?' });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Block' })).toHaveFocus();
});

test('the safe choice has focus, so Enter or Escape never performs the action', async () => {
  const { onConfirm, onCancel, dialog } = show();
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog).toHaveAccessibleDescription('Unblocking later does not restore the friendship.');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledOnce(); expect(onConfirm).not.toHaveBeenCalled();
});

test('the confirm button cannot run the action while another action is pending', () => {
  const { onConfirm, dialog } = show(true);
  expect(within(dialog).getByRole('button', { name: 'Block' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }));
  expect(onConfirm).not.toHaveBeenCalled();
});

test('only the explicit confirm button runs the action', () => {
  const { onConfirm, onCancel, dialog } = show();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }));
  expect(onConfirm).toHaveBeenCalledOnce(); expect(onCancel).not.toHaveBeenCalled();
});
