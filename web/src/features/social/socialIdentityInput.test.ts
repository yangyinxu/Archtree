import { aliasProblem, socialHandlePattern } from './socialIdentityInput';

test('nickname length counts trimmed, NFC-normalized code points like the server', () => {
  expect(aliasProblem('A')).toBeNull();
  expect(aliasProblem('A'.repeat(50))).toBeNull();
  expect(aliasProblem(`  ${'A'.repeat(50)}  `)).toBeNull();
  expect(aliasProblem('🎧'.repeat(50))).toBeNull();
  // Fifty decomposed letters normalize to fifty composed characters.
  expect(aliasProblem('é'.repeat(50))).toBeNull();
  expect(aliasProblem('A'.repeat(51))).toBe('social.alias_length');
  expect(aliasProblem('🎧'.repeat(51))).toBe('social.alias_length');
  expect(aliasProblem('')).toBe('social.alias_length');
  expect(aliasProblem(' \t ')).toBe('social.alias_length');
});

test('control and invisible formatting characters are refused, including a joiner inside combined emoji', () => {
  expect(aliasProblem('Ali‍ce')).toBe('social.alias_characters');
  expect(aliasProblem('👩‍👩‍👧')).toBe('social.alias_characters');
  expect(aliasProblem('Ali\u0007ce')).toBe('social.alias_characters');
  expect(aliasProblem('‮Alice')).toBe('social.alias_characters');
  expect(aliasProblem('Zoë 李')).toBeNull();
});

test('the handle pattern matches the server handle rule in either case', () => {
  const full = new RegExp(`^(?:${socialHandlePattern})$`);
  for (const handle of ['abc', 'Alice_01', `a${'b'.repeat(23)}`]) expect(full.test(handle)).toBe(true);
  for (const handle of ['ab', '1abc', '_abc', 'ali ce', 'alicé', `a${'b'.repeat(24)}`]) expect(full.test(handle)).toBe(false);
});
