import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import express, { type Request, type Response } from 'express';
import { handleApplicationError } from '../src/app';
import { ROOM_LIMITS, type RoomApi } from '../src/contracts/roomV1';
import type { AuthenticatedRequest } from '../src/middleware/authMiddleware';
import { resetRateLimitWindowsForTests } from '../src/middleware/requestProtectionMiddleware';
import { createRoomRouter } from '../src/routes/roomRoutes';
import { onRequestWorkComplete, ServerLifecycle } from '../src/services/serverLifecycleService';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return { promise, resolve };
};
type Result = { status: number; headers: IncomingHttpHeaders; body: string };
type Options = { method?: string; ip?: string; hold?: boolean; body?: unknown;
    headers?: Record<string, string>; authenticate?: boolean };
type Operation = { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred>;
    closed: ReturnType<typeof deferred>; completed: ReturnType<typeof deferred>;
    observed: boolean; authenticate: boolean };

/** Drives the real router and production lifecycle through sockets, holding only injected service work. */
const listen = async (t: TestContext) => {
    const operations = new Map<string, Operation>();
    const clients: ReturnType<typeof request>[] = [];
    const context = new AsyncLocalStorage<{ operation: Operation; req: Request; res: Response }>();
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let sequence = 0;
    const work = async (kind: 'read' | 'command') => {
        const current = context.getStore();
        assert.ok(current);
        calls.push(kind);
        active++;
        maximumActive = Math.max(maximumActive, active);
        current.operation.entered.resolve();
        try { await current.operation.gate.promise; }
        finally { active--; }
    };
    const api = {
        currentRoom: async () => { await work('read'); return null; },
        mutate: async (_actor, command) => {
            await work('command');
            return { commandId: command.commandId, outcome: 'applied', replayed: false };
        }
    } as Pick<RoomApi, 'currentRoom' | 'mutate'>;
    const app = express();
    // Exactly one synthetic trusted proxy supplies distinct test clients; production trust settings are untouched.
    app.set('trust proxy', 1);
    app.use(new ServerLifecycle().admit);
    app.use((req, res, next) => {
        const operation = operations.get(req.get('X-Test-Operation')!);
        assert.ok(operation);
        operation.observed = true;
        res.once('close', operation.closed.resolve);
        onRequestWorkComplete(req, res, operation.completed.resolve);
        if (operation.authenticate) (req as AuthenticatedRequest).auth = {
            userId: 'synthetic-room-account', sessionId: 'synthetic-room-session',
            email: 'fixture@example.test', role: 'user'
        };
        context.run({ operation, req, res }, next);
    });
    app.use('/api/social/v1', createRoomRouter(api as RoomApi));
    app.use(handleApplicationError);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/social/v1`;
    t.after(async () => {
        for (const operation of operations.values()) operation.gate.resolve();
        for (const client of clients) client.destroy();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await Promise.all([...operations.values()].filter(value => value.observed).map(value => value.completed.promise));
    });
    const send = (path = '/rooms/current', options: Options = {}) => {
        const id = String(++sequence);
        const method = options.method ?? 'GET';
        const operation: Operation = { entered: deferred(), gate: deferred(), closed: deferred(),
            completed: deferred(), observed: false, authenticate: options.authenticate !== false };
        operations.set(id, operation);
        if (!options.hold) operation.gate.resolve();
        const body = options.body ?? (method === 'POST' ? {
            scopeToken: 'synthetic-signed-scope-token', commandId: `synthetic-command-${id.padStart(3, '0')}`,
            action: 'leave', roomId: 'synthetic-room', memberId: 'synthetic-member'
        } : undefined);
        let client!: ReturnType<typeof request>;
        const result = new Promise<Result>(resolve => {
            client = request(`${base}${path}`, { method, headers: {
                Authorization: 'Bearer synthetic', 'X-Finitude-Room-Client': 'synthetic-room-client-001',
                'X-Forwarded-Proto': 'https', 'X-Forwarded-For': options.ip ?? '203.0.113.1',
                'X-Test-Operation': id, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...options.headers
            } }, response => {
                let text = '';
                response.on('data', chunk => { text += String(chunk); });
                response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: text }));
                response.once('aborted', () => resolve({ status: 0, headers: {}, body: '' }));
            });
            // Socket cancellation is a fixed test outcome, never an exception-text diagnostic.
            client.once('error', () => resolve({ status: 0, headers: {}, body: '' }));
            client.end(body === undefined ? undefined : JSON.stringify(body));
        });
        clients.push(client);
        return { result, entered: operation.entered.promise, closed: operation.closed.promise,
            completed: operation.completed.promise, release: operation.gate.resolve, abort: () => client.destroy() };
    };
    return { send, calls, get active() { return active; }, get maximumActive() { return maximumActive; } };
};
type Fixture = Awaited<ReturnType<typeof listen>>;
type Held = ReturnType<Fixture['send']>;
const hold = async (fixture: Fixture, options: Options = {}) => {
    const operation = fixture.send(options.method === 'POST' ? '/room-commands' : '/rooms/current', { ...options, hold: true });
    await operation.entered;
    return operation;
};
const refusal = async (operation: Held, head = false) => {
    const response = await operation.result;
    assert.equal(response.status, 429);
    assert.equal(response.headers['retry-after'], '2');
    assert.equal(response.headers['ratelimit-limit'], '180');
    assert.match(response.headers['cache-control']!, /no-store/);
    assert.equal(response.body, head ? '' : JSON.stringify({ message: 'Too many concurrent requests.' }));
    await operation.completed;
};
const finish = async (operations: Held[]) => {
    for (const operation of operations) operation.release();
    const results = await Promise.all(operations.map(operation => operation.result));
    for (const result of results) assert.equal(result.status, 200);
    await Promise.all(operations.map(operation => operation.completed));
};

test('held room reads leave two per-client slots for explicit commands without exceeding the total pool', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const fixture = await listen(t);
    const reads: Held[] = [];
    for (let index = 0; index < 4; index++) reads.push(await hold(fixture));
    await refusal(fixture.send());
    await refusal(fixture.send('/rooms/current', { method: 'HEAD' }), true);
    assert.deepEqual(fixture.calls, Array(4).fill('read'));
    const commands = [await hold(fixture, { method: 'POST' }), await hold(fixture, { method: 'POST' })];
    await refusal(fixture.send('/room-commands', { method: 'POST' }));
    assert.equal(fixture.active, 6);
    assert.equal(fixture.calls.filter(value => value === 'command').length, 2);
    await finish([...reads, ...commands]);
    assert.equal(fixture.maximumActive, 6);
    assert.equal(JSON.parse((await commands[0].result).body).outcome, 'applied');
});

test('HEAD work shares the room read ceiling and releases it only after service completion', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const fixture = await listen(t);
    const heads: Held[] = [];
    for (let index = 0; index < 4; index++) heads.push(await hold(fixture, { method: 'HEAD' }));
    await refusal(fixture.send());
    const command = await hold(fixture, { method: 'POST' });
    await finish([heads[0]]);
    assert.equal((await heads[0].result).body, '');
    const replacement = await hold(fixture);
    await finish([...heads.slice(1), command, replacement]);
    assert.equal(fixture.maximumActive, 5);
});

test('a disconnected read retains both reservations until its admitted service work settles', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const fixture = await listen(t);
    const reads: Held[] = [];
    for (let index = 0; index < 4; index++) reads.push(await hold(fixture));
    const commands = [await hold(fixture, { method: 'POST' }), await hold(fixture, { method: 'POST' })];
    reads[0].abort(); await reads[0].closed;
    assert.equal((await reads[0].result).status, 0);
    await refusal(fixture.send());
    await refusal(fixture.send('/room-commands', { method: 'POST' }));
    assert.equal(fixture.calls.length, 6);
    assert.equal(fixture.active, 6);
    reads[0].release(); await reads[0].completed;
    const replacement = await hold(fixture);
    assert.equal(fixture.active, 6);
    await finish([...reads.slice(1), ...commands, replacement]);
    assert.equal(fixture.maximumActive, 6);
});

test('six simultaneous per-client mutations remain bounded and total refusals cannot leak read reservations', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const fixture = await listen(t);
    const commands: Held[] = [];
    for (let index = 0; index < 6; index++) commands.push(await hold(fixture, { method: 'POST' }));
    await refusal(fixture.send('/room-commands', { method: 'POST' }));
    for (let index = 0; index < 5; index++) await refusal(fixture.send());
    assert.deepEqual(fixture.calls, Array(6).fill('command'));
    await finish(commands);
    const reads: Held[] = [];
    for (let index = 0; index < 4; index++) reads.push(await hold(fixture));
    await refusal(fixture.send());
    await finish(reads);
    assert.equal(fixture.maximumActive, 6);
});

test('distinct trusted-proxy clients leave eight global command slots beneath the unchanged total ceiling', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const fixture = await listen(t);
    const reads: Held[] = [];
    for (let client = 1; client <= 10; client++) for (let index = 0; index < 4; index++) {
        reads.push(await hold(fixture, { ip: `198.51.100.${client}` }));
    }
    await refusal(fixture.send('/rooms/current', { ip: '198.51.100.20' }));
    const commands: Held[] = [];
    for (let client = 21; client <= 22; client++) for (let index = 0; index < 4; index++) {
        commands.push(await hold(fixture, { method: 'POST', ip: `198.51.100.${client}` }));
    }
    await refusal(fixture.send('/room-commands', { method: 'POST', ip: '198.51.100.23' }));
    assert.equal(fixture.active, 48);
    assert.equal(fixture.calls.filter(value => value === 'command').length, 8);
    await finish([...reads, ...commands]);
    assert.equal(fixture.maximumActive, 48);
});

test('48 simultaneous mutations stay bounded globally and rejected mixed reads leave no smaller-pool leak', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const fixture = await listen(t);
    const commands: Held[] = [];
    for (let client = 1; client <= 8; client++) for (let index = 0; index < 6; index++) {
        commands.push(await hold(fixture, { method: 'POST', ip: `192.0.2.${client}` }));
    }
    await refusal(fixture.send('/room-commands', { method: 'POST', ip: '192.0.2.20' }));
    for (let index = 0; index < 5; index++) await refusal(fixture.send('/rooms/current', { ip: '192.0.2.20' }));
    assert.deepEqual(fixture.calls, Array(48).fill('command'));
    await finish(commands);
    const reads: Held[] = [];
    for (let client = 21; client <= 30; client++) for (let index = 0; index < 4; index++) {
        reads.push(await hold(fixture, { ip: `192.0.2.${client}` }));
    }
    await refusal(fixture.send('/rooms/current', { ip: '192.0.2.31' }));
    await finish(reads);
    assert.equal(fixture.maximumActive, 48);
});

test('room read reservations remain shared across actual router instances', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const first = await listen(t), second = await listen(t);
    const operations = [await hold(first), await hold(first), await hold(second), await hold(second)];
    await refusal(second.send());
    assert.equal(first.calls.length + second.calls.length, 4);
    const commands = [await hold(first, { method: 'POST' }), await hold(second, { method: 'POST' })];
    await refusal(first.send('/room-commands', { method: 'POST' }));
    await finish([...operations, ...commands]);
});

test('auth, viewer, query, content-type and JSON bounds still reject before service work under read pressure', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const fixture = await listen(t);
    const reads: Held[] = [];
    for (let index = 0; index < 4; index++) reads.push(await hold(fixture));
    const probes = [
        [fixture.send('/rooms/current', { authenticate: false }), 401],
        [fixture.send('/rooms/current', { headers: { Authorization: '', 'X-Finitude-Account-Viewer': 'other-account' } }), 409],
        [fixture.send('/rooms/current?unrecognized=1'), 400],
        [fixture.send('/room-commands', { method: 'POST', headers: { 'Content-Type': 'text/plain' } }), 415]
    ] as const;
    for (const [operation, status] of probes) {
        assert.equal((await operation.result).status, status);
        await operation.completed;
    }
    for (const [body, status] of [['scalar JSON', 400], [{}, 400],
        [{ padding: 'x'.repeat(ROOM_LIMITS.commandBytes) }, 413]] as const) {
        const operation = fixture.send('/room-commands', { method: 'POST', body });
        assert.equal((await operation.result).status, status);
        await operation.completed;
    }
    assert.deepEqual(fixture.calls, Array(4).fill('read'));
    await finish(reads);
});

test('the existing 180-request room window still covers reads and explicit commands together', { timeout: 10_000 }, async t => {
    resetRateLimitWindowsForTests();
    const fixture = await listen(t);
    for (let index = 0; index < 180; index++) {
        const operation = fixture.send('/capabilities');
        const response = await operation.result;
        assert.equal(response.status, 200);
        assert.equal(response.headers['ratelimit-limit'], '180');
        assert.equal(response.headers['ratelimit-remaining'], String(179 - index));
        await operation.completed;
    }
    const response = await fixture.send('/room-commands', { method: 'POST' }).result;
    assert.equal(response.status, 429);
    assert.equal(response.headers['ratelimit-remaining'], '0');
    assert.ok(Number(response.headers['retry-after']) > 0);
    assert.deepEqual(JSON.parse(response.body), { message: 'Too many requests. Please try again later.' });
    assert.deepEqual(fixture.calls, []);
});
