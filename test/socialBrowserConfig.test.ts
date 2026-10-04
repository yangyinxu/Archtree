import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { socialBrowserSuites } from '../web/playwright.social.config';

const socialSpecDirectory = new URL('../web/e2e-social/', import.meta.url);

/** Reads top-level social test titles; every social spec declares its tests with `test('...')`. */
const socialTests = () => readdirSync(socialSpecDirectory).filter(file => file.endsWith('.spec.ts')).flatMap(file => {
  const spec = file.replace(/\.spec\.ts$/, '');
  const source = readFileSync(new URL(file, socialSpecDirectory), 'utf8');
  return [...source.matchAll(/^test\('([^']+)'/gm)].map(match => ({ spec, title: match[1] }));
});

test('social hardware-audio projects remain restricted to explicitly enabled Linux CI', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const ci of [undefined, '', 'false', '0', 'true', '1']) {
      const suites = socialBrowserSuites(platform, ci);
      const hardwareAudio = suites.filter(suite => suite.browser !== 'chromium');
      assert.equal(hardwareAudio.length > 0, platform === 'linux' && (ci === 'true' || ci === '1'));
      assert.equal(suites.filter(suite => suite.browser === 'chromium').length, 13);
    }
  }
});

test('cross-browser social gates isolate only compressed audio and room controller recovery scenarios', () => {
  const suites = socialBrowserSuites('linux', 'true');
  assert.equal(new Set(suites.map(suite => suite.port)).size, suites.length);
  assert.equal(new Set(suites.map(suite => `${suite.browser}-${suite.name}`)).size, suites.length);
  for (const browser of ['firefox', 'webkit']) {
    assert.deepEqual(suites.filter(suite => suite.browser === browser).map(suite => suite.name).sort(), ['audio-formats', 'rooms-recovery']);
  }
  // Room scenarios cannot share another process's database, S3 or rate window, nor the soak fixture's 4187/4188.
  assert.deepEqual(suites.filter(suite => (suite.spec ?? suite.name) === 'rooms').map(suite => suite.port), [4175, 4189, 4185, 4186]);
  assert.equal(suites.some(suite => [4187, 4188].includes(suite.port)), false);
  // Test-runner fetch calls to a fixture (Node's WHATWG fetch) refuse the Fetch standard's blocked ports.
  const fetchBlocked = [1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];
  assert.equal(suites.some(suite => fetchBlocked.includes(suite.port)), false);
});

test('every social test owns exactly one Chromium fixture process and its rate windows', () => {
  const chromium = socialBrowserSuites('darwin', undefined);
  const tests = socialTests();
  assert.ok(tests.filter(value => value.spec === 'rooms').length >= 2);
  const selects = (suite: (typeof chromium)[number], value: (typeof tests)[number]) =>
    (suite.spec ?? suite.name) === value.spec && (suite.grep?.test(value.title) ?? true);
  for (const value of tests) {
    assert.equal(chromium.filter(suite => selects(suite, value)).length, 1, `${value.spec}: ${value.title}`);
  }
  for (const suite of chromium) {
    assert.equal(tests.filter(value => selects(suite, value)).length, 1, `chromium-${suite.name}`);
  }
  // Each cross-browser project likewise serves one test from its own process.
  for (const suite of socialBrowserSuites('linux', 'true').filter(value => value.browser !== 'chromium')) {
    assert.equal(tests.filter(value => selects(suite, value)).length, 1, `${suite.browser}-${suite.name}`);
  }
});
