/**
 * Suggests a correction when the domain of a typed email address looks like a
 * misspelling of a popular email provider, for example `name@gmial.com` to
 * `name@gmail.com`. It runs only in the browser and never blocks a request:
 * the server's deliverability check stays authoritative, and a suggestion
 * changes the address only when the listener selects it.
 */

/** Providers a mistyped domain may be corrected to, most widely used first. */
export const suggestedEmailProviderDomains: readonly string[] = Object.freeze([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'qq.com',
  '163.com',
  '126.com',
  'foxmail.com',
  'sina.com'
]);

/**
 * Real mail domains within the typo distance of a provider above. They count
 * as known, so their owners are never told to "fix" a correct address.
 */
const recognizedLookalikeDomains = ['email.com', 'mail.com', 'q.com', 'ymail.com'];

const knownDomains = new Set([...suggestedEmailProviderDomains, ...recognizedLookalikeDomains]);

/** The longest address the account forms accept. */
const maximumAddressLength = 254;

const codePoints = (value: string) => Array.from(value);

/** The domain without its last label, for example `yahoo` for `yahoo.ca`. */
const domainName = (domain: string) => domain.slice(0, Math.max(0, domain.lastIndexOf('.')));

/**
 * Short provider domains allow one edit and longer ones two, so a two-letter
 * domain such as `hp.com` is not mistaken for `qq.com` or `me.com`. A change
 * confined to the top-level domain also allows only one edit: `gmail.co` and
 * `gmail.con` are typos, while `yahoo.ca` or `outlook.cl` usually is the same
 * provider's real regional domain.
 */
const maximumDistanceFor = (domain: string, provider: string) => (
  codePoints(provider).length <= 7 || domainName(domain) === domainName(provider) ? 1 : 2
);

/**
 * Counts the insertions, deletions, substitutions and transpositions of
 * adjacent characters needed to turn one string into the other (the
 * unrestricted Damerau-Levenshtein distance). It compares Unicode code points,
 * so a character outside the Basic Multilingual Plane counts as one.
 */
export const damerauLevenshteinDistance = (left: string, right: string): number => {
  const a = codePoints(left);
  const b = codePoints(right);
  const unreachable = a.length + b.length;
  // Row and column 0 hold the sentinel; cell [i + 1][j + 1] is the distance
  // between the first i characters of `a` and the first j characters of `b`.
  const distance = Array.from({ length: a.length + 2 }, () => new Array<number>(b.length + 2).fill(0));
  distance[0][0] = unreachable;
  for (let i = 0; i <= a.length; i += 1) {
    distance[i + 1][0] = unreachable;
    distance[i + 1][1] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    distance[0][j + 1] = unreachable;
    distance[1][j + 1] = j;
  }
  // The last row of `a` in which each character appeared.
  const lastRow = new Map<string, number>();
  for (let i = 1; i <= a.length; i += 1) {
    let lastMatchingColumn = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const transposedRow = lastRow.get(b[j - 1]) ?? 0;
      const transposedColumn = lastMatchingColumn;
      let substitutionCost = 1;
      if (a[i - 1] === b[j - 1]) {
        substitutionCost = 0;
        lastMatchingColumn = j;
      }
      distance[i + 1][j + 1] = Math.min(
        distance[i][j] + substitutionCost,
        distance[i + 1][j] + 1,
        distance[i][j + 1] + 1,
        distance[transposedRow][transposedColumn]
          + (i - transposedRow - 1) + 1 + (j - transposedColumn - 1)
      );
    }
    lastRow.set(a[i - 1], i);
  }
  return distance[a.length + 1][b.length + 1];
};

/**
 * Returns the address with its domain replaced by the one popular provider it
 * most likely misspells, or null when there is nothing to suggest.
 *
 * - The local part is kept exactly as typed; only the domain is compared, in
 *   lowercase NFC form and without one trailing root dot.
 * - A domain that already is a known provider (in any letter case), or a
 *   recognized real look-alike, is never corrected.
 * - Input that is not a single `local@domain` pair (no `@`, several `@`,
 *   whitespace inside, or longer than an address can be) gets no suggestion.
 * - Internationalized domains are compared by code point, in whichever form
 *   the browser supplies (Unicode or punycode); a suggestion only ever
 *   substitutes an ASCII provider domain.
 * - When two providers are equally close, the guess is ambiguous and nothing
 *   is suggested.
 */
export const suggestEmailCorrection = (address: string): string | null => {
  const value = address.trim();
  if (!value || value.length > maximumAddressLength || /\s/u.test(value)) return null;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return null;
  const localPart = value.slice(0, at);
  let domain = value.slice(at + 1).normalize('NFC').toLowerCase();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!domain || knownDomains.has(domain)) return null;

  const domainLength = codePoints(domain).length;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let ambiguous = false;
  for (const provider of suggestedEmailProviderDomains) {
    const maximumDistance = maximumDistanceFor(domain, provider);
    // The length difference is a lower bound, so most comparisons end here.
    if (Math.abs(domainLength - provider.length) > maximumDistance) continue;
    const distance = damerauLevenshteinDistance(domain, provider);
    if (distance > maximumDistance) continue;
    if (distance < bestDistance) {
      best = provider;
      bestDistance = distance;
      ambiguous = false;
    } else if (distance === bestDistance) {
      ambiguous = true;
    }
  }
  return best && !ambiguous ? `${localPart}@${best}` : null;
};
