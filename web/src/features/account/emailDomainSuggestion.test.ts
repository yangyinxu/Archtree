import {
  damerauLevenshteinDistance,
  suggestEmailCorrection,
  suggestedEmailProviderDomains
} from './emailDomainSuggestion';

describe('damerauLevenshteinDistance', () => {
  test.each([
    ['', '', 0],
    ['abc', '', 3],
    ['', 'abc', 3],
    ['gmail.com', 'gmail.com', 0],
    ['kitten', 'sitting', 3],
    ['gmial.com', 'gmail.com', 1],
    ['gmai.com', 'gmail.com', 1],
    ['gmaill.com', 'gmail.com', 1],
    ['gnail.com', 'gmail.com', 1],
    ['gmal.co', 'gmail.com', 2],
    // The unrestricted distance may edit a transposed pair again; the restricted variant needs 3.
    ['ca', 'abc', 2]
  ])('%j to %j is %i', (left, right, expected) => {
    expect(damerauLevenshteinDistance(left, right)).toBe(expected);
    expect(damerauLevenshteinDistance(right, left)).toBe(expected);
  });

  test('counts code points, so an astral character is one edit', () => {
    expect(damerauLevenshteinDistance('\u{1F600}a', 'a\u{1F600}')).toBe(1);
    expect(damerauLevenshteinDistance('gmail.c\u{1F600}m', 'gmail.com')).toBe(1);
  });
});

describe('suggestEmailCorrection', () => {
  test.each([
    ['gmial.com', 'gmail.com'],
    ['gmail.con', 'gmail.com'],
    ['gmail.co', 'gmail.com'],
    ['gmailcom', 'gmail.com'],
    ['googlemial.com', 'googlemail.com'],
    ['outlok.com', 'outlook.com'],
    ['hotmial.com', 'hotmail.com'],
    ['live.con', 'live.com'],
    ['yaho.com', 'yahoo.com'],
    ['iclod.com', 'icloud.com'],
    ['me.con', 'me.com'],
    ['proton.m', 'proton.me'],
    ['protonmial.com', 'protonmail.com'],
    ['qq.con', 'qq.com'],
    ['163.con', '163.com'],
    ['126.co', '126.com'],
    ['foxmial.com', 'foxmail.com'],
    ['sian.com', 'sina.com']
  ])('corrects %s to %s', (typed, provider) => {
    expect(suggestEmailCorrection(`lorem@${typed}`)).toBe(`lorem@${provider}`);
  });

  test('never corrects a known provider, in any letter case or with a root dot', () => {
    for (const provider of suggestedEmailProviderDomains) {
      expect(suggestEmailCorrection(`lorem@${provider}`)).toBeNull();
      expect(suggestEmailCorrection(`lorem@${provider.toUpperCase()}`)).toBeNull();
      expect(suggestEmailCorrection(`lorem@${provider}.`)).toBeNull();
    }
  });

  test('leaves real look-alike and regional mail domains alone', () => {
    for (const domain of ['mail.com', 'email.com', 'ymail.com', 'q.com', 'yahoo.ca', 'outlook.cl', 'live.cn', 'protonmail.ch', 'sina.cn']) {
      expect(suggestEmailCorrection(`lorem@${domain}`)).toBeNull();
    }
  });

  test('allows only one edit for short providers and for a top-level-domain-only change', () => {
    // Two edits from both qq.com and me.com.
    expect(suggestEmailCorrection('lorem@hp.com')).toBeNull();
    expect(suggestEmailCorrection('lorem@mac.com')).toBeNull();
    // Still typing toward gmail.com: two edits away within the top-level domain.
    expect(suggestEmailCorrection('lorem@gmail.c')).toBeNull();
    expect(suggestEmailCorrection('lorem@gmail.')).toBeNull();
  });

  test('suggests nothing when two providers are equally close', () => {
    // One edit from both 126.com and 163.com.
    expect(suggestEmailCorrection('lorem@136.com')).toBeNull();
    expect(suggestEmailCorrection('lorem@hoxmail.com')).toBeNull();
  });

  test('keeps the local part exactly as typed and ignores domain letter case', () => {
    expect(suggestEmailCorrection('Lorem.Ipsum+Dolor@GMIAL.COM')).toBe('Lorem.Ipsum+Dolor@gmail.com');
    expect(suggestEmailCorrection('  Lorem@Hotmial.Com  ')).toBe('Lorem@hotmail.com');
    expect(suggestEmailCorrection('Lorem@Gmail.Com')).toBeNull();
  });

  test('suggests nothing for input that is not one local@domain pair', () => {
    for (const value of [
      '',
      '   ',
      'gmial.com',
      '@gmial.com',
      'lorem@',
      'lorem@.',
      'lorem@ipsum@gmial.com',
      'lorem@@gmial.com',
      'lorem ipsum@gmial.com',
      'lorem@gmial .com',
      `${'l'.repeat(250)}@gmial.com`
    ]) {
      expect(suggestEmailCorrection(value)).toBeNull();
    }
  });

  test('handles internationalized addresses without corrupting them', () => {
    // Unrelated IDN domains, in Unicode or punycode, are left alone.
    expect(suggestEmailCorrection('lorem@bücher.de')).toBeNull();
    expect(suggestEmailCorrection('lorem@xn--bcher-kva.de')).toBeNull();
    expect(suggestEmailCorrection('lorem@例え.jp')).toBeNull();
    // A look-alike character is one edit, and only the ASCII provider domain is substituted.
    expect(suggestEmailCorrection('lorem@gmaïl.com')).toBe('lorem@gmail.com');
    expect(suggestEmailCorrection('lörem.\u{1F600}@gmial.com')).toBe('lörem.\u{1F600}@gmail.com');
    // Composed and decomposed spellings compare the same (NFC).
    expect(suggestEmailCorrection('lorem@qq.cám')).toBe('lorem@qq.com');
    expect(suggestEmailCorrection('lorem@qq.cám')).toBe('lorem@qq.com');
    // An astral character counts once, so this stays a one-edit top-level-domain typo.
    expect(suggestEmailCorrection('lorem@gmail.c\u{1F600}m')).toBe('lorem@gmail.com');
  });
});
