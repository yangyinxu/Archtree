import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { LinkedByline, type BylineCredit } from './LinkedByline';

const credits: BylineCredit[] = [
  { subjectType: 'artist', subjectId: 'guest', name: 'Guest Voice', order: 1 },
  { subjectType: 'organization', subjectId: 'label', name: 'Finite Records', order: 2 },
  { subjectType: 'artist', subjectId: 'lead', name: 'Finite Ensemble', order: 0 }
];

const show = (text: string, list?: BylineCredit[]) => render(
  <MemoryRouter><p data-testid="byline"><LinkedByline credits={list} text={text} /></p></MemoryRouter>
);

test('keeps the server text verbatim, join phrases included', () => {
  show('Finite Ensemble & Guest Voice', credits);
  expect(screen.getByTestId('byline').textContent).toBe('Finite Ensemble & Guest Voice');
});

test('links credited names in Credit order and skips a label the byline omits', () => {
  show('Finite Ensemble & Guest Voice', credits);
  expect(screen.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Finite Ensemble', '/artists/lead'],
    ['Guest Voice', '/artists/guest']
  ]);
});

test('links an Organization named in the byline to its page', () => {
  show('Finite Records presents', credits);
  expect(screen.getByRole('link', { name: 'Finite Records' })).toHaveAttribute('href', '/organizations/label');
});

test('renders plain text without credits', () => {
  show('Finite Ensemble, Guest Voice');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByTestId('byline').textContent).toBe('Finite Ensemble, Guest Voice');
});
