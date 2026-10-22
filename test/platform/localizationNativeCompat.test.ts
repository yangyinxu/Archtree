import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

/**
 * iOS and Android package an en-US fallback bundle and download the generated ones, refusing a downloaded bundle whose message
 * for a packaged key reads other variable names than the packaged one. So every packaged key must still exist in both generated
 * bundles with the same variable names, read the way the apps read them (keys are never removed or renamed and their variables
 * never change). The sibling repositories are read beside the main checkout (also from a linked worktree), or from
 * FINITUDE_IOS_ROOT and FINITUDE_ANDROID_ROOT; without them this is skipped.
 */
const repoRoot = process.cwd();
const generated = Object.fromEntries(['en-US', 'zh-Hans'].map(locale => [locale,
  (JSON.parse(readFileSync(path.join(repoRoot, 'localization', 'generated', 'bundles', `${locale}.json`), 'utf8')) as { messages: Record<string, string> }).messages]));

/** The main checkout's directory, which a linked worktree shares its Git directory with; this checkout when Git cannot say. */
const mainCheckout = () => {
  try {
    return path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim());
  } catch {
    return repoRoot;
  }
};
/** A sibling repository named by its variable, else beside the main checkout when present there, else beside this checkout. */
const sibling = (variable: string | undefined, name: string) => {
  if (variable) return variable;
  const shared = path.resolve(mainCheckout(), '..', name);
  return existsSync(shared) ? shared : path.resolve(repoRoot, '..', name);
};
const packaged = [
  ['iOS', path.join(sibling(process.env.FINITUDE_IOS_ROOT, 'Finitude_iOS'), 'Finitude_iOS', 'Localization', 'en-US.json')],
  ['Android', path.join(sibling(process.env.FINITUDE_ANDROID_ROOT, 'Finitude_Android'), 'app', 'src', 'main', 'assets', 'localization', 'en-US.json')]
] as const;

/**
 * The sorted variable names the native clients read from a message: `LocalizationContract.variablePattern` on iOS and
 * `variablePattern` in the Android localization repository, both `\{([A-Za-z][A-Za-z0-9]*)(?:\s*,|\})`. Unlike an ICU parse, this
 * also reads a plural or select branch whose body is one bare word as a variable.
 */
const variableNames = (message: string) => [...new Set([...message.matchAll(/\{([A-Za-z][A-Za-z0-9]*)(?:\s*,|\})/g)].map(match => match[1]))].sort();

/** The sorted variable names an ICU parse reads; formatter types are not compared, as a locale may pluralize where another does not. */
const icuVariableNames = (message: string) => {
  const names = new Set<string>();
  const visit = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if (element.type === TYPE.literal || element.type === TYPE.pound) continue;
      if (element.type === TYPE.tag) { visit(element.children); continue; }
      names.add(element.value);
      if (element.type === TYPE.select || element.type === TYPE.plural) for (const option of Object.values(element.options)) visit(option.value);
    }
  };
  visit(parse(message));
  return [...names].sort();
};

test('variable names are read the way the native clients read them, which an ICU parse alone would miss', () => {
  assert.deepEqual(variableNames('Plain text'), []);
  assert.deepEqual(variableNames('{count, plural, one {# {name}} other {# {name} and {rest}}}'), ['count', 'name', 'rest']);
  assert.deepEqual(variableNames('{width}'), variableNames('{width, plural, one {#} other {#}}'));
  // A branch whose body is one bare word reads as a variable to the apps, so such a message would be refused.
  assert.notDeepEqual(variableNames('{count, plural, one {track} other {tracks}}'), variableNames('{count} tracks'));
  assert.deepEqual(icuVariableNames('{count, plural, one {track} other {tracks}}'), icuVariableNames('{count} tracks'));
  assert.deepEqual(icuVariableNames('{kind, select, album {<b>{title}</b>} other {{date, date} at {time, time} for {total, number}}}'), ['date', 'kind', 'time', 'title', 'total']);
});

for (const [platform, file] of packaged) {
  test(`every key the ${platform} app packages exists in both generated bundles with the same variable names`, { skip: !existsSync(file) && 'the sibling Finitude repositories are not present' }, () => {
    const bundle = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion: number; messages: Record<string, string> };
    assert.equal(bundle.schemaVersion, 1);
    assert.ok(Object.keys(bundle.messages).length > 0);
    for (const [key, value] of Object.entries(bundle.messages)) {
      for (const [locale, messages] of Object.entries(generated)) {
        assert.ok(Object.hasOwn(messages, key), `${locale} lacks ${key}, which ${platform} packages`);
        assert.deepEqual(variableNames(messages[key]), variableNames(value), `${locale} ${key} variables as the apps read them`);
        assert.deepEqual(icuVariableNames(messages[key]), icuVariableNames(value), `${locale} ${key} variables`);
      }
    }
  });
}
