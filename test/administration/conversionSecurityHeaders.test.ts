import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContentSecurityPolicy, isConversionWorkerAsset } from '../../src/middleware/securityHeadersMiddleware';

test('WebAssembly compilation is confined to the exact generated conversion Worker response', () => {
  for (const path of ['/finitude/admin/conversions', '/finitude/assets/c-ABC.js', '/assets/conversionWorker-ABC.js', '/finitude/assets/conversionWorker-ABC.js/other']) {
    assert.equal(isConversionWorkerAsset({ path, method: 'GET' }), false);
  }
  assert.equal(isConversionWorkerAsset({ path: '/finitude/assets/conversionWorker-ABC_123.js', method: 'GET' }), true);
  assert.equal(isConversionWorkerAsset({ path: '/finitude/assets/conversionWorker-ABC.js', method: 'POST' }), false);
  const document = buildContentSecurityPolicy();
  assert.doesNotMatch(document, /wasm-unsafe-eval|unsafe-eval|unsafe-inline/);
  assert.match(document, /media-src 'self' blob:/);
  const worker = buildContentSecurityPolicy(false, true);
  assert.match(worker, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(worker, /(?:^|\s)'unsafe-eval'/);
  assert.match(worker, /connect-src 'self'/);
});
