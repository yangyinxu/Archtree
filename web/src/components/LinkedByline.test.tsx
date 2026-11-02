import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { LinkedByline, type BylineCredit } from './LinkedByline';

const credits: BylineCredit[] = [
  { subjectType: 'artist', subjectId: 'guest', name: 'Guest Voice', order: 1, role: 'featured' },
  { subjectType: 'organization', subjectId: 'label', name: 'Finite Records', order: 2, role: 'label' },
  { subjectType: 'artist', subjectId: 'lead', name: 'Finite Ensemble', order: 0, role: 'primary' }
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
  show('Finite Records presents', credits.filter(credit => credit.subjectType === 'organization'));
  expect(screen.getByRole('link', { name: 'Finite Records' })).toHaveAttribute('href', '/organizations/label');
});

test.each(['composer', 'label'] as const)('an omitted %s cannot link the prefix of a performing Artist name', (role) => {
  show('Lorem Ensemble', [
    { subjectType: role === 'label' ? 'organization' : 'artist', subjectId: 'omitted', name: 'Lorem', order: 0, role },
    { subjectType: 'artist', subjectId: 'performer', name: 'Lorem Ensemble', order: 1, role: 'primary' }
  ]);
  expect(screen.getByTestId('byline').textContent).toBe('Lorem Ensemble');
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Lorem Ensemble' })).toHaveAttribute('href', '/artists/performer');
});

test('falls back to Organizations before other roles, ignoring empty performing names', () => {
  show('Lorem Records', [
    { subjectType: 'artist', subjectId: 'missing', name: '', order: 0, role: 'performer' },
    { subjectType: 'artist', subjectId: 'composer', name: 'Lorem', order: 1, role: 'composer' },
    { subjectType: 'organization', subjectId: 'records', name: 'Lorem Records', order: 2, role: 'label' }
  ]);
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Lorem Records' })).toHaveAttribute('href', '/organizations/records');
});

test('falls back to all visible Credits in order and links a repeated name only at its first Credit', () => {
  show('Lorem Composer & Ipsum Producer', [
    { subjectType: 'artist', subjectId: 'producer', name: 'Ipsum Producer', order: 2, role: 'producer' },
    { subjectType: 'artist', subjectId: 'duplicate', name: 'Lorem Composer', order: 1, role: 'remixer' },
    { subjectType: 'artist', subjectId: 'composer', name: 'Lorem Composer', order: 0, role: 'composer' }
  ]);
  expect(screen.getByTestId('byline').textContent).toBe('Lorem Composer & Ipsum Producer');
  expect(screen.getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Lorem Composer', '/artists/composer'], ['Ipsum Producer', '/artists/producer']
  ]);
});

test('renders plain text without credits', () => {
  show('Finite Ensemble, Guest Voice');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByTestId('byline').textContent).toBe('Finite Ensemble, Guest Voice');
});
