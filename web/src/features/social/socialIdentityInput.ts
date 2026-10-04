/** Browser pattern for a handle: 3–24 ASCII letters, digits or underscores beginning with a letter (any case). */
export const socialHandlePattern = '[a-zA-Z][a-zA-Z0-9_]{2,23}';

/**
 * Mirrors the backend nickname rule so the form refuses what the server would: the trimmed, NFC-normalized
 * nickname has 1–50 Unicode characters (code points, not UTF-16 units, so 50 emoji fit) and no control or
 * invisible formatting character such as the joiner inside some combined emoji. Returns the message key to show.
 */
export const aliasProblem = (value: string): 'social.alias_length' | 'social.alias_characters' | null => {
  const alias = value.trim().normalize('NFC');
  const length = [...alias].length;
  if (length < 1 || length > 50) return 'social.alias_length';
  return /[\p{Cc}\p{Cf}]/u.test(alias) ? 'social.alias_characters' : null;
};
