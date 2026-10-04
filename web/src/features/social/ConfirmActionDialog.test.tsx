import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmActionDialog } from './ConfirmActionDialog';

const show = (confirmDisabled = false) => {
  const onConfirm = vi.fn(); const onCancel = vi.fn();
  render(<ConfirmActionDialog title="Block Bob?" description="Unblocking later does not restore the friendship."
    confirmLabel="Block" confirmDisabled={confirmDisabled} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel, dialog: screen.getByRole('dialog', { name: 'Block Bob?' }) };
};

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
