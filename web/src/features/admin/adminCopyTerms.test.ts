import enBundle from '../../../../localization/generated/bundles/en-US.json';
import zhBundle from '../../../../localization/generated/bundles/zh-Hans.json';

/**
 * The plain wording of metadata lookup and Album completion copy in both generated bundles: no API names, no "here" for the
 * files, one Chinese term for a row of the expected tracklist without audio, and the import summary's conflict answers worded like
 * the review's.
 */
const en = enBundle.messages as Record<string, string>, zh = zhBundle.messages as Record<string, string>;
const prefixes = ['admin.lookup.', 'admin.catalog_review.', 'admin.summary.', 'admin.catalog.album_expected', 'admin.append_rows.'];
const keys = Object.keys(en).filter(key => prefixes.some(prefix => key.startsWith(prefix)));

test('the lookup and completion copy uses plain words: no API names, no "here" for the files and one term for rows without audio', () => {
  expect(keys).toEqual(expect.arrayContaining(['admin.lookup.active_itunes', 'admin.catalog_review.expected_rows', 'admin.summary.conflicts', 'admin.catalog.album_expected_no_file', 'admin.append_rows.fills']));
  for (const key of keys) {
    expect(zh[key], key).not.toMatch(/iTunes Search API|授权过期|缺文件|已对应曲目|此处/);
    expect(en[key], key).not.toMatch(/Search API| here, |\bthe review\b|Tracks paired|missing-file/);
  }
  expect(zh['admin.catalog.album_expected_no_file']).toBe('没有音频');
});

test('the import summary\'s conflict answers and partial-comparison copy read like the review\'s', () => {
  for (const messages of [en, zh]) {
    expect(messages['admin.summary.yours']).toBe(messages['admin.catalog_review.current_value']);
    expect(messages['admin.summary.keep_mine']).toBe(messages['admin.catalog_review.keep_current']);
    expect(messages['admin.summary.kept_mine']).toBe(messages['admin.catalog_review.kept_current']);
    for (const key of ['admin.lookup.single_choice', 'admin.lookup.partial_comparison']) expect(messages[key], key).not.toMatch(/MusicBrainz/);
  }
});
