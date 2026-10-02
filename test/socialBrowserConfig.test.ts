import assert from 'node:assert/strict';
import test from 'node:test';
import { socialBrowserSuites } from '../web/playwright.social.config';

test('social hardware-audio projects remain restricted to explicitly enabled Linux CI', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const ci of [undefined, '', 'false', '0', 'true', '1']) {
      const suites = socialBrowserSuites(platform, ci);
      const hardwareAudio = suites.filter(suite => suite.browser !== 'chromium');
      assert.equal(hardwareAudio.length > 0, platform === 'linux' && (ci === 'true' || ci === '1'));
      assert.equal(suites.filter(suite => suite.browser === 'chromium').length, 8);
    }
  }
});

test('cross-browser social gates isolate only compressed audio and room controller recovery scenarios', () => {
  const suites = socialBrowserSuites('linux', 'true');
  assert.equal(new Set(suites.map(suite => suite.port)).size, suites.length);
  assert.equal(new Set(suites.map(suite => `${suite.browser}-${suite.name}`)).size, suites.length);
  for (const browser of ['firefox', 'webkit']) {
    assert.deepEqual(suites.filter(suite => suite.browser === browser).map(suite => suite.name).sort(), ['audio-formats', 'rooms']);
  }
  // New recovery scenarios cannot share the compressed-format process's database, S3 or rate window.
  assert.deepEqual(suites.filter(suite => suite.name === 'rooms').map(suite => suite.port), [4175, 4185, 4186]);
});
