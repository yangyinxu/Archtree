import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminViewSwitcher } from './AdminViewSwitcher';

afterEach(cleanup);

test('shows a compact role and an explicit checked choice without reselecting the current view', async () => {
  const user = userEvent.setup(), select = vi.fn();
  render(<AdminViewSwitcher mode="admin" onSelect={select} />);
  const trigger = screen.getByRole('button', { name: 'Current view: Admin' });
  expect(trigger).toHaveTextContent(/^Admin$/);
  expect(trigger.querySelector('br')).toBeNull();
  expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await user.click(trigger);
  const selected = screen.getByRole('menuitemradio', { name: 'Admin' });
  expect(selected).toHaveAttribute('aria-checked', 'true');
  expect(selected).toHaveFocus();
  expect(screen.getByRole('menuitemradio', { name: 'User' })).toHaveAttribute('aria-checked', 'false');
  await user.click(selected);
  expect(select).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(screen.getByRole('menuitemradio', { name: 'User' }));
  expect(select).toHaveBeenCalledExactlyOnceWith('user');
});

test('arrow keys wrap, Home and End navigate, and Escape returns focus to the trigger', async () => {
  const user = userEvent.setup();
  render(<AdminViewSwitcher mode="user" onSelect={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: 'Current view: User' });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  const admin = screen.getByRole('menuitemradio', { name: 'Admin' });
  const listener = screen.getByRole('menuitemradio', { name: 'User' });
  expect(admin).toHaveFocus();
  await user.keyboard('{ArrowUp}'); expect(listener).toHaveFocus();
  await user.keyboard('{ArrowDown}'); expect(admin).toHaveFocus();
  await user.keyboard('{End}'); expect(listener).toHaveFocus();
  await user.keyboard('{Home}'); expect(admin).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
  await user.keyboard('{ArrowUp}'); expect(screen.getByRole('menuitemradio', { name: 'User' })).toHaveFocus();
});

test('outside pointer or focus dismisses without stealing focus, and Tab can leave the menu', async () => {
  const user = userEvent.setup();
  render(<><AdminViewSwitcher mode="user" onSelect={vi.fn()} /><button>Outside</button></>);
  const trigger = screen.getByRole('button', { name: 'Current view: User' });
  const outside = screen.getByRole('button', { name: 'Outside' });
  await user.click(trigger);
  await user.click(outside);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(outside).toHaveFocus();
  await user.click(trigger); outside.focus();
  expect(await screen.findByRole('button', { name: 'Outside' })).toHaveFocus();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await user.click(trigger); await user.tab();
  expect(outside).toHaveFocus(); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await user.click(trigger); await user.tab({ shift: true });
  expect(trigger).toHaveFocus(); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('multiple switches use distinct controlled menu identities', () => {
  render(<><AdminViewSwitcher mode="admin" onSelect={vi.fn()} /><AdminViewSwitcher mode="user" onSelect={vi.fn()} /></>);
  const [admin, listener] = screen.getAllByRole('button');
  fireEvent.click(admin);
  const adminMenu = admin.getAttribute('aria-controls');
  fireEvent.click(listener);
  expect(listener.getAttribute('aria-controls')).not.toBe(adminMenu);
});
