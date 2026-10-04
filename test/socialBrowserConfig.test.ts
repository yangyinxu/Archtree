import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { quarantinedSocialProjects, socialBrowserSuites, socialConfig } from '../web/playwright.social.config';

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
  const suites = [...socialBrowserSuites('linux', 'true'), ...socialBrowserSuites('linux', 'true', 'quarantined')];
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
  // Each cross-browser project, blocking or quarantined, likewise serves one test from its own process.
  for (const suite of [...socialBrowserSuites('linux', 'true'), ...socialBrowserSuites('linux', 'true', 'quarantined')]
    .filter(value => value.browser !== 'chromium')) {
    assert.equal(tests.filter(value => selects(suite, value)).length, 1, `${suite.browser}-${suite.name}`);
  }
});

test('the blocking social gate omits only the quarantined cross-engine audio drift projects', () => {
  const project = (suite: { browser: string; name: string }) => `${suite.browser}-${suite.name}`;
  assert.deepEqual([...quarantinedSocialProjects].sort(), ['firefox-audio-formats', 'webkit-audio-formats']);
  const gate = socialBrowserSuites('linux', 'true').map(project);
  const quarantined = socialBrowserSuites('linux', 'true', 'quarantined').map(project);
  assert.deepEqual(quarantined.sort(), ['firefox-audio-formats', 'webkit-audio-formats']);
  assert.equal(gate.length, 15);
  for (const kept of ['chromium-audio-formats', 'firefox-rooms-recovery', 'webkit-rooms-recovery']) assert.ok(gate.includes(kept), kept);
  assert.equal(gate.some(name => quarantined.includes(name)), false);
  // Off Linux CI the gate is the complete Chromium selection and nothing is quarantined.
  assert.deepEqual(socialBrowserSuites('darwin', undefined).map(project), socialBrowserSuites('darwin', undefined).filter(suite => suite.browser === 'chromium').map(project));
  assert.deepEqual(socialBrowserSuites('darwin', undefined, 'quarantined'), []);
});

test('each social selection starts only its own fixtures, keeps separate evidence and never runs an unisolated default project', () => {
  const gate = socialConfig('gate', 'linux', 'true');
  const quarantined = socialConfig('quarantined', 'linux', 'true');
  assert.equal(gate.outputDir, './test-results/social-real');
  assert.equal(quarantined.outputDir, './test-results/social-quarantined');
  assert.deepEqual(quarantined.projects?.map(value => value.name), ['firefox-audio-formats', 'webkit-audio-formats']);
  const ports = (config: typeof gate) => (Array.isArray(config.webServer) ? config.webServer : []).map(server => server.env?.FINITUDE_SOCIAL_E2E_PORT);
  assert.deepEqual(ports(quarantined), ['4183', '4184']);
  assert.equal(ports(gate).some(port => ['4183', '4184'].includes(port!)), false);
  assert.equal(gate.projects?.length, ports(gate).length);
  // An empty project list would make Playwright run every social spec in one default project.
  assert.throws(() => socialConfig('quarantined', 'darwin', undefined), /only on Linux with CI=1/);
});
