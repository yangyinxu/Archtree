import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/server';
import { createStartupFailureDiagnostic } from '../src/infrastructure/startupDiagnostics';

test('startup releases database when application creation or port validation fails', async () => {
  for (const failApplication of [false, true]) {
    let closed = 0;
    await assert.rejects(startServer({
      connectDatabase: async () => undefined,
      closeDatabase: async () => { closed++; },
      createApplication: () => {
        if (failApplication) throw new Error('invalid app configuration');
        return express();
      },
      port: -1
    }), error => {
      const diagnostic = createStartupFailureDiagnostic(error);
      assert.equal(diagnostic.stage, failApplication ? 'application' : 'listener_configuration');
      assert.equal(diagnostic.reason, failApplication ? 'application_initialization_failed' : 'listener_configuration_invalid');
      return true;
    });
    assert.equal(closed, 1);
  }
});

test('occupied port rejects startup rather than reporting a running server', async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, resolve));
  let closed = false;
  try {
    await assert.rejects(startServer({
      connectDatabase: async () => undefined,
      closeDatabase: async () => { closed = true; },
      createApplication: () => express(),
      port: (occupied.address() as AddressInfo).port
    }), error => {
      assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE');
      const diagnostic = createStartupFailureDiagnostic(error);
      assert.equal(diagnostic.reason, 'listener_address_in_use');
      assert.equal(diagnostic.stage, 'listener');
      return true;
    });
    assert.equal(closed, true);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});

test('successful startup resolves only after the server is listening', async () => {
  const before = process.listenerCount('SIGTERM');
  const server = await startServer({
    connectDatabase: async () => undefined,
    closeDatabase: async () => undefined,
    createApplication: () => express(),
    port: 0
  });
  assert.equal(server.listening, true);
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.equal(process.listenerCount('SIGTERM'), before);
});
