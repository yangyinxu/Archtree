import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';

import { readLinkToken, useLinkToken } from './linkToken';

const token = 'Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const otherToken = 'Zyxwvutsrqponmlkjihgfedcba9876543210-_EDCBA';

test('reads only an exact token fragment', () => {
  expect(readLinkToken(`#token=${token}`)).toBe(token);
  for (const hash of [
    '',
    '#',
    `token=${token}`,
    `#token=${token.slice(1)}`,
    `#token=${token}A`,
    `#token=${token}=`,
    `#token=${token}&next=/account`,
    `#next=/account&token=${token}`,
    `#Token=${token}`,
    `#token=${token.slice(0, 42)}+`,
    `#token=${token.slice(0, 42)}/`
  ]) {
    expect(readLinkToken(hash)).toBeNull();
  }
});

const TokenProbe = () => {
  const captured = useLinkToken();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="token">{captured ?? 'none'}</p>
      <p data-testid="location">{`${location.pathname}|${location.hash}|${JSON.stringify(location.state)}`}</p>
      <button onClick={() => navigate(`/verify-email#token=${otherToken}`)} type="button">Open another link</button>
    </>
  );
};

test('captures the token under StrictMode and strips the fragment and router state', async () => {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[{ pathname: '/verify-email', hash: `#token=${token}`, state: { leak: token } }]}>
        <TokenProbe />
      </MemoryRouter>
    </StrictMode>
  );

  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/verify-email||null'));
  expect(screen.getByTestId('token')).toHaveTextContent(token);
});

test('a malformed fragment is stripped without producing a token', async () => {
  render(
    <MemoryRouter initialEntries={['/register/complete#token=short']}>
      <TokenProbe />
    </MemoryRouter>
  );

  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/register/complete||null'));
  expect(screen.getByTestId('token')).toHaveTextContent('none');
});

test('a different link opened in the same tab replaces the captured token', async () => {
  render(
    <MemoryRouter initialEntries={[`/verify-email#token=${token}`]}>
      <TokenProbe />
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/verify-email||null'));

  fireEvent.click(screen.getByRole('button', { name: 'Open another link' }));

  await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent(otherToken));
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/verify-email||null'));
});
