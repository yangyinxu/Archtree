import { advanceAccountEpoch } from '../../api/accountEpoch';
import type { ListeningReport, OwnListeningState } from '../../api/listening';
import { createListeningSession, type ListeningSample } from './listeningSession';
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const sample = (observedAtMs = 0, extras: Partial<ListeningSample> = {}): ListeningSample => ({ intentId: 1, sourceId: 'source-000000001', occurrenceId: 'occurrence-000001', mediaTrackId: 'a'.repeat(24), positionMs: 1000, observedAtMs, room: null, ...extras });
const setup = (enabled = true) => {
  let mono = 0; let owner: OwnListeningState = { enabled, revision: enabled ? 1 : 0, publisherRevision: 0, serverTimeMs: 100_000 };
  let count = 0;
  const read = vi.fn(async () => ({ listening: { ...owner, serverTimeMs: 100_000 + mono }, receivedAtMs: mono }));
  const prepare = vi.fn(async (_viewer, action) => ({ ...action, commandId: `command-number-${++count}`, scopeToken: 'signed-scope-token' }));
  const send = vi.fn(async (_viewer, command) => {
    if (command.action === 'claimListening') owner.publisherRevision++;
    else if (command.action === 'setListeningSharing') { owner.enabled = command.enabled; owner.revision++; if (!command.enabled) owner.publisherRevision++; }
    return { commandId: command.commandId, outcome: 'applied' as const, replayed: false };
  });
  const report = vi.fn(async (_viewer: string, input: ListeningReport) => ({ accepted: true, serverTimeMs: 100_000 + mono,
    expiresAtMs: input.state === 'playing' ? input.observedAtMs + 25_000 : null }));
  const outcome = vi.fn(async () => ({ outcome: null }));
  const session = createListeningSession({ now: () => mono, read, prepare, send, report, outcome });
  let intent = 0; session.ensure('alice', 'client-document-01', () => session.observe({ type: 'intent', intentId: ++intent }));
  return { session, read, prepare, send, report, outcome, owner, time: (value: number) => { mono = value; } };
};
beforeEach(() => { vi.useFakeTimers(); advanceAccountEpoch(); });
afterEach(() => vi.useRealTimers());

test('default off, owner reads and progress alone never claim or publish', async () => {
  const f = setup(false); await flush(); f.session.observe({ type: 'intent', intentId: 1 }); await flush();
  expect(f.read).toHaveBeenCalledTimes(1);
  f.session.observe({ type: 'playing', sample: sample() });
  await vi.advanceTimersByTimeAsync(30_000); expect(f.send).not.toHaveBeenCalled(); expect(f.report).not.toHaveBeenCalled(); f.session.reset();
});
test('confirmed explicit opt-in claims once but requires actual playing before exposing anything', async () => {
  const f = setup(false); await flush(); await f.session.setEnabled(true); await flush();
  expect(f.send.mock.calls.map(call => call[1].action)).toEqual(['setListeningSharing', 'claimListening']); expect(f.report).not.toHaveBeenCalled();
  f.session.observe({ type: 'playing', sample: sample() }); await flush();
  expect(f.report).toHaveBeenCalledTimes(1); expect(f.report.mock.calls[0][1]).toMatchObject({ publicationId: 'command-number-2', sequence: 1, observedAtMs: 100_000 }); f.session.reset();
});
test('only fresh advancing observations renew after10s, using monotonic server time despite wall clock drift', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush(); f.session.observe({ type: 'playing', sample: sample() }); await flush();
  vi.setSystemTime(new Date('2050-01-01')); f.time(9000); f.session.observe({ type: 'progress', sample: sample(9000, { positionMs: 10_000 }) });
  f.time(10_000); f.session.observe({ type: 'progress', sample: sample(10_000, { positionMs: 1000 }) }); await flush(); expect(f.report).toHaveBeenCalledTimes(1);
  f.session.observe({ type: 'progress', sample: sample(10_000, { positionMs: 11_000 }) }); await flush();
  expect(f.report.mock.calls[1][1]).toMatchObject({ sequence: 2, observedAtMs: 110_000 });
  f.time(20_000); f.session.observe({ type: 'progress', sample: sample(10_000, { positionMs: 21_000 }) }); await flush(); expect(f.report).toHaveBeenCalledTimes(2); f.session.reset();
});
test('a delayed owner poll cannot age fresh playback or require a new publishing gesture', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush();
  f.session.observe({ type: 'playing', sample: sample() }); await flush();
  const held = deferred<Awaited<ReturnType<typeof f.read>>>();
  const observedOwner = { ...f.owner, serverTimeMs: 100_000 };
  f.read.mockReturnValueOnce(held.promise); const pending = f.session.refresh();
  f.time(10_000); held.resolve({ listening: observedOwner, receivedAtMs: 10_000 }); await pending;
  f.report.mockImplementationOnce(async (_viewer, input) => ({
    // Mirror the server's freshness check, instead of accepting every observation.
    accepted: input.state === 'playing' && input.observedAtMs >= 105_000 && input.observedAtMs <= 112_000,
    serverTimeMs: 110_000, expiresAtMs: input.state === 'playing' ? input.observedAtMs + 25_000 : null
  }));
  f.session.observe({ type: 'progress', sample: sample(10_000, { positionMs: 11_000 }) }); await flush();
  expect(f.report.mock.calls[1][1]).toMatchObject({ observedAtMs: 110_000 });
  expect(f.session.getSnapshot()).toMatchObject({ owned: true, publishing: true, error: null });
  expect(f.send).toHaveBeenCalledTimes(1); f.session.reset();
});
test.each(['opt-out', 'takeover'])('delayed clock data still applies a confirmed %s', async change => {
  const f = setup(); await flush(); f.session.useDevice(); await flush();
  const held = deferred<Awaited<ReturnType<typeof f.read>>>();
  f.read.mockReturnValueOnce(held.promise); const pending = f.session.refresh(); f.time(10_000);
  const listening = { ...f.owner, serverTimeMs: 100_000,
    ...(change === 'opt-out' ? { enabled: false, revision: 2 } : { publisherRevision: 2 }) };
  held.resolve({ listening, receivedAtMs: 10_000 }); await pending;
  expect(f.session.getClock('alice')?.server).toBe(110_000);
  expect(f.session.getSnapshot()).toMatchObject({ own: listening, owned: false, publishing: false });
  f.session.observe({ type: 'progress', sample: sample(10_000) }); await flush();
  expect(f.report).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(1); f.session.reset();
});
test('a forward clock correction shortens the existing lease timer without renewing it', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush();
  f.read.mockResolvedValueOnce({ listening: { ...f.owner, serverTimeMs: 124_000 }, receivedAtMs: 0 });
  await f.session.refresh(); expect(f.session.getSnapshot().owned).toBe(true);
  f.time(1000); await vi.advanceTimersByTimeAsync(1000);
  expect(f.session.getSnapshot().owned).toBe(false); expect(f.report).not.toHaveBeenCalled(); f.session.reset();
});
test('a resumed owner read expires the lease even if the local monotonic clock stopped during sleep', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush();
  f.read.mockResolvedValueOnce({ listening: { ...f.owner, serverTimeMs: 130_000 }, receivedAtMs: 0 });
  await f.session.refresh(); expect(f.session.getSnapshot().owned).toBe(false);
  f.session.observe({ type: 'playing', sample: sample() }); await flush();
  expect(f.report).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(1); f.session.reset();
});
test('an account reset discards the previous account clock estimate', async () => {
  const f = setup(); await flush(); f.time(10_000);
  advanceAccountEpoch(); f.session.reset();
  f.read.mockResolvedValueOnce({ listening: { ...f.owner, serverTimeMs: 90_000 }, receivedAtMs: 10_000 });
  f.session.ensure('bob', 'client-document-01'); await flush();
  expect(f.session.getClock('alice')).toBeNull(); expect(f.session.getClock('bob')?.server).toBe(90_000); f.session.reset();
});
test('captured stop is immediate despite a stalled playing response and cannot stop a replacement occurrence', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush();
  const held = deferred<{ accepted: boolean; serverTimeMs: number; expiresAtMs: number | null }>(); f.report.mockReturnValueOnce(held.promise);
  f.session.observe({ type: 'playing', sample: sample() }); await flush(); f.session.observe({ type: 'stopped', occurrenceId: sample().occurrenceId }); await flush();
  expect(f.report).toHaveBeenCalledTimes(2); held.resolve({ accepted: true, serverTimeMs: 100_000, expiresAtMs: 125_000 }); await flush();
  expect(f.report.mock.calls[1][1]).toMatchObject({ state: 'stopped', sequence: 2, playbackSequence: 1, occurrenceId: sample().occurrenceId });
  f.session.observe({ type: 'playing', sample: sample(0, { occurrenceId: 'occurrence-000002' }) }); await flush();
  f.session.observe({ type: 'stopped', occurrenceId: sample().occurrenceId }); await flush(); expect(f.report).toHaveBeenCalledTimes(3); f.session.reset();
});
test('expired or rejected ownership never reclaims from progress; a fresh explicit gesture uses current CAS revision', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush(); f.owner.publisherRevision = 4;
  f.report.mockResolvedValueOnce({ accepted: false, serverTimeMs: 100_000, expiresAtMs: null });
  f.session.observe({ type: 'playing', sample: sample() }); await flush();
  f.session.observe({ type: 'progress', sample: sample(0, { positionMs: 2000 }) }); await flush(); expect(f.send).toHaveBeenCalledTimes(1);
  f.session.useDevice(); await flush(); expect(f.send.mock.calls[1][1]).toMatchObject({ action: 'claimListening', expectedPublisherRevision: 4 }); f.session.reset();
});
test('explicit gesture discovers another device before local polling and claims the observed replacement', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush(); f.owner.publisherRevision = 3;
  f.session.useDevice(); await flush(); expect(f.send.mock.calls[1][1]).toMatchObject({ expectedPublisherRevision: 3 }); f.session.reset();
});
test('failed fresh owner read prevents claim even when cached preference was enabled', async () => {
  const f = setup(); await flush(); f.read.mockRejectedValueOnce(new Error('offline')); f.session.useDevice(); await flush();
  expect(f.send).not.toHaveBeenCalled(); f.session.reset();
});
test('same-owner explicit gesture validates ownership but avoids another receipt', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush(); const reads = f.read.mock.calls.length;
  f.session.useDevice(); await flush(); expect(f.read.mock.calls.length).toBeGreaterThan(reads); expect(f.send).toHaveBeenCalledTimes(1); f.session.reset();
});
test('unknown preference survives pause and ensure, off stops locally without pretending durable success', async () => {
  const f = setup(); await flush(); f.send.mockRejectedValueOnce(new TypeError('unknown'));
  await f.session.setEnabled(false); const original = f.session.getSnapshot().uncertain;
  expect(original?.action).toBe('setListeningSharing'); expect(f.session.getSnapshot().own?.enabled).toBe(true);
  f.session.pause(); f.session.ensure('alice', 'client-document-01'); await f.session.setEnabled(true);
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.session.getSnapshot().uncertain).toBe(original);
  await f.session.retry(); expect(f.send.mock.calls[1][1]).toBe(original); f.session.reset();
});
test('account switch fences delayed scope, report response and private preference', async () => {
  const f = setup(); await flush(); const held = deferred<any>(); f.prepare.mockReturnValueOnce(held.promise); f.session.useDevice(); await flush();
  advanceAccountEpoch(); f.session.ensure('bob', 'client-document-01'); held.resolve({ action: 'claimListening', commandId: 'old-command-001', scopeToken: 'oldscope', clientId: 'client-document-01', expectedPreferenceRevision: 1, expectedPublisherRevision: 0 }); await flush();
  expect(f.send).not.toHaveBeenCalled(); expect(f.session.getSnapshot().viewerId).toBe('bob'); f.session.reset();
});
test('detach sends captured stop, retires local lease and remount progress cannot automatically take over', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush(); f.session.observe({ type: 'playing', sample: sample() }); await flush();
  f.session.pause(); await flush(); expect(f.report.mock.calls[1][1]).toMatchObject({ state: 'stopped' });
  f.session.ensure('alice', 'client-document-01'); f.session.observe({ type: 'playing', sample: sample() }); await flush();
  expect(f.report).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledTimes(1); expect(f.session.getSnapshot().owned).toBe(false); f.session.reset();
});

test('fresh actual playback captured during the claim settles only for that original intent', async () => {
  const f = setup(); await flush(); const held = deferred<any>(); f.send.mockReturnValueOnce(held.promise);
  f.session.useDevice(); await flush(); f.session.observe({ type: 'playing', sample: sample() }); expect(f.report).not.toHaveBeenCalled();
  f.owner.publisherRevision = 1; held.resolve({ commandId: 'command-number-1', outcome: 'applied', replayed: false }); await flush();
  expect(f.report).toHaveBeenCalledTimes(1); f.session.reset();
});
test('stopping while claim is pending erases the observation so confirmed ownership remains private', async () => {
  const f = setup(); await flush(); const held = deferred<any>(); f.send.mockReturnValueOnce(held.promise);
  f.session.useDevice(); await flush(); f.session.observe({ type: 'playing', sample: sample() }); f.session.observe({ type: 'stopped', occurrenceId: sample().occurrenceId });
  f.owner.publisherRevision = 1; held.resolve({ commandId: 'command-number-1', outcome: 'applied', replayed: false }); await flush();
  expect(f.report).not.toHaveBeenCalled(); f.session.reset();
});
test('unknown claim is retained without automatic retry and its late outcome cannot resurrect an expired lease', async () => {
  const f = setup(); await flush(); f.send.mockRejectedValueOnce(new TypeError('lost response')); f.session.useDevice(); await flush();
  const original = f.session.getSnapshot().uncertain!; f.owner.publisherRevision = 1;
  f.time(26_000); await vi.advanceTimersByTimeAsync(26_000); f.session.observe({ type: 'progress', sample: sample(26_000) }); await flush();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.session.getSnapshot().uncertain).toBe(original);
  f.outcome.mockResolvedValueOnce({ outcome: { commandId: original.commandId, outcome: 'applied', replayed: true } } as any);
  await f.session.check(); expect(f.session.getSnapshot().owned).toBe(false); expect(f.report).not.toHaveBeenCalled(); f.session.reset();
});
test('early accepted renewal keeps the original server expiry and timers never send reports', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush();
  f.session.observe({ type: 'playing', sample: sample() }); await flush();
  f.time(10_000); f.report.mockResolvedValueOnce({ accepted: true, serverTimeMs: 110_000, expiresAtMs: 125_000 });
  f.session.observe({ type: 'progress', sample: sample(10_000, { positionMs: 12_000 }) }); await flush();
  f.time(25_001); await vi.advanceTimersByTimeAsync(25_001); expect(f.session.getSnapshot().owned).toBe(false);
  expect(f.report).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledTimes(1); f.session.reset();
});
test('unmatched room observations stop publication instead of falling back to ordinary Audio', async () => {
  const f = setup(); await flush(); f.session.useDevice(); await flush(); f.session.observe({ type: 'playing', sample: sample() }); await flush();
  f.session.observe({ type: 'playing', sample: sample(0, { room: { roomId: 'room-a', epoch: 1, playbackEpoch: 1, entryId: 'entry-a', mediaRevision: 'revision-a' } }) }); await flush();
  expect(f.report.mock.calls[1][1]).toMatchObject({ state: 'stopped', playbackSequence: 1 }); expect(f.session.getSnapshot().publishing).toBe(false); f.session.reset();
});

test.each(['read', 'scope'])('detach during pending %s prevents a claim from taking ownership', async boundary => {
  const f = setup(); await flush(); const held = deferred<any>();
  if (boundary === 'read') f.read.mockReturnValueOnce(held.promise); else f.prepare.mockReturnValueOnce(held.promise);
  f.session.useDevice(); await flush(); f.session.pause(); f.session.ensure('alice', 'client-document-01');
  held.resolve(boundary === 'read' ? { listening: f.owner, receivedAtMs: 0 } : { action: 'claimListening', commandId: 'detached-claim-01', scopeToken: 'scope', clientId: 'client-document-01', expectedPreferenceRevision: 1, expectedPublisherRevision: 0 });
  await flush(); expect(f.send).not.toHaveBeenCalled(); expect(f.session.getSnapshot().owned).toBe(false); f.session.reset();
});
test('claim acknowledged after detach settles its receipt but cannot install ownership on the replacement observer', async () => {
  const f = setup(); await flush(); const held = deferred<any>(); f.send.mockReturnValueOnce(held.promise); f.session.useDevice(); await flush();
  f.session.pause(); f.session.ensure('alice', 'client-document-01'); f.owner.publisherRevision = 1;
  held.resolve({ commandId: 'command-number-1', outcome: 'applied', replayed: false }); await flush();
  f.session.observe({ type: 'playing', sample: sample() }); await flush();
  expect(f.session.getSnapshot()).toMatchObject({ busy: false, owned: false, uncertain: null }); expect(f.report).not.toHaveBeenCalled(); f.session.reset();
});

test('explicit unknown claim retry after remount keeps the same receipt identity without reinstalling old ownership', async () => {
  const f = setup(); await flush(); f.send.mockRejectedValueOnce(new TypeError('unknown')); f.session.useDevice(); await flush();
  const original = f.session.getSnapshot().uncertain!; expect(original.action).toBe('claimListening');
  f.session.pause(); f.session.ensure('alice', 'client-document-01'); await flush(); await f.session.retry();
  expect(f.send).toHaveBeenCalledTimes(2); expect(f.send.mock.calls[1][1]).toBe(original); expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.session.getSnapshot()).toMatchObject({ uncertain: null, owned: false });
  f.session.observe({ type: 'playing', sample: sample() }); await flush(); expect(f.report).not.toHaveBeenCalled(); f.session.reset();
});

test('claim settlement issues a fresh owner read after a delayed pre-commit poll', async () => {
  const f = setup(); await flush(); const write = deferred<any>(), oldRead = deferred<any>();
  f.send.mockReturnValueOnce(write.promise); f.session.useDevice(); await flush();
  f.read.mockReturnValueOnce(oldRead.promise); void f.session.refresh(); await flush();
  f.owner.publisherRevision = 1; write.resolve({ commandId: 'command-number-1', outcome: 'applied', replayed: false }); await flush();
  const before = f.read.mock.calls.length;
  oldRead.resolve({ listening: { ...f.owner, publisherRevision: 0 }, receivedAtMs: 0 }); await flush();
  expect(f.read.mock.calls.length).toBeGreaterThan(before); expect(f.session.getSnapshot()).toMatchObject({ owned: true, uncertain: null });
  f.session.observe({ type: 'playing', sample: sample() }); await flush(); expect(f.report).toHaveBeenCalledTimes(1); f.session.reset();
});
