import { render } from '@testing-library/react';
import { SocialAvatar, socialIconHue, socialInitial } from './SocialAvatar';

afterEach(() => { vi.unstubAllGlobals(); });

test('the generated icon color is a stable function of the seed alone', () => {
  const seeds = ['alice', 'bob', `s_${'a'.repeat(32)}`, `s_${'b'.repeat(32)}`, '', 'é'];
  for (const seed of seeds) {
    const hue = socialIconHue(seed);
    expect(Number.isInteger(hue) && hue >= 0 && hue < 360).toBe(true);
    expect(socialIconHue(seed)).toBe(hue);
  }
  // Different people usually get different colors, so two with the same initial stay apart.
  expect(new Set(seeds.map(socialIconHue)).size).toBeGreaterThan(3);
});

test('the initial is the first user-perceived character, uppercased in place', () => {
  expect(socialInitial('alice')).toBe('A');
  expect(socialInitial('🇯🇵 Kenji')).toBe('🇯🇵');
  expect(socialInitial('émile')).toBe('É');
  expect(socialInitial('')).toBe('·');
});

test('without Intl.Segmenter the initial falls back to the first code point instead of a broken surrogate', () => {
  vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
  expect(socialInitial('🎧 Night')).toBe('🎧');
  expect(socialInitial('zoë')).toBe('Z');
});

test('a card renders a decorative generated icon and a missing card keeps the neutral placeholder', () => {
  const { container, rerender } = render(<SocialAvatar profile={{ alias: 'bob', iconSeed: 'seed-1' }} />);
  const icon = container.firstElementChild as HTMLElement;
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon).toHaveTextContent('B');
  expect(icon.style.getPropertyValue('--avatar-hue')).toBe(String(socialIconHue('seed-1')));
  rerender(<SocialAvatar profile={null} />);
  const placeholder = container.firstElementChild as HTMLElement;
  expect(placeholder).toHaveTextContent('·');
  expect(placeholder.style.getPropertyValue('--avatar-hue')).toBe('');
});
