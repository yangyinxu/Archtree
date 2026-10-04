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

test('startup starts the operations summary after listening, stops it first and logs the effective room capacity', async t => {
  const keys = ['FINITUDE_SOCIAL_ENABLED', 'FINITUDE_ROOMS_ENABLED', 'FINITUDE_ROOM_MAX_MEMBERS', 'FINITUDE_REALTIME_MAX_SOCKETS'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  Object.assign(process.env, { FINITUDE_SOCIAL_ENABLED: 'true', FINITUDE_ROOMS_ENABLED: 'true',
    FINITUDE_ROOM_MAX_MEMBERS: '3', FINITUDE_REALTIME_MAX_SOCKETS: 'many' });
  const lines: string[] = [];
  t.mock.method(console, 'log', (value: unknown) => { lines.push(String(value)); });
  const events: string[] = [];
  let closed = false;
  const server = await startServer({
    connectDatabase: async () => undefined,
    closeDatabase: async () => { events.push('database:close'); closed = true; },
    createApplication: () => express(), port: 0, stopped: () => undefined,
    installRoomGateway: (() => ({ stop: () => { events.push('rooms:stop'); }, release: async () => undefined })) as never,
    startOperationalSummary: () => {
      events.push(`summary:start:${lines.some(line => line.includes('"server_listening"')) ? 'listening' : 'early'}`);
      return () => { events.push('summary:stop'); };
    }
  });
  assert.equal(server.listening, true);
  assert.deepEqual(events, ['summary:start:listening']);
  const capacity = lines.map(line => JSON.parse(line)).find(entry => entry.category === 'social_capacity_config');
  assert.deepEqual(capacity, { category: 'social_capacity_config', maxOpenRooms: 100, maxRoomMembers: 3,
    maxRealtimeSockets: 256, invalidSettings: ['FINITUDE_REALTIME_MAX_SOCKETS'] });
  assert.equal(lines.some(line => line.includes('many')), false, 'A rejected value is never echoed.');
  process.emit('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (!closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events, ['summary:start:listening', 'summary:stop', 'rooms:stop', 'database:close']);
});
