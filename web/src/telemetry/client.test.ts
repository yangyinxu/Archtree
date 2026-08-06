import {
  enqueueListenerTelemetry,
  flushListenerTelemetry,
  resetListenerTelemetryForTests,
  startListenerTelemetryLifecycle
} from './client';

const vital = (value: number) => ({
  category: 'web_vital' as const,
  metric: 'LCP' as const,
  value,
  route: 'home' as const,
  navigationType: 'navigate' as const
});

beforeEach(() => {
  vi.useFakeTimers();
  resetListenerTelemetryForTests();
});

afterEach(() => {
  resetListenerTelemetryForTests();
  vi.useRealTimers();
});

test('deduplicates events and sends an anonymous same-origin-free envelope', () => {
  const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchSpy);
  enqueueListenerTelemetry(vital(1200));
  enqueueListenerTelemetry(vital(1200));

  flushListenerTelemetry();

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(path).toBe('/api/listener/v1/telemetry');
  expect(init).toMatchObject({
    method: 'POST',
    credentials: 'omit',
    keepalive: true
  });
  expect(JSON.parse(String(init.body))).toEqual({ events: [vital(1200)] });
});

test('caps envelopes at ten while pagehide drains the bounded twenty-event queue', () => {
  const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchSpy);
  startListenerTelemetryLifecycle();
  for (let value = 1; value <= 25; value += 1) enqueueListenerTelemetry(vital(value));

  window.dispatchEvent(new Event('pagehide'));

  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(fetchSpy.mock.calls.map(([, init]) =>
    JSON.parse(String((init as RequestInit).body)).events.length
  )).toEqual([10, 10]);
});

test('drops delivery failures without retrying or recursively reporting them', async () => {
  const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchSpy);
  enqueueListenerTelemetry(vital(800));

  flushListenerTelemetry();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
