// Suggests a correction when a typed email domain looks like a misspelling of
// a popular provider (`name@gmial.com` → `name@gmail.com`) on the
// server-rendered Kashewt account pages; test/account/accountPages.test.ts covers its
// answers. It never blocks a request and changes the address only when the
// person selects the suggestion.
(() => {
  const providers = Object.freeze([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
    'me.com', 'proton.me', 'protonmail.com', 'qq.com', '163.com', '126.com', 'foxmail.com', 'sina.com'
  ]);
  // Real mail domains within typo distance of a provider; never "corrected".
  const knownDomains = new Set([...providers, 'email.com', 'mail.com', 'q.com', 'ymail.com']);
  const maximumAddressLength = 254;

  const codePoints = (value) => Array.from(value);
  const domainName = (domain) => domain.slice(0, Math.max(0, domain.lastIndexOf('.')));
  const maximumDistanceFor = (domain, provider) => (
    codePoints(provider).length <= 7 || domainName(domain) === domainName(provider) ? 1 : 2
  );

  /** Unrestricted Damerau-Levenshtein distance over Unicode code points. */
  const distanceBetween = (left, right) => {
    const a = codePoints(left);
    const b = codePoints(right);
    const unreachable = a.length + b.length;
    const distance = Array.from({ length: a.length + 2 }, () => new Array(b.length + 2).fill(0));
    distance[0][0] = unreachable;
    for (let i = 0; i <= a.length; i += 1) {
      distance[i + 1][0] = unreachable;
      distance[i + 1][1] = i;
    }
    for (let j = 0; j <= b.length; j += 1) {
      distance[0][j + 1] = unreachable;
      distance[1][j + 1] = j;
    }
    const lastRow = new Map();
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
          distance[transposedRow][transposedColumn] + (i - transposedRow - 1) + 1 + (j - transposedColumn - 1)
        );
      }
      lastRow.set(a[i - 1], i);
    }
    return distance[a.length + 1][b.length + 1];
  };

  /** Returns the corrected address, or null when there is nothing to suggest. */
  const suggestEmailCorrection = (address) => {
    const value = String(address).trim();
    if (!value || value.length > maximumAddressLength || /\s/u.test(value)) return null;
    const at = value.indexOf('@');
    if (at <= 0 || at !== value.lastIndexOf('@')) return null;
    const localPart = value.slice(0, at);
    let domain = value.slice(at + 1).normalize('NFC').toLowerCase();
    if (domain.endsWith('.')) domain = domain.slice(0, -1);
    if (!domain || knownDomains.has(domain)) return null;
    const domainLength = codePoints(domain).length;
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let ambiguous = false;
    for (const provider of providers) {
      const maximumDistance = maximumDistanceFor(domain, provider);
      if (Math.abs(domainLength - provider.length) > maximumDistance) continue;
      const distance = distanceBetween(domain, provider);
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

  globalThis.kashewtSuggestEmailCorrection = suggestEmailCorrection;
})();
