import { createRef } from 'react';
import { createPortal } from 'react-dom';
import { render, screen, within } from '@testing-library/react';
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
