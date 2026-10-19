import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LookupBox } from './LookupBox';
import type { ImportLookupView } from './importLookupApi';

/**
 * The summary's name box on its own: what it shows for each kind of run, the names it accepts and refuses, and that it keeps no
 * history and is disabled with the summary. All names are synthetic.
 */
const view = (input: ImportLookupView['input']) => ({ input }) as ImportLookupView;
function mount(lookup: ImportLookupView | null, disabled = false) {
  const onSubmit = vi.fn();
  render(<LookupBox lookup={lookup} rootLabel="Synthetic Folder" disabled={disabled} onSubmit={onSubmit} />);
  const box = screen.getByRole('group', { name: 'Look up by name' });
  return { onSubmit, box, name: within(box).getByRole('textbox', { name: 'Name' }), submit: within(box).getByRole('button', { name: 'Look up' }) };
}
afterEach(cleanup);

test('the box shows the last submitted name and kind, the folder name after a folder-name run, and nothing before a run or after a tag run', () => {
  let rendered = mount(view({ trigger: 'submitted', submitted: { kind: 'song', text: 'Typed Song' } }));
  expect(rendered.name).toHaveValue('Typed Song'); expect(within(rendered.box).getByRole('radio', { name: 'Song name' })).toBeChecked();
  cleanup();
  rendered = mount(view({ trigger: 'folder', submitted: null }));
  expect(rendered.name).toHaveValue('Synthetic Folder'); expect(within(rendered.box).getByRole('radio', { name: 'Album name' })).toBeChecked();
  for (const lookup of [null, view({ trigger: 'tags', submitted: null })]) {
    cleanup(); rendered = mount(lookup);
    expect(rendered.name).toHaveValue(''); expect(rendered.submit).toBeDisabled();
    expect(within(rendered.box).getByRole('radio', { name: 'Album name' })).toBeChecked();
  }
});

test('an empty or blank name cannot be submitted, a link is refused until edited, and a name is sent trimmed with its kind', () => {
  const { onSubmit, box, name, submit } = mount(null);
  expect(name).toHaveAttribute('maxlength', '200'); expect(name).toHaveAttribute('autocomplete', 'off');
  fireEvent.change(name, { target: { value: '   ' } }); expect(submit).toBeDisabled();
  for (const link of ['www.example.test/album', 'HTTPS://example.test/release/1']) {
    fireEvent.change(name, { target: { value: link } }); fireEvent.click(submit);
    expect(within(box).getByRole('alert')).toHaveTextContent('Enter a name, not a link.');
    expect(name).toHaveAttribute('aria-invalid', 'true'); expect(name).toHaveAccessibleDescription('Enter a name, not a link.');
  }
  expect(onSubmit).not.toHaveBeenCalled();
  // Editing clears the refusal; a name that only mentions a dot is a name.
  fireEvent.change(name, { target: { value: ' Synthetic Vol. 2 ' } });
  expect(within(box).queryByRole('alert')).not.toBeInTheDocument(); expect(name).toHaveAttribute('aria-invalid', 'false');
  fireEvent.submit(name.closest('form')!);
  expect(onSubmit).toHaveBeenCalledWith('album', 'Synthetic Vol. 2');
});

test('the box keeps no history, is no search landmark and is disabled with the summary', () => {
  localStorage.clear(); sessionStorage.clear();
  const { onSubmit, box, name, submit } = mount(null, true);
  expect(box).toBeDisabled(); expect(name).toBeDisabled(); expect(submit).toBeDisabled();
  for (const radio of within(box).getAllByRole('radio')) expect(radio).toBeDisabled();
  expect(screen.queryByRole('search')).not.toBeInTheDocument(); expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument(); expect(name).not.toHaveAttribute('list');
  cleanup();
  const enabled = mount(null);
  fireEvent.change(enabled.name, { target: { value: 'Synthetic Album' } }); fireEvent.click(enabled.submit);
  expect(enabled.onSubmit).toHaveBeenCalledOnce(); expect(onSubmit).not.toHaveBeenCalled();
  expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
});
