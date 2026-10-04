/**
 * Closed-beta name policy for public social identity. Handles and nicknames
 * appear on friend lists, invitations, shares and room cards, so a new one must
 * not pass for Finitude itself, its staff or a system account. This is a
 * safeguard against obvious impersonation, not moderation: it screens only new
 * choices and never rewrites a stored profile.
 */

/** Product and company names are reserved anywhere inside a handle or nickname word. */
const BRAND_TERMS = ['finitude', 'archtree', 'kashewt'] as const;
/** Staff roles are reserved as a whole handle, an underscore-separated handle part, or a whole nickname word. */
const STAFF_TERMS = ['admin', 'administrator', 'sysadmin', 'superuser', 'moderator', 'mod', 'staff', 'official',
    'support', 'helpdesk', 'security', 'system'] as const;
/** System and mailbox names are reserved only as a complete handle, so a nickname such as "Help" stays usable. */
const SYSTEM_HANDLES = ['root', 'help', 'null', 'undefined', 'nil', 'none', 'unknown', 'anonymous', 'api', 'www',
    'mail', 'email', 'noreply', 'postmaster', 'hostmaster', 'webmaster', 'abuse', 'privacy', 'legal'] as const;
/** Chinese has no spaces between words, so these staff terms match anywhere in a nickname. */
const CJK_STAFF_TERMS = ['管理员', '管理員', '官方', '客服', '版主', '工作人员', '工作人員'] as const;

/** Digits commonly typed in place of letters; "1" is handled separately because it can read as "i" or "l". */
const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = { 0: 'o', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };
/**
 * Cyrillic and Greek letters that render like Latin ones, in both cases, mapped
 * position by position. A small list covers the usual impersonation spellings
 * without pulling in a full confusables table.
 */
const HOMOGLYPHS_FROM = [...'АВЕКМНОРСТХУІЈЅаеорсухіјѕԁһӏΑΒΕΖΗΙΚΜΝΟΡΤΥΧαοιρνυκε'];
const HOMOGLYPHS_TO = [...'ABEKMHOPCTXYIJSaeopcyxijsdhlABEZHIKMNOPTYXaoipvuke'];
// A misaligned edit would silently map letters to the wrong targets, so fail at load instead.
if (HOMOGLYPHS_FROM.length !== HOMOGLYPHS_TO.length) throw new Error('The social homoglyph table is misaligned.');
const HOMOGLYPHS: ReadonlyMap<string, string> = new Map(HOMOGLYPHS_FROM.map((from, index) => [from, HOMOGLYPHS_TO[index]]));

/**
 * Folds look-alike spellings of one lower-case token. Handles are shown in lower
 * case, where "i" and "l" look different, so only "1" is read both ways. Nicknames
 * keep their capitals, where "I" and "l" look the same, so they merge both letters.
 */
const readings = (token: string, mergeIL: boolean): string[] => {
    const folded = token.replace(/rn/g, 'm').replace(/vv/g, 'w')
        .replace(/[034578]/g, digit => DIGIT_LOOKALIKES[digit]);
    return mergeIL ? [folded.replace(/[1l]/g, 'i')] : [folded.replace(/1/g, 'i'), folded.replace(/1/g, 'l')];
};
/** A trailing number ("admin2024") does not make a reserved name distinct. */
const variants = (token: string, mergeIL: boolean): string[] => [token, token.replace(/\d+$/, '')]
    .filter(Boolean).flatMap(value => readings(value, mergeIL));
/** Reserved terms are folded the same way as input, so both sides compare in one alphabet. */
const foldTerms = (terms: readonly string[], mergeIL: boolean) => new Set(terms.map(term => readings(term, mergeIL)[0]));

const HANDLE_TERMS = foldTerms([...BRAND_TERMS, ...STAFF_TERMS, ...SYSTEM_HANDLES], false);
const HANDLE_STAFF = foldTerms(STAFF_TERMS, false);
const HANDLE_BRANDS = [...foldTerms(BRAND_TERMS, false)];
const ALIAS_STAFF = foldTerms(STAFF_TERMS, true);
const ALIAS_BRANDS = [...foldTerms(BRAND_TERMS, true)];

/**
 * Whether a normalized handle is reserved. Underscores are ignored for the whole
 * handle ("no_reply", "a_d_m_i_n") and also separate parts, so "support_team"
 * cannot claim a staff role.
 */
export const isReservedSocialHandle = (handle: string): boolean => {
    const lower = handle.toLowerCase();
    if (variants(lower.replace(/_/g, ''), false)
        .some(value => HANDLE_TERMS.has(value) || HANDLE_BRANDS.some(brand => value.includes(brand)))) return true;
    return lower.split('_').some(part => variants(part, false).some(value => HANDLE_STAFF.has(value)));
};

const splitWords = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Whether a nickname claims to be Finitude or its staff. Unicode compatibility
 * forms, accents and common Cyrillic/Greek look-alikes are folded first. Words
 * split on non-alphanumeric characters and camel case ("SupportBot"), and a run
 * of single letters ("A D M I N") is also read as one word.
 */
export const isReservedSocialAlias = (alias: string): boolean => {
    const compatible = alias.normalize('NFKC');
    if (CJK_STAFF_TERMS.some(term => compatible.includes(term))) return true;
    const latin = [...compatible.normalize('NFD').replace(/\p{M}/gu, '')].map(char => HOMOGLYPHS.get(char) ?? char).join('');
    const words = splitWords(latin);
    // Camel-case parts are added rather than substituted: "ADMlN" must still be read as one word.
    const candidates = [...words, ...splitWords(latin.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2'))];
    let run: string[] = [];
    // The empty sentinel flushes a run that ends the nickname.
    for (const word of [...words, '']) {
        if ([...word].length === 1) { run.push(word); continue; }
        if (run.length > 1) candidates.push(run.join(''));
        run = [];
    }
    return candidates.some(word => variants(word, true)
        .some(value => ALIAS_STAFF.has(value) || ALIAS_BRANDS.some(brand => value.includes(brand))));
};
