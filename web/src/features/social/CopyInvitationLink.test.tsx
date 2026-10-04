import { act, fireEvent, render, screen } from '@testing-library/react';
import { advanceAccountEpoch } from '../../api/accountEpoch';
import { CopyInvitationLink } from './CopyInvitationLink';

const show = () => render(<CopyInvitationLink viewerId="viewer-a" invitationId="invitation-a" alias="Bob" disabled={false} />);

test('copying uses a recipient-bound web URL and provides an inspectable manual fallback', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Copy invitation link' }));
  expect(await screen.findByRole('textbox', { name: 'Invitation link' })).toHaveValue(`${window.location.origin}/finitude/social/invitations/invitation-a`);
  expect(screen.getByText('Copy the invitation link below.')).toBeVisible();
  expect(screen.getByText('Only Bob can accept this invitation.')).toBeVisible();
});

test('successful clipboard completion is reported only to the current account', async () => {
  let complete!: () => void;
  const writeText = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  show(); fireEvent.click(screen.getByRole('button', { name: 'Copy invitation link' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/finitude/social/invitations/invitation-a`);
  advanceAccountEpoch();
  await act(async () => complete());
  expect(screen.queryByText('Invitation link copied.')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('available clipboard reports success without renewing an invitation', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  show(); fireEvent.click(screen.getByRole('button', { name: 'Copy invitation link' }));
  expect(await screen.findByText('Invitation link copied.')).toBeVisible();
  expect(writeText).toHaveBeenCalledTimes(1);
});
