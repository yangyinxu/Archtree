import type { ListenerTelemetryBatch, ListenerTelemetryEvent } from './contracts';

const endpoint = '/api/listener/v1/telemetry';
const maximumQueuedEvents = 20;
const maximumBatchEvents = 10;
const flushDelayMilliseconds = 12_000;

let queue: ListenerTelemetryEvent[] = [];
let queuedSignatures = new Set<string>();
let flushTimer: number | undefined;
let lifecycleStarted = false;

const signatureFor = (event: ListenerTelemetryEvent) => JSON.stringify(event);

const scheduleFlush = () => {
  if (flushTimer !== undefined || typeof window === 'undefined') return;
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    flushListenerTelemetry();
  }, flushDelayMilliseconds);
};

/** Queues only bounded anonymous dimensions and deduplicates StrictMode repeats. */
export const enqueueListenerTelemetry = (event: ListenerTelemetryEvent) => {
  const signature = signatureFor(event);
  if (queuedSignatures.has(signature) || queue.length >= maximumQueuedEvents) return;
  queue.push(event);
  queuedSignatures.add(signature);
  scheduleFlush();
};

/** Sends at most ten events without cookies, persistence, retries, or recursive reporting. */
export const flushListenerTelemetry = () => {
  if (typeof fetch !== 'function' || queue.length === 0) return;
  const events = queue.splice(0, maximumBatchEvents);
  events.forEach((event) => queuedSignatures.delete(signatureFor(event)));
  const body: ListenerTelemetryBatch = { events };
  void fetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true
  }).catch(() => undefined);
  if (queue.length > 0) scheduleFlush();
};

const flushAllListenerTelemetry = () => {
  if (typeof fetch !== 'function') return;
  if (flushTimer !== undefined && typeof window !== 'undefined') {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  // The queue is capped at twenty and the server accepts at most ten per envelope.
  for (let batch = 0; batch < 2 && queue.length > 0; batch += 1) {
    flushListenerTelemetry();
  }
  if (flushTimer !== undefined && typeof window !== 'undefined') {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
};

/** Flushes once when the page is backgrounded without creating a persistent visitor ID. */
export const startListenerTelemetryLifecycle = () => {
  if (lifecycleStarted || typeof window === 'undefined') return;
  lifecycleStarted = true;
  window.addEventListener('pagehide', flushAllListenerTelemetry);
};

/** Resets module state only for deterministic unit tests. */
export const resetListenerTelemetryForTests = () => {
  if (flushTimer !== undefined && typeof window !== 'undefined') {
    window.clearTimeout(flushTimer);
  }
  if (lifecycleStarted && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', flushAllListenerTelemetry);
  }
  queue = [];
  queuedSignatures = new Set();
  flushTimer = undefined;
  lifecycleStarted = false;
};
