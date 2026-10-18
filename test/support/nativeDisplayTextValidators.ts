/**
 * Ports of the display-text checks the native Finitude clients apply to decoded Listener text.
 * iOS applies `validatedDisplayText` while decoding Listener collection pages (Page.swift);
 * Android applies `requireDisplayText` to Listener collection pages and Listener Album details
 * (CatalogRepository.kt:495-640). One failing value rejects the whole page or details response,
 * so server tests use these ports to prove that server-built text stays decodable on both
 * platforms.
 *
 * Sources in the sibling repositories:
 * - iOS `validatedDisplayText`: Finitude_iOS/Finitude_iOS/Networking/Data/Page.swift:530-548
 *   (Finitude_iOS 91589f0). Bylines use maximumCount 500 (:319-321 Album, :412-414 MediaTrack);
 *   Credit names use 200 (:457-461).
 * - Android `requireDisplayText`: Finitude_Android/app/src/main/java/com/yxu/finitude/data/
 *   CatalogRepository.kt:694-698 (Finitude_Android 433ee43). `requireAttribution` (:646-662)
 *   applies it with 500 to the byline (:651) and with 200 to each Credit name (:658).
 *
 * The character classes come from this runtime's Unicode data, which can differ from a device's
 * for newly assigned characters; tests should use long-assigned characters.
 */

/** Byline limit both clients enforce (Page.swift:320 and :413, CatalogRepository.kt:651). */
export const nativeBylineLimit = 500;

/** Credit-name limit both clients enforce (Page.swift:459, CatalogRepository.kt:658). */
export const nativeCreditNameLimit = 200;

// CharacterSet.whitespacesAndNewlines: General Category Z*, U+0009 (from .whitespaces),
// U+000A-U+000D and U+0085.
const iosWhitespace = /^[\p{Z}\u0009-\u000D\u0085]$/u;
// CharacterSet.controlCharacters: General Categories Cc and Cf.
const iosControl = /^[\p{Cc}\p{Cf}]$/u;
// Kotlin/JVM Char.isWhitespace is Character.isWhitespace || Character.isSpaceChar:
// General Category Z*, U+0009-U+000D and U+001C-U+001F.
const androidWhitespace = /^[\p{Z}\u0009-\u000D\u001C-\u001F]$/u;
// Char.isISOControl: U+0000-U+001F and U+007F-U+009F.
const androidIsoControl = /^[\u0000-\u001F\u007F-\u009F]$/;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Matches `value == value.trimmingCharacters(in:)` (iOS) and `value == value.trim()` (Android):
 * the first and last code points must not be characters that trim removes.
 */
const isTrimmed = (codePoints: readonly string[], trimmed: RegExp) => codePoints.length === 0
    || (!trimmed.test(codePoints[0]) && !trimmed.test(codePoints[codePoints.length - 1]));

const isUnpairedSurrogate = (codePoint: string) => /^[\uD800-\uDFFF]$/.test(codePoint);

/**
 * iOS: the value must already be trimmed, count 1...maximumCount Swift Characters (extended
 * grapheme clusters), and contain no Cc or Cf scalar. Swift Strings cannot hold unpaired
 * surrogates, so the JSON decoder rejects them before this check could run.
 */
export const isValidIosDisplayText = (value: string, maximumCount: number, allowEmpty = false) => {
    const scalars = Array.from(value);
    if (scalars.some(isUnpairedSurrogate)) return false;
    const count = Array.from(graphemes.segment(value)).length;
    const isAllowedCount = allowEmpty ? count <= maximumCount : count >= 1 && count <= maximumCount;
    return isTrimmed(scalars, iosWhitespace) && isAllowedCount
        && !scalars.some((scalar) => iosControl.test(scalar));
};

/**
 * Android: the value must already be trimmed, contain no ISO control character, and count
 * 1..maximumLength code points; an unpaired surrogate counts as one code point, as in
 * `String.codePointCount`. Other format characters (Cf) are accepted.
 */
export const isValidAndroidDisplayText = (value: string, maximumLength: number, allowEmpty = false) => {
    const codePoints = Array.from(value);
    const length = codePoints.length;
    return isTrimmed(codePoints, androidWhitespace)
        && !codePoints.some((codePoint) => androidIsoControl.test(codePoint))
        && (allowEmpty ? length <= maximumLength : length >= 1 && length <= maximumLength);
};

/** Both clients' verdicts for one value, so a test can assert agreement or a known divergence. */
export const nativeDisplayTextVerdict = (value: string, maximum: number, allowEmpty = false) => ({
    ios: isValidIosDisplayText(value, maximum, allowEmpty),
    android: isValidAndroidDisplayText(value, maximum, allowEmpty)
});
