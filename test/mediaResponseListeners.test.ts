import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express from 'express';
import { ServerLifecycle } from '../src/services/serverLifecycleService';
import { createRequestDiagnostics } from '../src/middleware/requestDiagnosticsMiddleware';
import { createMediaAdmissionController } from '../src/middleware/mediaDeliveryMiddleware';
import { asyncHandler } from '../src/middleware/requestProtectionMiddleware';
import { createMediaAbortContext, pipeMediaStream } from '../src/services/mediaDeliveryService';

test('media responses stay within the default listener budget with application middleware', async () => {
  const app = express();
  const lifecycle = new ServerLifecycle();
  const diagnostics = createRequestDiagnostics();
  app.use(diagnostics.observe, lifecycle.admit);
  let peakCloseListeners = 0;
  app.get('/stream', createMediaAdmissionController().middleware('playback'), asyncHandler(async (req, res) => {
    const context = createMediaAbortContext(req, res);
    const pending = pipeMediaStream(req, res, Readable.from(['media']), context);
    peakCloseListeners = Math.max(peakCloseListeners, res.listenerCount('close'));
    await pending;
  }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stream`;
    for (let i = 0; i < 3; i += 1) assert.equal(await (await fetch(url)).text(), 'media');
    assert.ok(peakCloseListeners <= 10, `Observed ${peakCloseListeners} close listeners`);
    assert.equal(diagnostics.snapshot().byArea.other.active, 0);
  } finally {
    await lifecycle.stop(server, async () => undefined, 100, 100);
  }
});
