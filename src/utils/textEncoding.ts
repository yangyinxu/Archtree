const japaneseTextPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// Multipart parsers can expose UTF-8 filename bytes as Latin-1 text. Decode
// only when that round-trip produces valid Japanese, so already-correct names
// and ordinary Latin filenames remain unchanged.
export const normalizeUtf8Text = (value: string) => {
    if (!value) return value;

    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    if (decoded === value || decoded.includes('\uFFFD')) {
        return value;
    }

    return japaneseTextPattern.test(decoded) ? decoded : value;
};
